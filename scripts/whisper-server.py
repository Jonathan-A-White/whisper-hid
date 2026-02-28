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
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", input_path,
                "-ar", "16000", "-ac", "1", "-f", "wav", output_path,
            ],
            capture_output=True,
            timeout=30,
        )
        return os.path.isfile(output_path) and os.path.getsize(output_path) > 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def run_whisper(wav_path: str) -> tuple[str, int]:
    """Run whisper.cpp on a WAV file. Returns (text, duration_ms)."""
    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if not whisper_bin:
        raise RuntimeError("whisper.cpp binary not found")

    t0 = time.time()
    result = subprocess.run(
        [
            whisper_bin,
            "--model", model_path,
            "--language", "en",
            "--no-timestamps",
            "--print-special", "false",
            "--no-context",
            "--file", wav_path,
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    duration_ms = int((time.time() - t0) * 1000)

    # Parse output — whisper.cpp prints transcription to stdout
    text = result.stdout.strip()
    # Filter out silence/blank markers
    silence_markers = ["[BLANK_AUDIO]", "(silence)", "[silence]"]
    for marker in silence_markers:
        text = text.replace(marker, "")
    text = text.strip()

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

        recording_file = tempfile.mktemp(suffix=".amr")
        try:
            recording_process = subprocess.Popen(
                [
                    "termux-microphone-record",
                    "-f", recording_file,
                    "-l", "0",     # unlimited duration
                    "-s", "7",     # VOICE_COMMUNICATION source (enables SCO)
                ],
            )
            add_log("info", "Recording started (PTT)")
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
            subprocess.run(["termux-microphone-record", "-q"], timeout=5)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

        recording_process = None
        audio_file = recording_file
        recording_file = None

    if not audio_file or not os.path.isfile(audio_file):
        add_log("error", "Recording file not found after stop")
        return jsonify({"error": "recording_failed", "message": "Recording file not found."}), 500

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


# --- Main ---

if __name__ == "__main__":
    load_model()

    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if whisper_bin:
        add_log("info", f"Whisper binary: {whisper_bin}")
    else:
        add_log("error", "Whisper binary not found — transcription will fail")

    add_log("info", f"Server starting on port {PORT}")
    app.run(host="127.0.0.1", port=PORT, threaded=True)
