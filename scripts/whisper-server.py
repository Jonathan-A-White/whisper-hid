#!/data/data/com.termux/files/usr/bin/python3
"""Whisper HTTP API server — wraps whisper.cpp with Flask.

Endpoints:
  POST /transcribe       — One-shot: accept audio bytes, return transcription
  POST /transcribe/start — PTT: start mic recording
  POST /transcribe/stop  — PTT: stop recording, transcribe, return text
  GET  /status           — Server health and loaded model
  GET  /logs             — Recent log entries (circular buffer, 200 max)
"""

import json
import os
import subprocess
import tempfile
import threading
import time
from collections import deque
from pathlib import Path

from flask import Flask, Response, jsonify, request

app = Flask(__name__)

# --- Configuration ---

INSTALL_DIR = os.environ.get("WHISPER_INSTALL_DIR", os.path.expanduser("~/whisper-stt"))
MODEL_DIR = os.path.join(INSTALL_DIR, "models")
DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "ggml-base.en.bin")
WHISPER_BIN = os.environ.get("WHISPER_BIN", "")
ALLOWED_ORIGIN = os.environ.get(
    "CORS_ORIGIN", "https://jonathan-a-white.github.io"
)
PORT = int(os.environ.get("WHISPER_PORT", "9876"))

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


def detect_audio_format():
    """Detect whether AAC or AMR-WB recording works on this device.

    Mirrors the pipeline test in start-stt.sh — try AAC first (default
    encoder), fall back to AMR-WB if ffmpeg can't convert the output.
    """
    global audio_format, audio_ext

    with tempfile.TemporaryDirectory() as td:
        # Try AAC first (termux-microphone-record default)
        test_raw = os.path.join(td, "test.aac")
        test_wav = os.path.join(td, "test.wav")
        try:
            subprocess.run(
                ["termux-microphone-record", "-f", test_raw, "-l", "1"],
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
                ["termux-microphone-record", "-f", test_raw, "-l", "1",
                 "-e", "amr_wb", "-b", "23850"],
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
    """Transcode any audio format to 16kHz mono WAV using ffmpeg."""
    input_size = os.path.getsize(input_path) if os.path.isfile(input_path) else 0
    add_log("info", f"Transcode: input={input_path} size={input_size}B")
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-i", input_path,
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output_path,
            ],
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


# Cache detected flags (populated on first call)
_whisper_extra_flags: list[str] | None = None


def run_whisper(wav_path: str) -> tuple[str, int]:
    """Run whisper.cpp on a WAV file. Returns (text, duration_ms)."""
    global _whisper_extra_flags

    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if not whisper_bin:
        raise RuntimeError("whisper.cpp binary not found")

    if _whisper_extra_flags is None:
        _whisper_extra_flags = _detect_whisper_flags()

    wav_size = os.path.getsize(wav_path) if os.path.isfile(wav_path) else 0
    add_log("info", f"Whisper: input={wav_path} size={wav_size}B")

    cmd = [
        whisper_bin,
        "--model", model_path,
        "--language", "en",
        *_whisper_extra_flags,
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
    text = text.strip()

    if not text and raw_text:
        add_log("warn", f"Whisper returned only silence markers: {repr(raw_text)}")
    elif not text:
        add_log("warn", "Whisper returned empty output — no speech detected")

    return text, duration_ms


# --- CORS helpers ---

def cors_headers() -> dict:
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
                add_log("info", f'Transcribed {duration_ms}ms -> "{text[:80]}"')
                return jsonify({"text": text, "duration_ms": duration_ms})
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
            rec_cmd = [
                "termux-microphone-record",
                "-f", recording_file,
                "-l", "0",     # unlimited duration
            ]
            if audio_format == "amr_wb":
                rec_cmd += ["-e", "amr_wb", "-b", "23850"]
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
            add_log("info", f'PTT transcribed {duration_ms}ms -> "{text[:80]}"')
            return jsonify({"text": text, "duration_ms": duration_ms})
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
            "model": model_name,
            "model_size_mb": model_size_mb,
            "recording": is_recording,
        })
    else:
        return jsonify({
            "status": "error",
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
        rec_cmd = ["termux-microphone-record", "-f", raw_file, "-l", "3"]
        if audio_format == "amr_wb":
            rec_cmd += ["-e", "amr_wb", "-b", "23850"]
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


# --- Main ---

if __name__ == "__main__":
    load_model()
    detect_audio_format()

    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if whisper_bin:
        add_log("info", f"Whisper binary: {whisper_bin}")
    else:
        add_log("error", "Whisper binary not found — transcription will fail")

    add_log("info", f"Server starting on port {PORT}")
    app.run(host="127.0.0.1", port=PORT, threaded=True)
