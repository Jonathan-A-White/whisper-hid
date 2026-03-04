#!/data/data/com.termux/files/usr/bin/python3
"""Whisper HTTP API server — wraps whisper.cpp with Flask.

Endpoints:
  POST /transcribe        — One-shot: accept audio bytes, return transcription
  POST /transcribe/start  — PTT: start mic recording
  POST /transcribe/stop   — PTT: stop recording, transcribe, return text
  GET  /status            — Server health and loaded model
  GET  /logs              — Recent log entries (circular buffer, 200 max)
  GET  /models            — List available models on disk
  PUT  /model             — Switch the active model
  POST /models/benchmark  — Benchmark models against a test audio clip
"""

import atexit
import json
import os
import re
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

from flask import Flask, Response, jsonify, request

app = Flask(__name__)

SERVER_VERSION = "1.1.0"

# --- Configuration ---

INSTALL_DIR = os.environ.get("WHISPER_INSTALL_DIR", os.path.expanduser("~/whisper-stt"))
MODEL_DIR = os.path.join(INSTALL_DIR, "models")
DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "ggml-base.en.bin")
WHISPER_BIN = os.environ.get("WHISPER_BIN", "")
ALLOWED_ORIGIN = os.environ.get(
    "CORS_ORIGIN", "https://jonathan-a-white.github.io"
)
PORT = int(os.environ.get("WHISPER_PORT", "9876"))
WHISPER_SERVER_PORT = int(os.environ.get("WHISPER_SERVER_PORT", "9878"))
NOISE_REDUCTION = os.environ.get("WHISPER_NOISE_REDUCTION", "0").lower() in ("1", "true", "yes")

# --- Runtime settings (mutable via /settings API) ---

runtime_settings: dict[str, bool | int | str] = {}


def _init_runtime_settings():
    """Initialize runtime settings from environment/defaults."""
    global runtime_settings
    runtime_settings = {
        "noise_reduction": NOISE_REDUCTION,
    }


def get_noise_reduction() -> bool:
    """Return current noise reduction setting."""
    return bool(runtime_settings.get("noise_reduction", NOISE_REDUCTION))

# --- State ---

model_path = ""
model_name = ""
model_size_mb = 0
model_loaded = False
recording_process = None
recording_file = None
recording_lock = threading.Lock()
transcribe_lock = threading.Lock()
log_buffer = deque(maxlen=200)
start_time = time.time()
audio_format = "aac"       # detected at startup: "aac" or "amr_wb"
audio_ext = "aac"          # file extension for recordings


CORRECTIONS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "word-corrections.json"
)
word_corrections: dict[str, str] = {}


def load_corrections():
    """Load word corrections from JSON file."""
    global word_corrections
    if not os.path.isfile(CORRECTIONS_FILE):
        word_corrections = {}
        return
    try:
        with open(CORRECTIONS_FILE, "r") as f:
            word_corrections = json.load(f)
    except (json.JSONDecodeError, OSError):
        word_corrections = {}


def save_corrections():
    """Save word corrections to JSON file."""
    try:
        with open(CORRECTIONS_FILE, "w") as f:
            json.dump(word_corrections, f, indent=2)
            f.write("\n")
    except OSError as e:
        add_log("error", f"Failed to save corrections: {e}")


def apply_corrections(text: str) -> str:
    """Apply word corrections to transcribed text.

    Does case-insensitive whole-word matching, replacing with the exact
    value from the corrections dictionary.
    """
    if not word_corrections:
        return text
    for wrong, right in word_corrections.items():
        pattern = re.compile(r'\b' + re.escape(wrong) + r'\b', re.IGNORECASE)
        text = pattern.sub(right, text)
    return text


def add_log(level: str, msg: str):
    log_buffer.append({"ts": int(time.time()), "level": level, "msg": msg})


def find_whisper_bin() -> str:
    """Locate the whisper.cpp binary."""
    candidates = [
        os.path.join(INSTALL_DIR, "whisper.cpp", "build", "bin", "whisper-cli"),
        os.path.join(INSTALL_DIR, "whisper.cpp", "build", "bin", "main"),
    ]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return ""


# --- Persistent whisper-server (model loaded once) ---

_whisper_server_proc: subprocess.Popen | None = None
_whisper_server_mode = False


def find_whisper_server_bin() -> str:
    """Locate the whisper.cpp HTTP server binary."""
    candidates = [
        os.path.join(INSTALL_DIR, "whisper.cpp", "build", "bin", "whisper-server"),
        os.path.join(INSTALL_DIR, "whisper.cpp", "build", "bin", "server"),
    ]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return ""


def _wait_for_whisper_server(timeout: int = 60) -> bool:
    """Wait for the whisper-server to accept connections.

    whisper-server binds to its port after loading the model, so a
    successful connection means the model is ready for inference.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _whisper_server_proc and _whisper_server_proc.poll() is not None:
            return False  # process exited
        try:
            s = socket.create_connection(("127.0.0.1", WHISPER_SERVER_PORT), timeout=1)
            s.close()
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.5)
    return False


def start_whisper_server(model_file: str) -> bool:
    """Start a persistent whisper-server process with the given model.

    Returns True if the server started successfully, False otherwise.
    On failure, transcription falls back to one-shot subprocess mode.
    """
    global _whisper_server_proc, _whisper_server_mode, _whisper_extra_flags

    server_bin = find_whisper_server_bin()
    if not server_bin:
        add_log("info", "whisper-server binary not found — using subprocess mode")
        return False

    if _whisper_extra_flags is None:
        _whisper_extra_flags = _detect_whisper_flags()

    cmd = [
        server_bin,
        "--model", model_file,
        "--host", "127.0.0.1",
        "--port", str(WHISPER_SERVER_PORT),
        "--language", "en",
    ]
    # Add compatible flags (detected from whisper-cli --help)
    for flag in (_whisper_extra_flags or []):
        cmd.append(flag)

    add_log("info", f"Starting whisper-server: {' '.join(cmd)}")

    try:
        _whisper_server_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, OSError) as e:
        add_log("error", f"Failed to start whisper-server: {e}")
        return False

    if _wait_for_whisper_server(timeout=60):
        _whisper_server_mode = True
        add_log("info", f"whisper-server ready on port {WHISPER_SERVER_PORT} (pid={_whisper_server_proc.pid})")
        return True

    add_log("error", "whisper-server failed to become ready within 60s — falling back to subprocess mode")
    stop_whisper_server()
    return False


def stop_whisper_server():
    """Stop the persistent whisper-server process."""
    global _whisper_server_proc, _whisper_server_mode

    if _whisper_server_proc is not None:
        add_log("info", f"Stopping whisper-server (pid={_whisper_server_proc.pid})")
        try:
            _whisper_server_proc.terminate()
            _whisper_server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _whisper_server_proc.kill()
            _whisper_server_proc.wait(timeout=3)
        except Exception:
            pass
        _whisper_server_proc = None

    _whisper_server_mode = False


def restart_whisper_server(model_file: str) -> bool:
    """Restart the whisper-server with a new model."""
    stop_whisper_server()
    return start_whisper_server(model_file)


def _is_whisper_server_alive() -> bool:
    """Check if the persistent whisper-server process is still running."""
    return (
        _whisper_server_mode
        and _whisper_server_proc is not None
        and _whisper_server_proc.poll() is None
    )


def _transcribe_via_server(wav_path: str) -> tuple[str, int]:
    """Send a WAV file to the persistent whisper-server for transcription.

    Returns (text, duration_ms).
    """
    boundary = f"whisper{int(time.time() * 1000)}"
    filename = os.path.basename(wav_path)

    with open(wav_path, "rb") as f:
        file_data = f.read()

    # Build multipart/form-data body
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
    body += b"Content-Type: audio/wav\r\n\r\n"
    body += file_data
    body += b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="response_format"\r\n\r\n'
    body += b"json\r\n"
    body += f"--{boundary}--\r\n".encode()

    url = f"http://127.0.0.1:{WHISPER_SERVER_PORT}/inference"
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")

    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    duration_ms = int((time.time() - t0) * 1000)

    text = result.get("text", "").strip()
    return text, duration_ms


atexit.register(stop_whisper_server)


# --- Mic recording helpers ---

# Path to termux-api binary (allows passing audio source via intent extras).
# Detected once at startup; falls back to termux-microphone-record wrapper.
_termux_api_bin: str | None = None


def _detect_termux_api_bin():
    """Find the termux-api binary so we can pass --ei source 7."""
    global _termux_api_bin
    prefix = os.environ.get("PREFIX", "/data/data/com.termux/files/usr")
    candidate = os.path.join(prefix, "libexec", "termux-api")
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        _termux_api_bin = candidate
        add_log("info", f"termux-api binary found: {candidate}")
    else:
        _termux_api_bin = None
        add_log("info", "termux-api binary not found, using termux-microphone-record wrapper")


def _mic_record_cmd(file: str, limit: int = 0, encoder: str | None = None,
                    bitrate: str | None = None) -> list[str]:
    """Build a mic recording command that routes through BT SCO when possible.

    If the termux-api binary is available, calls it directly with
    --ei source 7 (VOICE_COMMUNICATION) so that audio is captured from
    the Bluetooth headset mic.  Otherwise falls back to the
    termux-microphone-record wrapper (which uses AudioSource.MIC).
    """
    if _termux_api_bin:
        cmd = [
            _termux_api_bin, "MicRecorder",
            "--ei", "source", "7",     # VOICE_COMMUNICATION — routes through BT SCO
            "--es", "file", file,
            "--ei", "limit", str(limit),
        ]
        if encoder:
            cmd += ["--es", "encoder", encoder]
        if bitrate:
            cmd += ["--ei", "bitrate", bitrate]
        return cmd

    # Fallback: wrapper script (no audio source control)
    cmd = ["termux-microphone-record", "-f", file, "-l", str(limit)]
    if encoder:
        cmd += ["-e", encoder]
    if bitrate:
        cmd += ["-b", bitrate]
    return cmd


def detect_audio_format():
    """Detect whether AAC or AMR-WB recording works on this device.

    Try AAC first (default encoder), fall back to AMR-WB if ffmpeg
    can't convert the output.
    """
    global audio_format, audio_ext

    with tempfile.TemporaryDirectory() as td:
        # Try AAC first (termux-microphone-record default)
        test_raw = os.path.join(td, "test.aac")
        test_wav = os.path.join(td, "test.wav")
        try:
            subprocess.run(
                _mic_record_cmd(test_raw, limit=1),
                timeout=5,
            )
            time.sleep(2)
            subprocess.run(
                ["termux-microphone-record", "-q"], timeout=5,
            )
            time.sleep(0.5)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            add_log("warn", "termux-microphone-record not available, defaulting to AAC")
            return

        if os.path.isfile(test_raw) and os.path.getsize(test_raw) > 0:
            r = subprocess.run(
                ["ffmpeg", "-y", "-i", test_raw, "-ar", "16000", "-ac", "1",
                 "-c:a", "pcm_s16le", test_wav],
                capture_output=True, timeout=10,
            )
            if r.returncode == 0 and os.path.isfile(test_wav) and os.path.getsize(test_wav) > 0:
                audio_format = "aac"
                audio_ext = "aac"
                add_log("info", "Audio format: AAC (default)")
                return

        # AAC failed — try AMR-WB
        test_raw = os.path.join(td, "test.amr")
        test_wav = os.path.join(td, "test_amr.wav")
        try:
            subprocess.run(
                _mic_record_cmd(test_raw, limit=1, encoder="amr_wb", bitrate="23850"),
                timeout=5,
            )
            time.sleep(2)
            subprocess.run(
                ["termux-microphone-record", "-q"], timeout=5,
            )
            time.sleep(0.5)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

        if os.path.isfile(test_raw) and os.path.getsize(test_raw) > 0:
            r = subprocess.run(
                ["ffmpeg", "-y", "-i", test_raw, "-ar", "16000", "-ac", "1",
                 "-c:a", "pcm_s16le", test_wav],
                capture_output=True, timeout=10,
            )
            if r.returncode == 0 and os.path.isfile(test_wav) and os.path.getsize(test_wav) > 0:
                audio_format = "amr_wb"
                audio_ext = "amr"
                add_log("info", "Audio format: AMR-WB (fallback)")
                return

    add_log("warn", "Could not detect audio format, defaulting to AAC")


def load_model():
    """Load (validate) the whisper model at startup."""
    global model_path, model_name, model_size_mb, model_loaded

    model_file = os.path.join(MODEL_DIR, DEFAULT_MODEL)
    if not os.path.isfile(model_file):
        add_log("error", f"Model not found: {model_file}")
        model_loaded = False
        return

    model_path = model_file
    model_name = DEFAULT_MODEL.replace("ggml-", "").replace(".bin", "")
    model_size_mb = round(os.path.getsize(model_file) / (1024 * 1024))
    model_loaded = True
    add_log("info", f"Model loaded: {model_name} ({model_size_mb} MB)")


def transcode_to_wav(input_path: str, output_path: str) -> bool:
    """Transcode any audio format to 16kHz mono WAV using ffmpeg.

    When WHISPER_NOISE_REDUCTION=1 is set, applies FFT-based noise reduction
    (afftdn) before transcoding. This helps with noisy environments but adds
    ~100-200ms of processing time.
    """
    input_size = os.path.getsize(input_path) if os.path.isfile(input_path) else 0
    denoise = get_noise_reduction()
    add_log("info", f"Transcode: input={input_path} size={input_size}B denoise={denoise}")
    try:
        cmd = ["ffmpeg", "-y", "-i", input_path]
        if denoise:
            cmd += ["-af", "afftdn=nr=20:nf=-20:tn=1"]
        cmd += ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output_path]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            add_log("warn", f"ffmpeg exited {result.returncode}: {result.stderr[-300:]}")
            return False
        out_size = os.path.getsize(output_path) if os.path.isfile(output_path) else 0
        # Extract duration from ffmpeg stderr (e.g. "Duration: 00:00:06.12")
        duration_line = ""
        for line in result.stderr.splitlines():
            if "Duration:" in line:
                duration_line = line.strip()
                break
        add_log("info", f"Transcode: output={out_size}B {duration_line}")
        if out_size < 1000:
            add_log("warn", f"WAV too small after transcode ({out_size}B) — likely silence or corrupt input")
            return False
        return True
    except subprocess.TimeoutExpired:
        add_log("error", "ffmpeg timed out (30s)")
        return False
    except FileNotFoundError:
        add_log("error", "ffmpeg binary not found")
        return False


def _detect_whisper_flags() -> list[str]:
    """Probe whisper-cli --help to find supported flags (run once)."""
    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if not whisper_bin:
        return []
    try:
        r = subprocess.run([whisper_bin, "--help"], capture_output=True, text=True, timeout=10)
        help_text = r.stdout + r.stderr
    except Exception:
        return []

    flags: list[str] = []
    if "--no-gpu" in help_text:
        flags.append("-ng")
    if "--no-timestamps" in help_text:
        flags.append("--no-timestamps")
    if "--no-flash-attn" in help_text:
        flags.append("-nfa")
    if "--no-context" in help_text:
        flags.append("--no-context")

    add_log("info", f"Whisper detected flags: {' '.join(flags)}")
    return flags


# VAD model path — Silero VAD is optional, improves accuracy by skipping silence.
VAD_MODEL_DIR = os.path.join(INSTALL_DIR, "models")
VAD_MODEL_FILE = "silero-v5.1.2.ggml.bin"
_vad_available: bool | None = None


def _detect_vad_support() -> bool:
    """Check if whisper-cli supports --vad and the VAD model is present."""
    global _vad_available
    if _vad_available is not None:
        return _vad_available

    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if not whisper_bin:
        _vad_available = False
        return False

    try:
        r = subprocess.run([whisper_bin, "--help"], capture_output=True, text=True, timeout=10)
        help_text = r.stdout + r.stderr
    except Exception:
        _vad_available = False
        return False

    has_flag = "--vad-model" in help_text
    vad_path = os.path.join(VAD_MODEL_DIR, VAD_MODEL_FILE)
    has_model = os.path.isfile(vad_path)

    _vad_available = has_flag and has_model
    add_log("info", f"VAD support: flag={'yes' if has_flag else 'no'} model={'yes' if has_model else 'no'} -> {'enabled' if _vad_available else 'disabled'}")
    return _vad_available


def _get_vad_flags() -> list[str]:
    """Return VAD-related CLI flags if available."""
    if not _detect_vad_support():
        return []
    vad_path = os.path.join(VAD_MODEL_DIR, VAD_MODEL_FILE)
    return ["--vad", "--vad-model", vad_path]


# Cache detected flags (populated on first call)
_whisper_extra_flags: list[str] | None = None


def run_whisper(wav_path: str) -> tuple[str, int]:
    """Run whisper.cpp on a WAV file. Returns (text, duration_ms).

    Prefers the persistent whisper-server (model already loaded, fast).
    Falls back to one-shot subprocess if the server isn't available.
    """
    global _whisper_extra_flags

    wav_size = os.path.getsize(wav_path) if os.path.isfile(wav_path) else 0
    add_log("info", f"Whisper: input={wav_path} size={wav_size}B")

    # --- Try persistent server mode first ---
    if _is_whisper_server_alive():
        try:
            text, duration_ms = _transcribe_via_server(wav_path)
            add_log("info", f"Whisper (server): took={duration_ms}ms")

            # Filter silence markers
            for marker in ["[BLANK_AUDIO]", "(silence)", "[silence]"]:
                text = text.replace(marker, "")
            # Collapse all whitespace (including newlines between segments) into single spaces
            text = " ".join(text.split())

            if not text:
                add_log("warn", "Whisper (server): no speech detected")

            # Apply word corrections
            if text and word_corrections:
                corrected = apply_corrections(text)
                if corrected != text:
                    add_log("info", f"Corrections applied: {repr(text)} -> {repr(corrected)}")
                    text = corrected

            return text, duration_ms
        except Exception as e:
            add_log("warn", f"Whisper server request failed ({e}), falling back to subprocess")

    # --- Fallback: one-shot subprocess ---
    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if not whisper_bin:
        raise RuntimeError("whisper.cpp binary not found")

    if _whisper_extra_flags is None:
        _whisper_extra_flags = _detect_whisper_flags()

    vad_flags = _get_vad_flags()

    cmd = [
        whisper_bin,
        "--model", model_path,
        "--language", "en",
        *_whisper_extra_flags,
        *vad_flags,
        "--file", wav_path,
    ]
    add_log("info", f"Whisper cmd: {' '.join(cmd)}")

    t0 = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    duration_ms = int((time.time() - t0) * 1000)

    add_log("info", f"Whisper: exit={result.returncode} took={duration_ms}ms")
    add_log("info", f"Whisper stdout: {repr(result.stdout[:500])}")
    if result.stderr:
        # Log last few lines of stderr (contains processing info)
        stderr_lines = result.stderr.strip().splitlines()
        for line in stderr_lines[-5:]:
            add_log("info", f"Whisper stderr: {line.strip()}")

    # Parse output — whisper.cpp prints transcription to stdout
    raw_text = result.stdout.strip()
    text = raw_text
    # Filter out silence/blank markers
    silence_markers = ["[BLANK_AUDIO]", "(silence)", "[silence]"]
    for marker in silence_markers:
        text = text.replace(marker, "")
    # Collapse all whitespace (including newlines between segments) into single spaces
    text = " ".join(text.split())

    if not text and raw_text:
        add_log("warn", f"Whisper returned only silence markers: {repr(raw_text)}")
    elif not text:
        add_log("warn", "Whisper returned empty output — no speech detected")

    # Apply word corrections
    if text and word_corrections:
        corrected = apply_corrections(text)
        if corrected != text:
            add_log("info", f"Corrections applied: {repr(text)} -> {repr(corrected)}")
            text = corrected

    return text, duration_ms


# --- CORS helpers ---

def cors_headers() -> dict:
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Private-Network": "true",
    }


@app.after_request
def add_cors(response: Response) -> Response:
    for k, v in cors_headers().items():
        response.headers[k] = v
    return response


@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        resp = Response("", status=204)
        for k, v in cors_headers().items():
            resp.headers[k] = v
        return resp


# --- Endpoints ---

@app.route("/transcribe", methods=["POST"])
def transcribe():
    """One-shot transcription: accept raw audio bytes, return text."""
    if not model_loaded:
        return jsonify({"error": "model_not_loaded", "message": "Whisper model is not loaded. Run setup first."}), 503

    with transcribe_lock:
        try:
            audio_data = request.get_data()
            if not audio_data:
                return jsonify({"error": "no_audio", "message": "No audio data in request body."}), 400

            with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
                f.write(audio_data)
                input_path = f.name

            wav_path = input_path + ".wav"
            try:
                # Try to transcode (handles WebM, AAC, etc.)
                if not transcode_to_wav(input_path, wav_path):
                    # Maybe it's already a WAV — try directly
                    wav_path = input_path

                text, duration_ms = run_whisper(wav_path)
                wav_size = os.path.getsize(wav_path)
                audio_duration_sec = round((wav_size - 44) / 32000, 1)  # 16kHz mono PCM
                speed_ratio = round(audio_duration_sec / (duration_ms / 1000), 1) if duration_ms > 0 else 0
                add_log("info", f'Transcribed {duration_ms}ms ({speed_ratio}x) -> "{text[:80]}"')
                return jsonify({
                    "text": text,
                    "duration_ms": duration_ms,
                    "audio_duration_sec": audio_duration_sec,
                    "speed_ratio": speed_ratio,
                })
            finally:
                for p in [input_path, input_path + ".wav"]:
                    try:
                        os.unlink(p)
                    except OSError:
                        pass

        except RuntimeError as e:
            add_log("error", f"Transcription failed: {e}")
            return jsonify({"error": "transcription_failed", "message": str(e)}), 500
        except subprocess.TimeoutExpired:
            add_log("error", "Transcription timed out")
            return jsonify({"error": "timeout", "message": "Transcription timed out."}), 504


@app.route("/transcribe/start", methods=["POST"])
def transcribe_start():
    """PTT: start mic recording via termux-microphone-record."""
    if not model_loaded:
        return jsonify({"error": "model_not_loaded", "message": "Whisper model is not loaded."}), 503

    with recording_lock:
        global recording_process, recording_file

        if recording_process is not None:
            return jsonify({"ok": False, "error": "already_recording", "message": "Already recording."}), 409

        recording_file = tempfile.mktemp(suffix=f".{audio_ext}")
        try:
            if audio_format == "amr_wb":
                rec_cmd = _mic_record_cmd(recording_file, limit=0,
                                          encoder="amr_wb", bitrate="23850")
            else:
                rec_cmd = _mic_record_cmd(recording_file, limit=0)
            add_log("info", f"Recording cmd: {' '.join(rec_cmd)}")
            recording_process = subprocess.Popen(rec_cmd)
            add_log("info", f"Recording started: {recording_file}")
            print(f"Recording started: {recording_file}")
            return jsonify({"ok": True, "message": "Recording started"})
        except FileNotFoundError:
            recording_process = None
            recording_file = None
            add_log("error", "termux-microphone-record not found")
            return jsonify({"error": "mic_unavailable", "message": "termux-microphone-record not found. Install Termux:API."}), 500


@app.route("/transcribe/stop", methods=["POST"])
def transcribe_stop():
    """PTT: stop recording, transcribe captured audio, return text."""
    with recording_lock:
        global recording_process, recording_file

        if recording_process is None:
            return jsonify({"ok": False, "error": "not_recording", "message": "No active recording to stop."}), 400

        # Stop the recording
        try:
            stop_result = subprocess.run(
                ["termux-microphone-record", "-q"],
                timeout=5, capture_output=True, text=True,
            )
            add_log("info", f"Recording stop cmd exit={stop_result.returncode}")
            if stop_result.stdout.strip():
                add_log("info", f"Recording stop stdout: {stop_result.stdout.strip()[:200]}")
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            add_log("warn", f"Recording stop failed: {e}")

        # Wait for the audio file to be fully flushed/finalized.
        # Without this delay the file may be truncated when ffmpeg reads it,
        # producing a WAV with no audible content → "no speech detected".
        time.sleep(2)

        recording_process = None
        audio_file = recording_file
        recording_file = None

    if not audio_file or not os.path.isfile(audio_file):
        add_log("error", "Recording file not found after stop")
        return jsonify({"error": "recording_failed", "message": "Recording file not found."}), 500

    audio_size = os.path.getsize(audio_file)
    add_log("info", f"Recording finished: {audio_file} size={audio_size}B")
    print(f"Recording finished: {audio_file} size={audio_size}B")
    if audio_size < 100:
        add_log("error", f"Recording file too small ({audio_size}B) — mic may not be working")

    # Transcribe
    with transcribe_lock:
        try:
            wav_path = audio_file + ".wav"
            if not transcode_to_wav(audio_file, wav_path):
                add_log("error", "Failed to transcode recording")
                return jsonify({"error": "transcode_failed", "message": "Failed to convert audio to WAV."}), 500

            text, duration_ms = run_whisper(wav_path)
            wav_size = os.path.getsize(wav_path)
            audio_duration_sec = round((wav_size - 44) / 32000, 1)  # 16kHz mono PCM
            speed_ratio = round(audio_duration_sec / (duration_ms / 1000), 1) if duration_ms > 0 else 0
            add_log("info", f'PTT transcribed {duration_ms}ms ({speed_ratio}x) -> "{text[:80]}"')
            return jsonify({
                "text": text,
                "duration_ms": duration_ms,
                "audio_duration_sec": audio_duration_sec,
                "speed_ratio": speed_ratio,
            })
        except RuntimeError as e:
            add_log("error", f"PTT transcription failed: {e}")
            return jsonify({"error": "transcription_failed", "message": str(e)}), 500
        except subprocess.TimeoutExpired:
            add_log("error", "PTT transcription timed out")
            return jsonify({"error": "timeout", "message": "Transcription timed out."}), 504
        finally:
            for p in [audio_file, audio_file + ".wav"]:
                try:
                    os.unlink(p)
                except OSError:
                    pass


@app.route("/status", methods=["GET"])
def status():
    if model_loaded:
        is_recording = recording_process is not None
        return jsonify({
            "status": "ready",
            "version": SERVER_VERSION,
            "model": model_name,
            "model_size_mb": model_size_mb,
            "recording": is_recording,
            "whisper_server_mode": _is_whisper_server_alive(),
        })
    else:
        return jsonify({
            "status": "error",
            "version": SERVER_VERSION,
            "model": None,
            "message": "Model not loaded",
        })


@app.route("/logs", methods=["GET"])
def logs():
    return jsonify({"logs": list(log_buffer)})


@app.route("/debug/test-pipeline", methods=["POST"])
def debug_test_pipeline():
    """Record 3 seconds of audio and return full diagnostic info.

    Speak during the 3-second recording window.  The response includes
    file sizes, ffmpeg output, whisper raw output, and the final text.
    """
    if not model_loaded:
        return jsonify({"error": "model_not_loaded"}), 503

    diag = {"audio_format": audio_format, "audio_ext": audio_ext, "steps": []}

    with tempfile.TemporaryDirectory() as td:
        raw_file = os.path.join(td, f"test.{audio_ext}")
        wav_file = os.path.join(td, "test.wav")

        # Step 1: Record 3 seconds
        if audio_format == "amr_wb":
            rec_cmd = _mic_record_cmd(raw_file, limit=3, encoder="amr_wb", bitrate="23850")
        else:
            rec_cmd = _mic_record_cmd(raw_file, limit=3)
        diag["rec_cmd"] = " ".join(rec_cmd)

        try:
            subprocess.run(rec_cmd, timeout=5)
            time.sleep(4)  # wait for recording to finish + flush
            subprocess.run(["termux-microphone-record", "-q"], timeout=5)
            time.sleep(1)
        except Exception as e:
            diag["steps"].append({"step": "record", "error": str(e)})
            return jsonify(diag), 500

        raw_size = os.path.getsize(raw_file) if os.path.isfile(raw_file) else 0
        diag["steps"].append({"step": "record", "file": raw_file, "size_bytes": raw_size})

        if raw_size == 0:
            diag["steps"].append({"step": "record", "error": "Recording produced empty file — mic not working"})
            return jsonify(diag), 500

        # Step 2: Transcode
        ffmpeg_result = subprocess.run(
            ["ffmpeg", "-y", "-i", raw_file,
             "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav_file],
            capture_output=True, text=True, timeout=30,
        )
        wav_size = os.path.getsize(wav_file) if os.path.isfile(wav_file) else 0
        diag["steps"].append({
            "step": "transcode",
            "exit_code": ffmpeg_result.returncode,
            "wav_size_bytes": wav_size,
            "ffmpeg_stderr": ffmpeg_result.stderr[-500:] if ffmpeg_result.stderr else "",
        })

        if ffmpeg_result.returncode != 0 or wav_size < 1000:
            return jsonify(diag), 500

        # Step 3: Estimate audio energy (check if mic captured real audio)
        try:
            import struct
            with open(wav_file, "rb") as f:
                raw = f.read()
            # Skip WAV header (44 bytes), read PCM samples
            pcm = raw[44:]
            if len(pcm) >= 2:
                samples = struct.unpack(f"<{len(pcm)//2}h", pcm[:len(pcm)//2*2])
                max_amp = max(abs(s) for s in samples)
                avg_amp = sum(abs(s) for s in samples) / len(samples)
                diag["steps"].append({
                    "step": "audio_analysis",
                    "num_samples": len(samples),
                    "duration_sec": round(len(samples) / 16000, 2),
                    "max_amplitude": max_amp,
                    "avg_amplitude": round(avg_amp, 1),
                    "max_amplitude_pct": round(max_amp / 32768 * 100, 1),
                    "silent": max_amp < 100,
                })
        except Exception as e:
            diag["steps"].append({"step": "audio_analysis", "error": str(e)})

        # Step 4: Run whisper
        global _whisper_extra_flags
        whisper_bin = WHISPER_BIN or find_whisper_bin()
        if _whisper_extra_flags is None:
            _whisper_extra_flags = _detect_whisper_flags()
        whisper_cmd = [
            whisper_bin, "--model", model_path, "--language", "en",
            *_whisper_extra_flags, "--file", wav_file,
        ]
        diag["whisper_cmd"] = " ".join(whisper_cmd)
        t0 = time.time()
        whisper_result = subprocess.run(
            whisper_cmd, capture_output=True, text=True, timeout=60,
        )
        whisper_ms = int((time.time() - t0) * 1000)
        diag["steps"].append({
            "step": "whisper",
            "exit_code": whisper_result.returncode,
            "duration_ms": whisper_ms,
            "raw_stdout": whisper_result.stdout[:500],
            "stderr_tail": "\n".join(whisper_result.stderr.strip().splitlines()[-10:]) if whisper_result.stderr else "",
        })

        # Final text
        text = whisper_result.stdout.strip()
        for marker in ["[BLANK_AUDIO]", "(silence)", "[silence]"]:
            text = text.replace(marker, "")
        text = text.strip()
        diag["final_text"] = text
        diag["speech_detected"] = bool(text)

    return jsonify(diag)


@app.route("/corrections", methods=["GET"])
def get_corrections():
    """Return the current word corrections dictionary."""
    return jsonify(word_corrections)


@app.route("/corrections", methods=["PUT"])
def put_corrections():
    """Replace the entire word corrections dictionary."""
    data = request.get_json(silent=True)
    if data is None or not isinstance(data, dict):
        return jsonify({"error": "invalid_body", "message": "Request body must be a JSON object."}), 400
    # Validate: all keys and values must be non-empty strings
    for k, v in data.items():
        if not isinstance(k, str) or not isinstance(v, str) or not k.strip() or not v.strip():
            return jsonify({"error": "invalid_entry", "message": "All keys and values must be non-empty strings."}), 400
    global word_corrections
    word_corrections = {k.strip(): v.strip() for k, v in data.items()}
    save_corrections()
    add_log("info", f"Word corrections updated: {len(word_corrections)} entries")
    return jsonify(word_corrections)


# --- Settings ---

@app.route("/settings", methods=["GET"])
def get_settings():
    """Return current runtime settings."""
    return jsonify(runtime_settings)


@app.route("/settings", methods=["PUT"])
def put_settings():
    """Update runtime settings.

    Body: {"noise_reduction": true}
    Only known keys are accepted; unknown keys are ignored.
    """
    data = request.get_json(silent=True)
    if data is None or not isinstance(data, dict):
        return jsonify({"error": "invalid_body", "message": "Request body must be a JSON object."}), 400

    known_keys = {"noise_reduction": bool}
    for key, expected_type in known_keys.items():
        if key in data:
            if not isinstance(data[key], expected_type):
                return jsonify({
                    "error": "invalid_value",
                    "message": f"'{key}' must be {expected_type.__name__}.",
                }), 400
            runtime_settings[key] = data[key]

    add_log("info", f"Settings updated: {runtime_settings}")
    return jsonify(runtime_settings)


# --- Benchmark ---

# Lock to prevent concurrent benchmarks (they're resource-heavy)
benchmark_lock = threading.Lock()
benchmark_running = False


def run_whisper_on_model(model_file: str, wav_path: str, use_vad: bool = False) -> tuple[str, int]:
    """Run whisper.cpp on a WAV file with a specific model. Returns (text, duration_ms)."""
    global _whisper_extra_flags

    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if not whisper_bin:
        raise RuntimeError("whisper.cpp binary not found")

    if _whisper_extra_flags is None:
        _whisper_extra_flags = _detect_whisper_flags()

    vad_flags = _get_vad_flags() if use_vad else []

    cmd = [
        whisper_bin,
        "--model", model_file,
        "--language", "en",
        *_whisper_extra_flags,
        *vad_flags,
        "--file", wav_path,
    ]

    t0 = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    duration_ms = int((time.time() - t0) * 1000)

    raw_text = result.stdout.strip()
    text = raw_text
    for marker in ["[BLANK_AUDIO]", "(silence)", "[silence]"]:
        text = text.replace(marker, "")
    text = text.strip()

    return text, duration_ms


@app.route("/models/benchmark", methods=["POST"])
def benchmark_models():
    """Benchmark downloaded models against a test audio clip.

    This records a short audio clip (or accepts one), then runs it through
    each requested model and returns timing + transcription results.

    Body (optional):
      {
        "models": ["base.en", "small.en"],  // defaults to all downloaded
        "duration": 3,                       // recording duration (2-10 sec, default 3)
        "use_vad": false                     // use VAD if available
      }

    Or POST raw audio bytes with Content-Type: audio/* to benchmark
    against uploaded audio.
    """
    global benchmark_running

    if not model_loaded:
        return jsonify({"error": "model_not_loaded"}), 503

    if recording_process is not None:
        return jsonify({"error": "recording_active", "message": "Cannot benchmark while recording."}), 409

    if benchmark_running:
        return jsonify({"error": "benchmark_running", "message": "A benchmark is already in progress."}), 409

    with benchmark_lock:
        benchmark_running = True
        try:
            return _do_benchmark()
        finally:
            benchmark_running = False


def _do_benchmark():
    """Execute the benchmark (called under lock)."""
    # Parse request
    content_type = request.content_type or ""
    use_uploaded_audio = content_type.startswith("audio/")

    if use_uploaded_audio:
        requested_models = None
        duration = 0
        use_vad = False
    else:
        data = request.get_json(silent=True) or {}
        requested_models = data.get("models")
        duration = data.get("duration", 3)
        use_vad = data.get("use_vad", False)
        duration = max(2, min(10, int(duration)))

    # Determine which models to benchmark
    all_models = list_models()
    downloaded = [m for m in all_models if m["downloaded"]]
    if not downloaded:
        return jsonify({"error": "no_models", "message": "No models downloaded."}), 400

    if requested_models:
        targets = [m for m in downloaded if m["name"] in requested_models]
        if not targets:
            return jsonify({"error": "no_matching_models", "message": "None of the requested models are downloaded."}), 400
    else:
        targets = downloaded

    add_log("info", f"Benchmark starting: {len(targets)} models, duration={duration}s, vad={use_vad}")

    with tempfile.TemporaryDirectory() as td:
        wav_path = os.path.join(td, "benchmark.wav")

        if use_uploaded_audio:
            # Save uploaded audio, transcode to WAV
            input_path = os.path.join(td, "uploaded.audio")
            with open(input_path, "wb") as f:
                f.write(request.get_data())
            if not transcode_to_wav(input_path, wav_path):
                return jsonify({"error": "transcode_failed", "message": "Failed to convert uploaded audio."}), 400
        else:
            # Record audio from mic
            raw_file = os.path.join(td, f"benchmark.{audio_ext}")
            if audio_format == "amr_wb":
                rec_cmd = _mic_record_cmd(raw_file, limit=duration, encoder="amr_wb", bitrate="23850")
            else:
                rec_cmd = _mic_record_cmd(raw_file, limit=duration)
            try:
                subprocess.run(rec_cmd, timeout=duration + 5)
                time.sleep(duration + 1)
                subprocess.run(["termux-microphone-record", "-q"], timeout=5)
                time.sleep(1)
            except Exception as e:
                return jsonify({"error": "recording_failed", "message": str(e)}), 500

            raw_size = os.path.getsize(raw_file) if os.path.isfile(raw_file) else 0
            if raw_size < 100:
                return jsonify({"error": "recording_empty", "message": "Recording produced no audio."}), 500

            if not transcode_to_wav(raw_file, wav_path):
                return jsonify({"error": "transcode_failed", "message": "Failed to transcode recording."}), 500

        # Get WAV info
        wav_size = os.path.getsize(wav_path)
        audio_duration_sec = round((wav_size - 44) / 32000, 1)  # 16kHz × 2 bytes

        # Benchmark each model
        results = []
        for m in targets:
            model_file = os.path.join(MODEL_DIR, m["file"])
            add_log("info", f"Benchmarking {m['name']}...")
            try:
                text, inference_ms = run_whisper_on_model(model_file, wav_path, use_vad)
                speed_ratio = round(audio_duration_sec / (inference_ms / 1000), 1) if inference_ms > 0 else 0
                results.append({
                    "model": m["name"],
                    "size_mb": m["size_mb"],
                    "text": text,
                    "inference_ms": inference_ms,
                    "speed_ratio": speed_ratio,
                    "error": None,
                })
                add_log("info", f"Benchmark {m['name']}: {inference_ms}ms, {speed_ratio}x, \"{text[:60]}\"")
            except Exception as e:
                results.append({
                    "model": m["name"],
                    "size_mb": m["size_mb"],
                    "text": "",
                    "inference_ms": 0,
                    "speed_ratio": 0,
                    "error": str(e),
                })
                add_log("error", f"Benchmark {m['name']} failed: {e}")

        add_log("info", f"Benchmark complete: {len(results)} models tested")

        return jsonify({
            "audio_duration_sec": audio_duration_sec,
            "use_vad": use_vad,
            "vad_available": _detect_vad_support(),
            "results": results,
        })


# --- Model management ---

# Known models that update-model.sh can download.
# Keep in sync with update-model.sh.
MODEL_CATALOG = [
    {"name": "tiny.en",              "size_mb": 75,   "description": "Fastest, basic accuracy"},
    {"name": "tiny.en-q5_1",         "size_mb": 31,   "description": "Fastest quantized, basic accuracy"},
    {"name": "base.en",              "size_mb": 142,  "description": "Fast, good accuracy"},
    {"name": "base.en-q5_1",         "size_mb": 60,   "description": "Fast quantized, good accuracy"},
    {"name": "small.en",             "size_mb": 466,  "description": "Slower, better accuracy"},
    {"name": "small.en-q5_1",        "size_mb": 190,  "description": "Best speed/accuracy for phone"},
    {"name": "medium.en",            "size_mb": 1500, "description": "Slow, great accuracy"},
    {"name": "medium.en-q5_0",       "size_mb": 515,  "description": "Great accuracy, quantized"},
    {"name": "large-v3-turbo",       "size_mb": 1500, "description": "6x faster than large, excellent accuracy"},
    {"name": "large-v3-turbo-q5_0",  "size_mb": 547,  "description": "Turbo quantized — best speed/accuracy tradeoff"},
    {"name": "large-v3-turbo-q8_0",  "size_mb": 810,  "description": "Turbo quantized — near-full accuracy"},
    {"name": "distil-small.en",      "size_mb": 350,  "description": "Optimized small model"},
    {"name": "distil-medium.en",     "size_mb": 750,  "description": "Optimized medium model"},
]


def list_models() -> list[dict]:
    """Return catalog of known models, annotated with download/active status."""
    # Scan disk for downloaded models
    on_disk: dict[str, int] = {}
    if os.path.isdir(MODEL_DIR):
        for fname in os.listdir(MODEL_DIR):
            if fname.startswith("ggml-") and fname.endswith(".bin"):
                fpath = os.path.join(MODEL_DIR, fname)
                name = fname.replace("ggml-", "").replace(".bin", "")
                on_disk[name] = round(os.path.getsize(fpath) / (1024 * 1024))

    # Build result from catalog, marking downloaded/active
    models = []
    seen = set()
    for entry in MODEL_CATALOG:
        name = entry["name"]
        seen.add(name)
        downloaded = name in on_disk
        models.append({
            "name": name,
            "file": f"ggml-{name}.bin",
            "size_mb": on_disk[name] if downloaded else entry["size_mb"],
            "description": entry["description"],
            "downloaded": downloaded,
            "active": downloaded and os.path.join(MODEL_DIR, f"ggml-{name}.bin") == model_path,
        })

    # Append any downloaded models not in the catalog (e.g. large, custom)
    for name, size in sorted(on_disk.items()):
        if name not in seen:
            models.append({
                "name": name,
                "file": f"ggml-{name}.bin",
                "size_mb": size,
                "description": "",
                "downloaded": True,
                "active": os.path.join(MODEL_DIR, f"ggml-{name}.bin") == model_path,
            })

    return models


@app.route("/models", methods=["GET"])
def get_models():
    """List known Whisper models with download and active status."""
    return jsonify({"models": list_models()})


@app.route("/model", methods=["PUT"])
def put_model():
    """Switch the active Whisper model.

    Body: {"model": "small.en"}  (the model name, not the filename)
    """
    global model_path, model_name, model_size_mb, model_loaded

    if recording_process is not None:
        return jsonify({
            "error": "recording_active",
            "message": "Cannot switch models while recording is active.",
        }), 409

    data = request.get_json(silent=True)
    if data is None or "model" not in data:
        return jsonify({
            "error": "invalid_body",
            "message": "Request body must be JSON with a 'model' field.",
        }), 400

    requested = data["model"]
    if not isinstance(requested, str) or not requested.strip():
        return jsonify({
            "error": "invalid_model",
            "message": "Model name must be a non-empty string.",
        }), 400

    requested = requested.strip()
    new_file = f"ggml-{requested}.bin"
    new_path = os.path.join(MODEL_DIR, new_file)

    if not os.path.isfile(new_path):
        return jsonify({
            "error": "model_not_found",
            "message": f"Model file not found: {new_file}",
        }), 404

    model_path = new_path
    model_name = requested
    model_size_mb = round(os.path.getsize(new_path) / (1024 * 1024))
    model_loaded = True
    add_log("info", f"Model switched to: {model_name} ({model_size_mb} MB)")

    # Restart the persistent whisper-server with the new model
    if _whisper_server_mode or _whisper_server_proc is not None:
        restart_whisper_server(new_path)

    return jsonify({
        "ok": True,
        "model": model_name,
        "model_size_mb": model_size_mb,
    })


# --- Main ---

if __name__ == "__main__":
    _init_runtime_settings()
    load_corrections()
    load_model()
    _detect_termux_api_bin()
    detect_audio_format()

    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if whisper_bin:
        add_log("info", f"Whisper binary: {whisper_bin}")
    else:
        add_log("error", "Whisper binary not found — transcription will fail")

    # Try to start persistent whisper-server (model loaded once, fast inference).
    # Falls back to one-shot subprocess mode if the binary isn't available.
    if model_loaded:
        if start_whisper_server(model_path):
            add_log("info", "Using persistent whisper-server mode (model loaded once)")
        else:
            add_log("info", "Using subprocess mode (model loaded per request)")

    add_log("info", f"Server starting on port {PORT}")
    app.run(host="127.0.0.1", port=PORT, threaded=True)
