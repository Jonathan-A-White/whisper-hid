#!/data/data/com.termux/files/usr/bin/python3
"""Speech-to-text HTTP API server — Parakeet (sherpa-onnx) or whisper.cpp with Flask.

Two transcription engines:
  - parakeet: NVIDIA Parakeet TDT 0.6B via sherpa-onnx, in-process (preferred —
    faster and more accurate than whisper base.en). Used when the model files
    and the sherpa-onnx package are available.
  - whisper: whisper.cpp via persistent whisper-server or one-shot subprocess.
    Automatic fallback when Parakeet is unavailable or fails.

Endpoints:
  POST /transcribe        — One-shot: accept audio bytes, return transcription
  POST /transcribe/start  — PTT: start mic recording
  POST /transcribe/stop   — PTT: stop recording, transcribe, return text
  GET  /status            — Server health, active engine and loaded model
  GET  /logs              — Recent log entries (circular buffer, 200 max)
  GET  /models            — List available models on disk
  PUT  /model             — Switch the active model (whisper models or parakeet)
  POST /models/benchmark  — Benchmark models against a test audio clip
  GET  /symbols           — Symbol replacement config (spoken word -> symbol)
  PUT  /symbols           — Update symbol replacement config (partial merge)
  POST /symbols/reset     — Restore default symbol entries
  GET  /cleanup           — Speech cleanup (local LLM) state
  PUT  /cleanup           — Enable/disable speech cleanup
"""

import atexit
import cmath
import json
import math
import os
import re
import shutil
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

SERVER_VERSION = "1.7.0"

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

# Parakeet engine (sherpa-onnx). STT_ENGINE: "auto" prefers parakeet when
# available, "whisper" forces whisper.cpp, "parakeet" requires parakeet.
STT_ENGINE = os.environ.get("STT_ENGINE", "auto").lower()
PARAKEET_MODEL_NAME = "parakeet-tdt-0.6b-v2"
PARAKEET_DIR_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
PARAKEET_CATALOG_SIZE_MB = 640
PARAKEET_THREADS = int(os.environ.get("PARAKEET_THREADS", "4"))

# Speech cleanup (local LLM post-processing). STT_CLEANUP: "auto" (default)
# starts a llama.cpp server at startup when its binary and model are present;
# "off" disables the feature entirely. Whether cleanup is *applied* is a
# separate runtime toggle (PUT /cleanup, persisted to CLEANUP_SETTINGS_FILE).
STT_CLEANUP = os.environ.get("STT_CLEANUP", "auto").lower()
CLEANUP_SERVER_PORT = int(os.environ.get("CLEANUP_SERVER_PORT", "9879"))
# Known cleanup models. "name" is the API/UI identifier (like whisper model
# names); keep the file names in sync with setup-termux.sh and update-model.sh.
# The first entry is the default. CLEANUP_MODEL (env) overrides the default
# file; a runtime selection (PUT /cleanup {"model": ...}) is persisted in
# CLEANUP_SETTINGS_FILE and wins when its file is on disk.
CLEANUP_MODEL_CATALOG = [
    {
        "name": "qwen3-1.7b",
        "file": "Qwen3-1.7B-Q4_K_M.gguf",
        "size_mb": 1120,
        "description": "Default — fast, ~1.4 GB RAM",
    },
    {
        "name": "qwen3-4b",
        "file": "Qwen3-4B-Q4_K_M.gguf",
        "size_mb": 2400,
        "description": "Smarter rewrites/edits — ~3 GB RAM, roughly 2x slower",
    },
]
CLEANUP_MODEL_FILE = os.environ.get("CLEANUP_MODEL", CLEANUP_MODEL_CATALOG[0]["file"])
CLEANUP_THREADS = int(os.environ.get("CLEANUP_THREADS", "4"))
CLEANUP_TIMEOUT_SEC = int(os.environ.get("CLEANUP_TIMEOUT_SEC", "45"))

# Chunked (streaming) transcription. STT_CHUNKED: "auto" (default) probes at
# startup whether recordings can be decoded while still being written and, if
# so, transcribes silence-delimited chunks in the background during recording
# (may switch the recording format to AMR-WB when AAC isn't partial-decodable);
# "off" disables the probe and the feature.
STT_CHUNKED = os.environ.get("STT_CHUNKED", "auto").lower()

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

active_engine = "whisper"  # "whisper" or "parakeet"
model_path = ""
model_name = ""
model_size_mb = 0
model_loaded = False
recording_process = None
recording_file = None
recording_lock = threading.Lock()
transcribe_lock = threading.Lock()
log_buffer = deque(maxlen=200)
# Recent final transcripts, kept in memory for POST /corrections/suggest
# (the LLM scans them for recurring misrecognitions). Never persisted.
recent_transcripts = deque(maxlen=20)
start_time = time.time()
audio_format = "aac"       # detected at startup: "aac" or "amr_wb"
audio_ext = "aac"          # file extension for recordings
chunked_supported = False  # set by detect_chunked_support() at startup
chunk_session = None       # active ChunkedSession while recording (guarded by recording_lock)


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


# --- Symbol replacements (spoken words -> symbols, e.g. "forward slash" -> "/") ---

SYMBOLS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "symbol-replacements.json"
)

SYMBOL_SPACINGS = ("both", "left", "right", "none")

# Starter set, materialized into SYMBOLS_FILE on first run so every entry
# can be edited or deleted like a user-added one.
DEFAULT_SYMBOLS = [
    {"phrase": "forward slash", "symbol": "/", "spacing": "both"},
    {"phrase": "back slash", "symbol": "\\", "spacing": "both"},
    {"phrase": "dash", "symbol": "-", "spacing": "both"},
    {"phrase": "dot", "symbol": ".", "spacing": "both"},
    {"phrase": "underscore", "symbol": "_", "spacing": "both"},
    {"phrase": "backtick", "symbol": "`", "spacing": "both"},
    {"phrase": "pipe", "symbol": "|", "spacing": "both"},
    {"phrase": "at sign", "symbol": "@", "spacing": "both"},
    {"phrase": "hash", "symbol": "#", "spacing": "both"},
    {"phrase": "tilde", "symbol": "~", "spacing": "both"},
    {"phrase": "colon", "symbol": ":", "spacing": "left"},
    {"phrase": "comma", "symbol": ",", "spacing": "left"},
    {"phrase": "open paren", "symbol": "(", "spacing": "right"},
    {"phrase": "close paren", "symbol": ")", "spacing": "left"},
]

symbol_settings: dict = {"enabled": False, "entries": []}


def _valid_symbol_entry(e) -> bool:
    return (
        isinstance(e, dict)
        and isinstance(e.get("phrase"), str)
        and bool(e["phrase"].strip())
        and isinstance(e.get("symbol"), str)
        and bool(e["symbol"])
        and e.get("spacing", "both") in SYMBOL_SPACINGS
    )


def _normalize_symbol_entry(e: dict) -> dict:
    return {
        "phrase": e["phrase"].strip(),
        "symbol": e["symbol"],
        "spacing": e.get("spacing", "both"),
    }


def load_symbols():
    """Load symbol replacements from JSON file.

    On first run (no file) the default starter set is written to disk so
    the user owns every entry from then on.
    """
    global symbol_settings
    if not os.path.isfile(SYMBOLS_FILE):
        symbol_settings = {
            "enabled": False,
            "entries": [dict(e) for e in DEFAULT_SYMBOLS],
        }
        save_symbols()
        return
    try:
        with open(SYMBOLS_FILE, "r") as f:
            data = json.load(f)
        entries = [
            _normalize_symbol_entry(e)
            for e in data.get("entries", [])
            if _valid_symbol_entry(e)
        ]
        symbol_settings = {"enabled": bool(data.get("enabled", False)), "entries": entries}
    except (json.JSONDecodeError, OSError):
        # Corrupt file: fall back to defaults in memory, don't overwrite it
        symbol_settings = {
            "enabled": False,
            "entries": [dict(e) for e in DEFAULT_SYMBOLS],
        }


def save_symbols():
    """Save symbol replacements to JSON file."""
    try:
        with open(SYMBOLS_FILE, "w") as f:
            json.dump(symbol_settings, f, indent=2)
            f.write("\n")
    except OSError as e:
        add_log("error", f"Failed to save symbol replacements: {e}")


def apply_symbols(text: str) -> str:
    """Replace spoken symbol phrases with their symbols.

    Case-insensitive whole-phrase matching. Each entry's "spacing" controls
    which adjacent spaces the symbol absorbs:
      both  — joins the surrounding words ("foo dash bar" -> "foo-bar")
      left  — attaches to the previous word ("key colon value" -> "key: value")
      right — attaches to the next word ("open paren x" -> "(x")
      none  — plain word swap, spaces untouched
    """
    if not symbol_settings.get("enabled") or not symbol_settings.get("entries"):
        return text
    # Longest phrase first so "forward slash" wins over a bare "slash" entry
    entries = sorted(
        symbol_settings["entries"],
        key=lambda e: len(e.get("phrase", "")),
        reverse=True,
    )
    for entry in entries:
        phrase = entry.get("phrase", "").strip()
        symbol = entry.get("symbol", "")
        if not phrase or not symbol:
            continue
        spacing = entry.get("spacing", "both")
        inner = r"\s+".join(re.escape(w) for w in phrase.split())
        left = r"\s*" if spacing in ("both", "left") else ""
        right = r"\s*" if spacing in ("both", "right") else ""
        pattern = re.compile(left + r"\b" + inner + r"\b" + right, re.IGNORECASE)
        # Lambda replacement: symbols like "\" must not be parsed as regex escapes
        text = pattern.sub(lambda m, s=symbol: s, text)
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


# --- Speech cleanup (local LLM removes disfluencies, fixes punctuation) ---
#
# A small instruct model (Qwen3-1.7B Q4 by default) served by a resident
# llama.cpp llama-server on CLEANUP_SERVER_PORT rewrites the final transcript:
# filler words and false starts removed, spoken self-corrections resolved,
# punctuation/capitalization fixed. It runs ONCE on the joined full text (via
# _postprocess_text, before word corrections) — never on individual chunks,
# since false starts and self-corrections span chunk boundaries. Skipped while
# symbol mode is on (CLI dictation wants verbatim text). Any failure or a
# degenerate LLM response falls back to the raw transcript — never breakage.

CLEANUP_SETTINGS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "cleanup-settings.json"
)

# "style" picks the rewrite flavor (a key of CLEANUP_STYLES); "model" is a
# catalog name selected at runtime, or None for the default model.
CLEANUP_DEFAULT_SETTINGS: dict = {"enabled": False, "style": "standard", "model": None}

cleanup_settings: dict = dict(CLEANUP_DEFAULT_SETTINGS)


def load_cleanup_settings():
    """Load the speech cleanup settings (toggle, style, model) from JSON."""
    global cleanup_settings
    cleanup_settings = dict(CLEANUP_DEFAULT_SETTINGS)
    if not os.path.isfile(CLEANUP_SETTINGS_FILE):
        return
    try:
        with open(CLEANUP_SETTINGS_FILE, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return
    cleanup_settings["enabled"] = bool(data.get("enabled", False))
    style = data.get("style")
    if isinstance(style, str) and style in CLEANUP_STYLES:
        cleanup_settings["style"] = style
    model = data.get("model")
    if isinstance(model, str) and _cleanup_model_by_name(model):
        cleanup_settings["model"] = model


def save_cleanup_settings():
    """Save the speech cleanup settings to their JSON file."""
    try:
        with open(CLEANUP_SETTINGS_FILE, "w") as f:
            json.dump(cleanup_settings, f, indent=2)
            f.write("\n")
    except OSError as e:
        add_log("error", f"Failed to save cleanup settings: {e}")


def _cleanup_model_by_name(name: str) -> dict | None:
    """Look up a CLEANUP_MODEL_CATALOG entry by its name."""
    return next((m for m in CLEANUP_MODEL_CATALOG if m["name"] == name), None)


def _cleanup_model_present(filename: str) -> bool:
    """True when a cleanup GGUF exists on disk with a plausible size.

    Requires a plausible size, not just existence: a failed download can leave
    a tiny error-page file (e.g. 15 bytes of "Entry not found"), which would
    otherwise make llama-server start and immediately exit.
    """
    path = os.path.join(MODEL_DIR, filename)
    return os.path.isfile(path) and os.path.getsize(path) > 10 * 1024 * 1024


def active_cleanup_model_file() -> str:
    """File name of the cleanup model to serve.

    The runtime selection (PUT /cleanup {"model": ...}) wins when its file is
    on disk; otherwise the default (CLEANUP_MODEL env var or catalog head).
    """
    selected = cleanup_settings.get("model")
    entry = _cleanup_model_by_name(selected) if isinstance(selected, str) else None
    if entry and _cleanup_model_present(entry["file"]):
        return entry["file"]
    return CLEANUP_MODEL_FILE


_cleanup_server_proc: subprocess.Popen | None = None
_cleanup_loaded_file = ""  # basename of the GGUF the running llama-server loaded


def find_cleanup_bin() -> str:
    """Locate the llama.cpp server binary."""
    c = os.path.join(INSTALL_DIR, "llama.cpp", "build", "bin", "llama-server")
    if os.path.isfile(c) and os.access(c, os.X_OK):
        return c
    return ""


def find_cleanup_model() -> str:
    """Locate the active cleanup GGUF model file (empty string if missing)."""
    filename = active_cleanup_model_file()
    if _cleanup_model_present(filename):
        return os.path.join(MODEL_DIR, filename)
    return ""


def _cleanup_health_ok(timeout: float = 1.0) -> bool:
    """True when llama-server answers /health with 200 (503 while loading)."""
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{CLEANUP_SERVER_PORT}/health"
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _is_cleanup_server_alive() -> bool:
    """Check that the llama-server process runs and its model is loaded."""
    return (
        _cleanup_server_proc is not None
        and _cleanup_server_proc.poll() is None
        and _cleanup_health_ok()
    )


def start_cleanup_server() -> bool:
    """Start the resident llama-server for speech cleanup.

    Returns True if the process was launched. Model loading takes a while on
    first start, so readiness is not waited for here — a background thread
    logs when /health goes green, and apply_cleanup() checks liveness per
    call. Missing binary or model just means cleanup stays unavailable.
    """
    global _cleanup_server_proc

    server_bin = find_cleanup_bin()
    model_file = find_cleanup_model()
    if not server_bin or not model_file:
        add_log(
            "info",
            "Speech cleanup unavailable — llama-server binary or model missing "
            "(run setup-termux.sh, or: ./update-model.sh cleanup)",
        )
        return False

    cmd = [
        server_bin,
        "--model", model_file,
        "--host", "127.0.0.1",
        "--port", str(CLEANUP_SERVER_PORT),
        "--ctx-size", "4096",
        "--threads", str(CLEANUP_THREADS),
    ]
    add_log("info", f"Starting cleanup llama-server: {' '.join(cmd)}")
    try:
        _cleanup_server_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, OSError) as e:
        add_log("error", f"Failed to start cleanup llama-server: {e}")
        return False
    global _cleanup_loaded_file
    _cleanup_loaded_file = os.path.basename(model_file)

    def _watch_ready(proc):
        deadline = time.time() + 180
        while time.time() < deadline:
            if proc.poll() is not None:
                add_log("error", f"Cleanup llama-server exited (code={proc.returncode})")
                return
            if _cleanup_health_ok():
                add_log("info", f"Cleanup llama-server ready on port {CLEANUP_SERVER_PORT} (pid={proc.pid})")
                return
            time.sleep(1.0)
        add_log("warn", "Cleanup llama-server not ready after 180s — cleanup stays unavailable")

    threading.Thread(
        target=_watch_ready, args=(_cleanup_server_proc,),
        daemon=True, name="cleanup-server-watch",
    ).start()
    return True


def stop_cleanup_server():
    """Stop the resident cleanup llama-server."""
    global _cleanup_server_proc, _cleanup_loaded_file

    if _cleanup_server_proc is not None:
        add_log("info", f"Stopping cleanup llama-server (pid={_cleanup_server_proc.pid})")
        try:
            _cleanup_server_proc.terminate()
            _cleanup_server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _cleanup_server_proc.kill()
            _cleanup_server_proc.wait(timeout=3)
        except Exception:
            pass
        _cleanup_server_proc = None
    _cleanup_loaded_file = ""


def restart_cleanup_server() -> bool:
    """Restart the cleanup llama-server (e.g. after a model switch).

    Readiness is asynchronous, same as at startup: /cleanup "available" stays
    false until the new model finishes loading.
    """
    stop_cleanup_server()
    return start_cleanup_server()


atexit.register(stop_cleanup_server)


# /no_think disables Qwen3's thinking mode (latency); other instruct models
# ignore the token. Few-shot pairs pin down "remove, don't rewrite" — small
# models drift into paraphrasing without them. llama-server KV-caches this
# shared prefix, so only the first request pays for prompt processing.
CLEANUP_SYSTEM_PROMPT = (
    "/no_think You clean up raw speech-to-text transcripts. Rewrite the transcript with:\n"
    "- filler words (um, uh, you know), false starts, and stuttered/repeated words removed\n"
    "- spoken self-corrections resolved, keeping only the corrected version — the speaker "
    "signals these with phrases like \"no wait\", \"I mean\", \"actually\", \"sorry\", "
    "\"scratch that\"; drop both the marker and the words it corrects\n"
    "- punctuation, capitalization, and sentence breaks fixed\n"
    "Never paraphrase, reorder, summarize, or add words — keep the speaker's exact wording "
    "apart from those removals and fixes. Reply with ONLY the cleaned transcript."
)

CLEANUP_EXAMPLES = [
    (
        "so um I think we should uh we should probably start with the the login page",
        "I think we should probably start with the login page.",
    ),
    (
        "send the report to to Sarah no wait send it to Mike by Friday",
        "Send the report to Mike by Friday.",
    ),
    (
        "the demo is on tuesday I mean wednesday at ten",
        "The demo is on Wednesday at ten.",
    ),
    # A correction inside a spoken list — the corrected item replaces the
    # one just before the marker, not the whole list.
    (
        "call extension four seven five I mean six",
        "Call extension four seven six.",
    ),
    (
        "it works fine",
        "It works fine.",
    ),
]


# --- Cleanup styles ---
#
# Each style is a different rewrite flavor through the same llama-server:
# "standard" is the original transcript cleanup; the others restructure the
# dictation toward a target format (Claude Code prompt, commit message, chat
# message, email prose, bug report). One style is active at a time
# (cleanup_settings["style"], PUT /cleanup {"style": ...}) — the PWA exposes
# it as a picker next to the Cleanup pill. "ratio" is the per-style sanity
# window for _cleanup_result_ok: restructuring styles legitimately change
# length more than plain cleanup (a commit summary compresses a ramble),
# so each declares how much shrink/growth is plausible.
#
# NOTE: llama-server KV-caches the system prompt + few-shots per style;
# switching styles re-pays prompt processing once, then it's warm again.

CLEANUP_STYLES: dict[str, dict] = {
    "standard": {
        "label": "Clean up",
        "description": "Remove fillers and false starts, fix punctuation",
        "system": CLEANUP_SYSTEM_PROMPT,
        "examples": CLEANUP_EXAMPLES,
        "ratio": (0.35, 1.6),
    },
    "prompt": {
        "label": "Claude prompt",
        "description": "Restructure the dictation into a crisp coding-assistant prompt",
        "system": (
            "/no_think You turn raw dictated speech into a clear written prompt for a "
            "coding assistant (Claude Code). Rewrite the transcript with:\n"
            "- filler words, false starts, and thinking-out-loud preamble removed\n"
            "- spoken self-corrections resolved, keeping only the corrected version\n"
            "- multi-part requests split into short lines starting with \"- \"\n"
            "- file names, code identifiers, commands, and technical terms kept verbatim\n"
            "Keep every requirement and detail the speaker gave. Never invent requirements, "
            "add pleasantries, or answer the request yourself. Reply with ONLY the "
            "rewritten prompt."
        ),
        "examples": [
            (
                "um so in the whisper server can you uh add a retry to the download "
                "function like three times with backoff and also it should log each failure",
                "In the whisper server, add a retry to the download function:\n"
                "- retry 3 times with backoff\n"
                "- log each failure",
            ),
            (
                "okay refactor the settings view no wait the status bar so the dot "
                "colors come from a single map",
                "Refactor the status bar so the dot colors come from a single map.",
            ),
        ],
        "ratio": (0.3, 2.0),
    },
    "commit": {
        "label": "Commit message",
        "description": "Turn the dictation into a git commit message",
        "system": (
            "/no_think You turn a dictated description of a code change into a git "
            "commit message. The first line is an imperative summary under 72 "
            "characters. Add a short body (after a blank line) only when the speaker "
            "gave details beyond the summary. Remove filler words and false starts, "
            "resolve spoken self-corrections. Never invent details the speaker did "
            "not say. Reply with ONLY the commit message."
        ),
        "examples": [
            (
                "um this fixes the uh the race in the chunk poller where stop could "
                "run before the last snapshot finished",
                "Fix race in chunk poller between stop and the last snapshot\n\n"
                "Stop could run before the last snapshot finished.",
            ),
            (
                "add a dark mode toggle to settings",
                "Add a dark mode toggle to settings",
            ),
        ],
        "ratio": (0.15, 1.6),
    },
    "slack": {
        "label": "Chat message",
        "description": "Casual but tidy chat/Slack message",
        "system": (
            "/no_think You turn raw dictated speech into a tidy chat message (Slack). "
            "Remove filler words, false starts, and stutters; resolve spoken "
            "self-corrections; fix punctuation and capitalization. Keep the speaker's "
            "casual tone and wording — do not formalize, do not add greetings, "
            "sign-offs, or emoji. Reply with ONLY the message."
        ),
        "examples": [
            (
                "hey um can someone take a look at the the staging deploy it's been "
                "stuck for like twenty minutes no wait thirty minutes",
                "Hey, can someone take a look at the staging deploy? It's been stuck "
                "for like thirty minutes.",
            ),
        ],
        "ratio": (0.35, 1.6),
    },
    "email": {
        "label": "Email",
        "description": "Polished professional email prose",
        "system": (
            "/no_think You turn raw dictated speech into polished email prose: "
            "complete sentences, professional tone, paragraphs where natural. Remove "
            "filler words and false starts, resolve spoken self-corrections, fix "
            "punctuation. Keep all of the speaker's content and meaning — do not "
            "summarize, and do not add greetings or sign-offs the speaker did not "
            "say. Reply with ONLY the email text."
        ),
        "examples": [
            (
                "um just following up on the invoice from last week can you uh let me "
                "know when it's been processed thanks",
                "Just following up on the invoice from last week. Could you let me "
                "know when it has been processed? Thanks.",
            ),
        ],
        "ratio": (0.35, 1.8),
    },
    "bug": {
        "label": "Bug report",
        "description": "Structure the dictation into a concise bug report",
        "system": (
            "/no_think You turn a dictated description of a software problem into a "
            "concise bug report. Start with a one-line summary. Then, only using "
            "details the speaker actually gave, add short lines for what happened, "
            "what was expected, and steps or context. Remove filler words and false "
            "starts, resolve spoken self-corrections. Never invent details. Reply "
            "with ONLY the bug report."
        ),
        "examples": [
            (
                "so um when I tap stop right after starting a recording the app just "
                "spins forever it should uh just return no speech detected",
                "Tapping Stop right after starting a recording hangs forever.\n"
                "What happened: the app spins forever.\n"
                "Expected: it returns \"no speech detected\".",
            ),
        ],
        "ratio": (0.3, 2.2),
    },
}


def _active_style() -> str:
    """Name of the active cleanup style, falling back to standard."""
    style = cleanup_settings.get("style")
    return style if isinstance(style, str) and style in CLEANUP_STYLES else "standard"


def _glossary_terms() -> list[str]:
    """Terms the speaker is known to use, derived from word corrections.

    The correction dictionary's *values* are the vocabulary the user actually
    means (names, technical terms). Injected into the cleanup system prompt so
    the LLM can fix contextual mishearings the whole-word regex pass can't —
    e.g. "cloud" vs "Claude" depending on the sentence.
    """
    seen: set[str] = set()
    terms: list[str] = []
    for right in word_corrections.values():
        term = right.strip()
        if term and term.lower() not in seen:
            seen.add(term.lower())
            terms.append(term)
    return terms[:40]


def _strip_think(text: str) -> str:
    """Drop the <think>…</think> block Qwen3 emits even with /no_think."""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def _llm_chat(messages: list[dict], max_tokens: int) -> str:
    """One chat completion against the resident llama-server."""
    payload = {
        "messages": messages,
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        f"http://127.0.0.1:{CLEANUP_SERVER_PORT}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=CLEANUP_TIMEOUT_SEC) as resp:
        result = json.loads(resp.read())
    return _strip_think(result["choices"][0]["message"]["content"])


def _build_cleanup_messages(text: str) -> list[dict]:
    """Build the chat messages for the active style, with the glossary."""
    style = CLEANUP_STYLES[_active_style()]
    system = style["system"]
    glossary = _glossary_terms()
    if glossary:
        # Appended (not prepended) so the static part of the system prompt
        # stays byte-identical across glossary edits.
        system += (
            "\nThe speaker often uses these terms — when a transcribed word is "
            "clearly a mishearing of one of them, use the term instead: "
            + ", ".join(glossary)
        )
    messages = [{"role": "system", "content": system}]
    for raw, cleaned in style["examples"]:
        messages.append({"role": "user", "content": raw})
        messages.append({"role": "assistant", "content": cleaned})
    messages.append({"role": "user", "content": text})
    return messages


def _cleanup_request(text: str) -> str:
    """Ask the llama-server to rewrite one transcript. Returns the raw reply."""
    # Output is at most a bit longer than the input; cap generation so a
    # runaway response can't stall the Stop request for the full timeout.
    # Restructuring styles get more headroom (bullets/sections add characters).
    if _active_style() == "standard":
        max_tokens = max(64, len(text) // 2)
    else:
        max_tokens = max(128, len(text))
    return _llm_chat(_build_cleanup_messages(text), max_tokens)


def _cleanup_result_ok(original: str, cleaned: str, bounds: tuple[float, float] = (0.35, 1.6)) -> bool:
    """Sanity guard: a degenerate LLM response must never replace the
    transcript. Empty output, heavy truncation, or padding with commentary
    all land outside this length window; legitimate cleanup (fillers out,
    punctuation in) stays within it. Bounds are per-style (CLEANUP_STYLES)."""
    if not cleaned:
        return False
    ratio = len(cleaned) / len(original)
    return bounds[0] <= ratio <= bounds[1]


def apply_cleanup(text: str) -> str:
    """Run LLM speech cleanup (in the active style) on a final transcript.

    Returns the input unchanged when cleanup is disabled, symbol mode is on
    (verbatim CLI dictation — the LLM would mangle "/help" or "foo-bar"),
    the llama-server isn't ready, the request fails, or the response flunks
    the sanity guard.
    """
    if not text or not cleanup_settings.get("enabled"):
        return text
    if symbol_settings.get("enabled"):
        add_log("info", "Cleanup skipped (symbol mode is on)")
        return text
    if not _is_cleanup_server_alive():
        add_log("warn", "Cleanup enabled but llama-server not ready — using raw text")
        return text

    style = _active_style()
    t0 = time.time()
    try:
        cleaned = _cleanup_request(text)
    except Exception as e:
        add_log("warn", f"Cleanup failed ({e}) — using raw text")
        return text
    ms = int((time.time() - t0) * 1000)

    if not _cleanup_result_ok(text, cleaned, CLEANUP_STYLES[style]["ratio"]):
        add_log("warn", f"Cleanup [{style}] rejected ({len(text)} -> {len(cleaned)} chars, {ms}ms) — using raw text")
        return text
    if cleaned != text:
        add_log("info", f"Cleanup [{style}] applied ({ms}ms): {text[:60]!r} -> {cleaned[:60]!r}")
    return cleaned


# --- Voice editing (LLM applies a spoken instruction to pending text) ---
#
# Used by the PWA's edit-before-send buffer: the user dictates an instruction
# ("replace Mike with Sarah", "delete the last sentence", "make it more
# formal") and POST /edit applies it to the held transcript before it is
# typed over HID. Same llama-server, own prompt.

EDIT_SYSTEM_PROMPT = (
    "/no_think You apply a spoken editing instruction to a piece of text. The "
    "user message contains the text and the instruction. Apply exactly what the "
    "instruction asks and nothing else — keep all other wording, punctuation, "
    "and formatting unchanged. Never add commentary. If the instruction cannot "
    "be applied to the text, reply with the text unchanged. Reply with ONLY "
    "the edited text."
)

EDIT_EXAMPLES = [
    (
        ("Send the report to Mike by Friday.", "replace Mike with Sarah"),
        "Send the report to Sarah by Friday.",
    ),
    (
        (
            "The fix works. We should ship it tomorrow. I tested it twice.",
            "delete the last sentence",
        ),
        "The fix works. We should ship it tomorrow.",
    ),
    (
        ("hey can you look at the login bug", "make it more formal"),
        "Could you please look at the login bug?",
    ),
]


def _format_edit_input(text: str, command: str) -> str:
    return f"Text:\n{text}\n\nInstruction: {command}"


def _edit_request(text: str, command: str) -> str:
    """Ask the llama-server to apply one edit instruction. Raw reply."""
    messages = [{"role": "system", "content": EDIT_SYSTEM_PROMPT}]
    for (ex_text, ex_command), edited in EDIT_EXAMPLES:
        messages.append({"role": "user", "content": _format_edit_input(ex_text, ex_command)})
        messages.append({"role": "assistant", "content": edited})
    messages.append({"role": "user", "content": _format_edit_input(text, command)})
    # Edits can grow the text ("add ... at the end") but a reply several times
    # the input is a runaway, not an edit.
    return _llm_chat(messages, max_tokens=max(128, len(text)))


# --- Correction suggestions (LLM scans recent transcripts for mishearings) ---

SUGGEST_SYSTEM_PROMPT = (
    "/no_think You review speech-to-text transcripts for recurring "
    "misrecognitions of names and technical terms. Reply with ONLY a JSON "
    "array of corrections, each {\"wrong\": \"<transcribed word>\", "
    "\"right\": \"<intended word>\"}. Only include corrections you are "
    "confident about — words that in context are clearly a mishearing of a "
    "name, product, or technical term. Never include ordinary words used "
    "normally. Reply with [] when there are none."
)


def _remember_transcript(text: str):
    """Keep a final transcript for later correction suggestions."""
    if text and len(text) >= 12:
        recent_transcripts.append(text)


def _suggest_request(transcripts: list[str], existing: dict[str, str]) -> str:
    """Ask the llama-server for correction suggestions. Raw reply."""
    parts = []
    if existing:
        parts.append(
            "Already-known corrections (do not repeat these): "
            + ", ".join(f"{w} -> {r}" for w, r in existing.items())
        )
    parts.append("Transcripts:")
    parts.extend(f"- {t}" for t in transcripts)
    messages = [
        {"role": "system", "content": SUGGEST_SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(parts)},
    ]
    return _llm_chat(messages, max_tokens=512)


def _parse_suggestions(reply: str, existing: dict[str, str]) -> list[dict]:
    """Extract usable {"wrong", "right"} pairs from an LLM reply.

    A malformed reply yields [] — suggestions are advisory, never an error.
    """
    match = re.search(r"\[.*\]", reply, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    existing_lower = {k.lower() for k in existing}
    out: list[dict] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        wrong = item.get("wrong")
        right = item.get("right")
        if not isinstance(wrong, str) or not isinstance(right, str):
            continue
        wrong, right = wrong.strip(), right.strip()
        if not wrong or not right or len(wrong) > 40 or len(right) > 40:
            continue
        if wrong.lower() == right.lower() or wrong.lower() in existing_lower:
            continue
        if wrong.lower() in seen:
            continue
        seen.add(wrong.lower())
        out.append({"wrong": wrong, "right": right})
        if len(out) >= 10:
            break
    return out


# --- Parakeet engine (sherpa-onnx or onnxruntime, in-process) ---

_parakeet_recognizer = None
_parakeet_backend = ""  # "sherpa-onnx" or "onnxruntime"


def find_parakeet_model_files() -> dict | None:
    """Locate the Parakeet ONNX model files under MODEL_DIR.

    Returns a dict of paths (encoder/decoder/joiner/tokens) or None if the
    model is not downloaded. Prefers int8-quantized files, falls back to fp32.
    """
    base = os.path.join(MODEL_DIR, PARAKEET_DIR_NAME)
    if not os.path.isdir(base):
        return None
    for enc, dec, joi in [
        ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx"),
        ("encoder.onnx", "decoder.onnx", "joiner.onnx"),
    ]:
        paths = {
            "encoder": os.path.join(base, enc),
            "decoder": os.path.join(base, dec),
            "joiner": os.path.join(base, joi),
            "tokens": os.path.join(base, "tokens.txt"),
        }
        if all(os.path.isfile(p) for p in paths.values()):
            return paths
    return None


def parakeet_model_size_mb() -> int:
    """Total on-disk size of the Parakeet model directory in MB."""
    base = os.path.join(MODEL_DIR, PARAKEET_DIR_NAME)
    total = 0
    for root, _, files in os.walk(base):
        for fname in files:
            try:
                total += os.path.getsize(os.path.join(root, fname))
            except OSError:
                pass
    return round(total / (1024 * 1024))


def _create_parakeet_recognizer(files: dict):
    """Build a Parakeet recognizer from whichever backend is installed.

    Prefers the sherpa-onnx package (C++ decode loop); falls back to the
    bundled parakeet_onnx module which needs only onnxruntime + numpy
    (both available as prebuilt Termux packages — no pip compilation).
    Returns (recognizer, backend_name).
    """
    try:
        import sherpa_onnx
        recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=files["encoder"],
            decoder=files["decoder"],
            joiner=files["joiner"],
            tokens=files["tokens"],
            num_threads=PARAKEET_THREADS,
            model_type="nemo_transducer",
        )
        return recognizer, "sherpa-onnx"
    except ImportError:
        pass

    from parakeet_onnx import ParakeetOnnxRecognizer
    recognizer = ParakeetOnnxRecognizer(
        encoder=files["encoder"],
        decoder=files["decoder"],
        joiner=files["joiner"],
        tokens=files["tokens"],
        num_threads=PARAKEET_THREADS,
    )
    return recognizer, "onnxruntime"


def load_parakeet() -> bool:
    """Load the Parakeet model (in-process, loaded once).

    Returns True if the recognizer is ready. Safe to call repeatedly.
    """
    global _parakeet_recognizer, _parakeet_backend

    if _parakeet_recognizer is not None:
        return True

    files = find_parakeet_model_files()
    if files is None:
        add_log("info", f"Parakeet model not found in {MODEL_DIR} — run: ./update-model.sh parakeet")
        return False

    t0 = time.time()
    try:
        _parakeet_recognizer, _parakeet_backend = _create_parakeet_recognizer(files)
    except ImportError:
        add_log(
            "warn",
            "No Parakeet backend installed — in Termux run: "
            "pkg install python-numpy python-onnxruntime (or: pip install sherpa-onnx numpy)",
        )
        return False
    except Exception as e:
        add_log("error", f"Failed to load Parakeet model: {e}")
        _parakeet_recognizer = None
        return False

    load_ms = int((time.time() - t0) * 1000)
    add_log("info", f"Parakeet model loaded in {load_ms}ms (backend={_parakeet_backend}, {PARAKEET_THREADS} threads)")
    return True


def unload_parakeet():
    """Release the Parakeet recognizer (frees ~700MB RAM)."""
    global _parakeet_recognizer, _parakeet_backend
    if _parakeet_recognizer is not None:
        _parakeet_recognizer = None
        _parakeet_backend = ""
        add_log("info", "Parakeet model unloaded")


def _read_wav_float32(wav_path: str):
    """Read a 16-bit PCM WAV as (float32 samples in [-1, 1], sample_rate)."""
    import array
    import wave

    with wave.open(wav_path, "rb") as w:
        sample_rate = w.getframerate()
        n_channels = w.getnchannels()
        sample_width = w.getsampwidth()
        frames = w.readframes(w.getnframes())

    if sample_width != 2:
        raise RuntimeError(f"Unsupported WAV sample width: {sample_width} bytes")

    samples = array.array("h", frames)
    if n_channels > 1:
        samples = samples[::n_channels]

    try:
        import numpy as np
        audio = np.asarray(samples, dtype=np.float32) / 32768.0
    except ImportError:
        # sherpa-onnx accepts any buffer of float32 via pybind11
        audio = array.array("f", (s / 32768.0 for s in samples))
    return audio, sample_rate


def run_parakeet_raw(wav_path: str) -> tuple[str, int]:
    """Run Parakeet on a WAV file. Returns (raw text, duration_ms)."""
    if _parakeet_recognizer is None:
        raise RuntimeError("Parakeet model not loaded")

    audio, sample_rate = _read_wav_float32(wav_path)

    t0 = time.time()
    stream = _parakeet_recognizer.create_stream()
    stream.accept_waveform(sample_rate, audio)
    _parakeet_recognizer.decode_stream(stream)
    duration_ms = int((time.time() - t0) * 1000)

    return stream.result.text.strip(), duration_ms


def _encoder_flags(fmt: str) -> list[str]:
    """termux-microphone-record encoder flags for a recording format."""
    if fmt == "amr_wb":
        return ["-e", "amr_wb", "-b", "23850"]
    if fmt == "opus":
        # Android records Opus into an Ogg container (streamable pages).
        return ["-e", "opus"]
    return []  # aac — device default


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


def transcode_to_wav(input_path: str, output_path: str, quiet: bool = False) -> bool:
    """Transcode any audio format to 16kHz mono WAV using ffmpeg.

    When WHISPER_NOISE_REDUCTION=1 is set, applies FFT-based noise reduction
    (afftdn) before transcoding. This helps with noisy environments but adds
    ~100-200ms of processing time.

    quiet=True skips the info logs (used by the chunked-transcription poller,
    which transcodes every couple of seconds and would flood the log buffer).
    """
    input_size = os.path.getsize(input_path) if os.path.isfile(input_path) else 0
    denoise = get_noise_reduction()
    if not quiet:
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
            if not quiet:
                add_log("warn", f"ffmpeg exited {result.returncode}: {result.stderr[-300:]}")
            return False
        out_size = os.path.getsize(output_path) if os.path.isfile(output_path) else 0
        # Extract duration from ffmpeg stderr (e.g. "Duration: 00:00:06.12")
        duration_line = ""
        for line in result.stderr.splitlines():
            if "Duration:" in line:
                duration_line = line.strip()
                break
        if not quiet:
            add_log("info", f"Transcode: output={out_size}B {duration_line}")
        if out_size < 1000:
            if not quiet:
                add_log("warn", f"WAV too small after transcode ({out_size}B) — likely silence or corrupt input")
            return False
        return True
    except subprocess.TimeoutExpired:
        add_log("error", "ffmpeg timed out (30s)")
        return False
    except FileNotFoundError:
        add_log("error", "ffmpeg binary not found")
        return False


# --- Mic bandwidth estimation (Bluetooth SCO codec detection) ---
#
# A Bluetooth headset mic over SCO delivers either 16 kHz mSBC ("wideband
# speech") or 8 kHz CVSD (narrowband). CVSD audio has no content above
# 4 kHz — the consonant range — and transcription accuracy drops hard.
# The phone HAL upsamples the stream, so the WAV sample rate is always
# 16 kHz regardless; the only tell is the spectrum. estimate_bandwidth()
# looks at speech frames of the test recording and reports which one the
# link actually negotiated (or "wideband" for the phone's own mic).

def _fft(x: list[complex]) -> list[complex]:
    """Recursive radix-2 FFT; len(x) must be a power of two."""
    n = len(x)
    if n == 1:
        return x
    even = _fft(x[0::2])
    odd = _fft(x[1::2])
    half = n // 2
    out = [0j] * n
    for k in range(half):
        t = cmath.exp(-2j * math.pi * k / n) * odd[k]
        out[k] = even[k] + t
        out[k + half] = even[k] - t
    return out


BW_FRAME_SIZE = 512          # 32ms at 16 kHz; power of two for the FFT
BW_FRAME_HOP = 256
BW_SPEECH_RMS_FLOOR = 100.0  # frames quieter than this are ignored
BW_MAX_FRAMES = 400          # bound CPU cost on long recordings


def estimate_bandwidth(samples, sample_rate: int = 16000) -> dict:
    """Classify PCM audio as narrowband (<=4 kHz content) or wideband.

    Returns a dict with "verdict" ("narrowband" | "wideband" | "unknown")
    plus the numbers behind it. Two independent signals decide:
    - high_band_ratio: share of speech energy in 4.2-7.8 kHz, aggregated
      over all speech frames. Narrowband audio scores ~0.
    - peak_frame_high_ratio: the single frame with the largest high-band
      share (fricatives like /s/), which stays high even when a dictation
      is vowel-heavy overall.
    Thresholds have wide margins: wideband speech typically scores 10-100x
    above them, upsampled CVSD 10-100x below.
    """
    n = BW_FRAME_SIZE
    if len(samples) < n:
        return {"verdict": "unknown", "reason": "too_short"}

    window = [0.5 - 0.5 * math.cos(2 * math.pi * i / n) for i in range(n)]
    bin_hz = sample_rate / n
    low_bins = range(int(200 / bin_hz) + 1, int(4000 / bin_hz))
    # Gap at 4.0-4.2 kHz keeps the codec's transition band out of both sums.
    high_bins = range(int(4200 / bin_hz) + 1, int(7800 / bin_hz))

    spectrum = [0.0] * (n // 2 + 1)
    speech_frames = 0
    peak_frame_ratio = 0.0
    starts = range(0, len(samples) - n, BW_FRAME_HOP)
    for start in list(starts)[:BW_MAX_FRAMES]:
        frame = samples[start:start + n]
        rms = math.sqrt(sum(s * s for s in frame) / n)
        if rms < BW_SPEECH_RMS_FLOOR:
            continue
        speech_frames += 1
        fx = _fft([frame[i] * window[i] for i in range(n)])
        power = [abs(fx[k]) ** 2 for k in range(n // 2 + 1)]
        for k in range(len(spectrum)):
            spectrum[k] += power[k]
        f_low = sum(power[k] for k in low_bins)
        f_high = sum(power[k] for k in high_bins)
        if f_low + f_high > 0:
            peak_frame_ratio = max(peak_frame_ratio, f_high / (f_low + f_high))

    if speech_frames < 5:
        return {"verdict": "unknown", "reason": "not_enough_speech"}

    low = sum(spectrum[k] for k in low_bins)
    high = sum(spectrum[k] for k in high_bins)
    if low + high <= 0:
        return {"verdict": "unknown", "reason": "no_energy"}
    high_ratio = high / (low + high)

    # Rolloff: frequency below which 97% of the (200 Hz+) energy lies.
    floor_bin = int(200 / bin_hz) + 1
    tail = sum(spectrum[floor_bin:])
    acc = 0.0
    rolloff_hz = sample_rate / 2
    for k in range(floor_bin, len(spectrum)):
        acc += spectrum[k]
        if acc >= 0.97 * tail:
            rolloff_hz = k * bin_hz
            break

    wideband = high_ratio >= 0.015 or peak_frame_ratio >= 0.08
    return {
        "verdict": "wideband" if wideband else "narrowband",
        "high_band_ratio": round(high_ratio, 5),
        "peak_frame_high_ratio": round(peak_frame_ratio, 5),
        "rolloff_hz": round(rolloff_hz),
        "speech_frames": speech_frames,
    }


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

SILENCE_MARKERS = ["[BLANK_AUDIO]", "(silence)", "[silence]"]


def _clean_raw_text(text: str) -> str:
    """Strip silence markers and collapse whitespace — no corrections/symbols.

    Used for per-chunk output in chunked mode, where corrections and symbol
    replacements must run once over the joined text (a phrase could span a
    chunk boundary)."""
    for marker in SILENCE_MARKERS:
        text = text.replace(marker, "")
    return " ".join(text.split())


def _postprocess_text(text: str, source: str) -> str:
    """Shared transcription cleanup: strip silence markers, collapse
    whitespace, apply LLM speech cleanup, word corrections, symbols."""
    text = _clean_raw_text(text)

    if not text:
        add_log("warn", f"{source}: no speech detected")

    # LLM cleanup first, on the speaker's raw wording — corrections and
    # symbol phrases still match afterwards. In chunked mode this runs once
    # on the joined text (chunks are transcribed with postprocess=False), so
    # false starts and self-corrections spanning chunk boundaries are seen
    # whole. apply_cleanup() is a no-op unless enabled, and always falls
    # back to the input on failure.
    if text:
        text = apply_cleanup(text)

    if text and word_corrections:
        corrected = apply_corrections(text)
        if corrected != text:
            add_log("info", f"Corrections applied: {repr(text)} -> {repr(corrected)}")
            text = corrected

    if text and symbol_settings.get("enabled"):
        replaced = apply_symbols(text)
        if replaced != text:
            add_log("info", f"Symbols applied: {repr(text)} -> {repr(replaced)}")
            text = replaced
    return text


def run_transcription(wav_path: str, postprocess: bool = True) -> tuple[str, int]:
    """Transcribe a WAV file with the active engine. Returns (text, duration_ms).

    Uses Parakeet (in-process sherpa-onnx) when active, falling back to
    whisper.cpp if Parakeet is unavailable or fails.

    postprocess=False returns marker-stripped raw text without corrections or
    symbol replacements (chunked mode post-processes the joined text once).
    """
    if active_engine == "parakeet" and _parakeet_recognizer is not None:
        try:
            text, duration_ms = run_parakeet_raw(wav_path)
            add_log("info", f"Parakeet: took={duration_ms}ms")
            if not postprocess:
                return _clean_raw_text(text), duration_ms
            return _postprocess_text(text, "Parakeet"), duration_ms
        except Exception as e:
            add_log("warn", f"Parakeet failed ({e}), falling back to whisper")
    return run_whisper(wav_path, postprocess=postprocess)


def run_whisper(wav_path: str, postprocess: bool = True) -> tuple[str, int]:
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
            if not postprocess:
                return _clean_raw_text(text), duration_ms
            return _postprocess_text(text, "Whisper (server)"), duration_ms
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
    if not postprocess:
        return _clean_raw_text(result.stdout.strip()), duration_ms
    return _postprocess_text(result.stdout.strip(), "Whisper"), duration_ms


# --- Chunked (streaming) transcription ---
#
# PTT recordings are normally transcribed only after the user taps Stop, so a
# long take pays the full engine cost as one wait at the end. When the
# recording file can be decoded while still being written (ADTS AAC or raw
# AMR-WB — probed at startup, MP4-container AAC cannot), a background thread
# snapshots the growing file every couple of seconds, finds silence
# boundaries, and transcribes completed chunks immediately. Tapping Stop then
# only costs the final uncommitted tail. Any failure in this path degrades to
# the plain stop-time transcription — it never breaks a dictation.

CHUNK_POLL_SEC = 2.0        # how often the poller snapshots the recording
# Minimum pause length that ends a chunk. Each chunk is transcribed as an
# independent utterance, so the engine sentence-cases its first word and
# punctuates its end — a chunk split at a mid-sentence thinking pause produces
# "I wonder how quickly It'll take" artifacts in the joined text. 1.2s keeps
# splits at deliberate, sentence-scale pauses; don't lower it back to make
# chunks commit sooner without weighing that cost.
CHUNK_SILENCE_SEC = 1.2
CHUNK_MIN_NEW_SEC = 1.0     # don't commit chunks shorter than this
CHUNK_TAIL_GUARD_SEC = 0.4  # never commit into the (possibly unflushed) tail
CHUNK_FRAME_SEC = 0.03      # analysis frame size for level detection
CHUNK_LEVEL_FLOOR = 120.0   # absolute mean-abs level below which is silence
CHUNK_MIN_SPEECH_SEC = 0.25  # accumulated speech-level time needed to call the engine
CHUNK_LOUD_FACTOR = 3.0     # frames this far above threshold count as speech alone


def _read_wav_pcm(wav_path: str) -> tuple[bytes, int]:
    """Read a 16-bit mono PCM WAV as (raw sample bytes, sample_rate)."""
    import wave

    with wave.open(wav_path, "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise RuntimeError("Expected 16-bit mono WAV")
        return w.readframes(w.getnframes()), w.getframerate()


def _frame_levels(pcm: bytes, sample_rate: int, frame_sec: float = CHUNK_FRAME_SEC) -> list[float]:
    """Mean absolute amplitude per non-overlapping frame of 16-bit PCM."""
    import array

    samples = array.array("h", pcm[: len(pcm) - (len(pcm) % 2)])
    frame = max(1, int(sample_rate * frame_sec))
    n_frames = len(samples) // frame
    if n_frames == 0:
        return []
    try:
        import numpy as np

        arr = np.frombuffer(samples, dtype=np.int16)[: n_frames * frame]
        return np.abs(arr.reshape(n_frames, frame).astype(np.int32)).mean(axis=1).tolist()
    except ImportError:
        levels = []
        for i in range(n_frames):
            chunk = samples[i * frame : (i + 1) * frame]
            levels.append(sum(abs(s) for s in chunk) / frame)
        return levels


def find_commit_boundary(
    levels: list[float],
    frame_sec: float,
    committed_sec: float,
    total_sec: float,
    silence_sec: float = CHUNK_SILENCE_SEC,
    min_new_sec: float = CHUNK_MIN_NEW_SEC,
    tail_guard_sec: float = CHUNK_TAIL_GUARD_SEC,
    level_floor: float = CHUNK_LEVEL_FLOOR,
    min_speech_sec: float = CHUNK_MIN_SPEECH_SEC,
    loud_factor: float = CHUNK_LOUD_FACTOR,
) -> tuple[float, bool] | None:
    """Find a safe point to commit transcription up to.

    Scans frame levels after committed_sec for silence runs (level below an
    adaptive threshold) of at least silence_sec, staying tail_guard_sec away
    from the end of the decoded audio (the encoder may not have flushed it).
    Returns (boundary_sec, segment_has_speech) for the LAST qualifying silence
    run — committing as much audio as possible per poll — or None if there is
    no qualifying boundary yet.
    """
    if not levels:
        return None

    # Adaptive silence threshold: a multiple of the quiet end (p10 ~ room
    # noise), capped by a fraction of the loud end (p95 ~ speech) so that a
    # buffer with few or no pauses doesn't push the threshold into speech
    # levels. level_floor keeps digital near-silence classified as silence.
    sorted_levels = sorted(levels)
    p10 = sorted_levels[int(0.10 * (len(sorted_levels) - 1))]
    p95 = sorted_levels[int(0.95 * (len(sorted_levels) - 1))]
    threshold = max(level_floor, min(3.0 * p10, 0.2 * p95))

    end_limit = min(total_sec, len(levels) * frame_sec) - tail_guard_sec
    if end_limit - committed_sec < min_new_sec:
        return None

    first_frame = max(0, int(committed_sec / frame_sec))
    last_frame = min(len(levels), int(end_limit / frame_sec))

    boundary = None
    run_start = None
    for i in range(first_frame, last_frame + 1):
        is_silent = i < last_frame and levels[i] < threshold
        if is_silent and run_start is None:
            run_start = i
        elif not is_silent and run_start is not None:
            run_len_sec = (i - run_start) * frame_sec
            if run_len_sec >= silence_sec:
                boundary = (run_start + i) / 2 * frame_sec
            run_start = None

    if boundary is None or boundary - committed_sec < min_new_sec:
        return None

    # Breath noise and room-sound transients push isolated frames above the
    # silence threshold, so "any frame above threshold" wastes engine calls on
    # chunks that transcribe to nothing. Require the above-threshold frames to
    # accumulate to min_speech_sec (not necessarily consecutive) — but a frame
    # loud enough (loud_factor x threshold) counts as speech on its own, so a
    # short sharp word ("No!") is never dropped. A false "speech" costs one
    # brief engine call; a false "silence" loses words permanently.
    segment = levels[first_frame : min(int(boundary / frame_sec), len(levels))]
    speech_sec = frame_sec * sum(1 for lv in segment if lv >= threshold)
    has_speech = speech_sec >= min_speech_sec or any(
        lv >= loud_factor * threshold for lv in segment
    )
    return boundary, has_speech


def _write_wav_slice(src_wav: str, dst_wav: str, start_sec: float, end_sec: float | None) -> float:
    """Write [start_sec, end_sec) of a WAV to a new file. Returns slice seconds."""
    import wave

    with wave.open(src_wav, "rb") as src:
        rate = src.getframerate()
        n_total = src.getnframes()
        start = min(n_total, max(0, int(start_sec * rate)))
        end = n_total if end_sec is None else min(n_total, max(start, int(end_sec * rate)))
        src.setpos(start)
        frames = src.readframes(end - start)
        with wave.open(dst_wav, "wb") as dst:
            dst.setparams(src.getparams())
            dst.writeframes(frames)
    return (end - start) / rate


class ChunkedSession:
    """Background transcriber for an in-progress PTT recording.

    Snapshots the growing recording file on a timer, decodes it, and
    transcribes up to the last silence boundary. State (texts, committed_sec,
    engine_ms) is only mutated by the poller thread; readers must call
    finish() first.
    """

    def __init__(self, audio_file: str):
        self.audio_file = audio_file
        self.committed_sec = 0.0
        self.texts: list[str] = []
        self.engine_ms = 0
        self.chunks = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="chunked-transcriber"
        )

    def start(self):
        self._thread.start()

    def finish(self, timeout: float = 30.0) -> bool:
        """Stop the poller and wait for it. Returns True if it exited cleanly."""
        self._stop.set()
        self._thread.join(timeout=timeout)
        return not self._thread.is_alive()

    def has_results(self) -> bool:
        return bool(self.texts) or self.committed_sec > 0.5

    def _run(self):
        while not self._stop.wait(CHUNK_POLL_SEC):
            try:
                self._poll_once()
            except Exception as e:
                add_log("warn", f"Chunked: poller failed ({e}) — remaining audio will be transcribed at stop")
                return

    def _poll_once(self):
        if not os.path.isfile(self.audio_file) or os.path.getsize(self.audio_file) < 4096:
            return
        snap = self.audio_file + ".part"
        wav = snap + ".wav"
        chunk_wav = snap + ".chunk.wav"
        try:
            # Snapshot first: ffmpeg reading the live file races the encoder.
            shutil.copyfile(self.audio_file, snap)
            if not transcode_to_wav(snap, wav, quiet=True):
                return  # header not flushed yet — retry next poll
            pcm, rate = _read_wav_pcm(wav)
            levels = _frame_levels(pcm, rate)
            found = find_commit_boundary(
                levels, CHUNK_FRAME_SEC, self.committed_sec, len(pcm) / 2 / rate
            )
            if found is None:
                return
            boundary, has_speech = found
            if has_speech:
                _write_wav_slice(wav, chunk_wav, self.committed_sec, boundary)
                with transcribe_lock:
                    if self._stop.is_set():
                        return  # stop already ran; leave the tail to it
                    text, ms = run_transcription(chunk_wav, postprocess=False)
                self.engine_ms += ms
                self.chunks += 1
                if text:
                    self.texts.append(text)
                add_log(
                    "info",
                    f"Chunked: committed {self.committed_sec:.1f}-{boundary:.1f}s "
                    f"({ms}ms) -> {text[:60]!r}",
                )
            else:
                add_log("info", f"Chunked: skipped silence {self.committed_sec:.1f}-{boundary:.1f}s")
            self.committed_sec = boundary
        finally:
            for p in (snap, wav, chunk_wav):
                try:
                    os.unlink(p)
                except OSError:
                    pass


def _finish_chunked_transcription(session: "ChunkedSession", wav_path: str) -> tuple[str, int]:
    """Transcribe the uncommitted tail of a chunked session and assemble the
    final text. Must be called with transcribe_lock held and the session's
    poller already finished."""
    tail_wav = wav_path + ".tail.wav"
    try:
        tail_sec = _write_wav_slice(wav_path, tail_wav, session.committed_sec, None)
        if tail_sec > 0.1:
            tail_text, tail_ms = run_transcription(tail_wav, postprocess=False)
        else:
            tail_text, tail_ms = "", 0
    finally:
        try:
            os.unlink(tail_wav)
        except OSError:
            pass

    parts = [t for t in [*session.texts, tail_text] if t]
    text = _postprocess_text(" ".join(parts), "Chunked")
    add_log(
        "info",
        f"Chunked: {session.chunks} chunk(s) pre-transcribed "
        f"({session.engine_ms}ms), tail {tail_sec:.1f}s ({tail_ms}ms)",
    )
    return text, session.engine_ms + tail_ms


def probe_partial_decode(fmt: str, ext: str) -> bool:
    """Check whether a recording in the given format can be decoded while the
    recorder is still writing it (required for chunked transcription).

    Records for ~2.5s, copies the in-progress file, and tries to ffmpeg-decode
    the copy. ADTS AAC, raw AMR-WB, and Ogg Opus pass; MP4-family containers
    fail (the moov atom is only written when the recording stops).
    """
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, f"probe.{ext}")
        snap = os.path.join(td, f"snap.{ext}")
        wav = os.path.join(td, "probe.wav")
        rec_cmd = ["termux-microphone-record", "-f", raw, "-l", "0"]
        rec_cmd += _encoder_flags(fmt)
        try:
            subprocess.run(rec_cmd, timeout=5)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return False
        ok = False
        try:
            time.sleep(2.5)
            if os.path.isfile(raw) and os.path.getsize(raw) > 0:
                shutil.copyfile(raw, snap)
                r = subprocess.run(
                    ["ffmpeg", "-y", "-i", snap, "-ar", "16000", "-ac", "1",
                     "-c:a", "pcm_s16le", wav],
                    capture_output=True, timeout=10,
                )
                # Require ≥0.5s of decoded audio (16kHz mono s16 = 32000 B/s)
                ok = r.returncode == 0 and os.path.isfile(wav) and os.path.getsize(wav) > 16000
        finally:
            try:
                subprocess.run(["termux-microphone-record", "-q"], timeout=5)
                time.sleep(0.5)
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass
        return ok


def detect_chunked_support():
    """Decide whether chunked transcription is possible on this device.

    Probes the detected recording format first; if that isn't
    partial-decodable (typical when Android wraps recordings in an MP4-family
    container), tries AMR-WB (raw .amr streams are readable mid-write) and
    then Opus (Android records Opus into Ogg, which is written as
    self-contained pages), switching the recording format to whichever
    passes. Both are speech-appropriate: the engines consume 16kHz mono
    regardless.
    """
    global chunked_supported, audio_format, audio_ext

    if STT_CHUNKED == "off":
        add_log("info", "Chunked transcription: disabled (STT_CHUNKED=off)")
        return
    if probe_partial_decode(audio_format, audio_ext):
        chunked_supported = True
        add_log("info", f"Chunked transcription: enabled ({audio_format} decodes mid-recording)")
        return
    for fmt, ext in (("amr_wb", "amr"), ("opus", "ogg")):
        if fmt == audio_format:
            continue
        if probe_partial_decode(fmt, ext):
            audio_format, audio_ext = fmt, ext
            chunked_supported = True
            add_log("info", f"Chunked transcription: enabled — switched recording format to {fmt} "
                            "(the default format on this device can't be decoded mid-write)")
            return
    add_log("info", "Chunked transcription: unavailable (recordings can't be decoded mid-write)")


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

                text, duration_ms = run_transcription(wav_path)
                wav_size = os.path.getsize(wav_path)
                audio_duration_sec = round((wav_size - 44) / 32000, 1)  # 16kHz mono PCM
                speed_ratio = round(audio_duration_sec / (duration_ms / 1000), 1) if duration_ms > 0 else 0
                add_log("info", f'Transcribed {duration_ms}ms ({speed_ratio}x) -> "{text[:80]}"')
                _remember_transcript(text)
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
        global recording_process, recording_file, chunk_session

        if recording_process is not None:
            return jsonify({"ok": False, "error": "already_recording", "message": "Already recording."}), 409

        recording_file = tempfile.mktemp(suffix=f".{audio_ext}")
        try:
            rec_cmd = [
                "termux-microphone-record",
                "-f", recording_file,
                "-l", "0",     # unlimited duration
            ]
            rec_cmd += _encoder_flags(audio_format)
            add_log("info", f"Recording cmd: {' '.join(rec_cmd)}")
            recording_process = subprocess.Popen(rec_cmd)
            add_log("info", f"Recording started: {recording_file}")
            print(f"Recording started: {recording_file}")
            if chunked_supported:
                chunk_session = ChunkedSession(recording_file)
                chunk_session.start()
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
        global recording_process, recording_file, chunk_session

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
        session = chunk_session
        chunk_session = None

    # Stop the chunk poller BEFORE taking transcribe_lock — an in-flight
    # chunk transcription needs that lock to complete.
    if session is not None and not session.finish():
        add_log("warn", "Chunked: poller did not stop in time — falling back to full-file transcription")
        session = None

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

            chunked_used = session is not None and session.has_results()
            if chunked_used:
                text, duration_ms = _finish_chunked_transcription(session, wav_path)
            else:
                text, duration_ms = run_transcription(wav_path)
            wav_size = os.path.getsize(wav_path)
            audio_duration_sec = round((wav_size - 44) / 32000, 1)  # 16kHz mono PCM
            speed_ratio = round(audio_duration_sec / (duration_ms / 1000), 1) if duration_ms > 0 else 0
            add_log("info", f'PTT transcribed {duration_ms}ms ({speed_ratio}x) -> "{text[:80]}"')
            _remember_transcript(text)
            payload = {
                "text": text,
                "duration_ms": duration_ms,
                "audio_duration_sec": audio_duration_sec,
                "speed_ratio": speed_ratio,
            }
            if chunked_used:
                payload["chunked"] = True
                payload["chunks"] = session.chunks + 1
            return jsonify(payload)
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
            "engine": active_engine,
            "engine_backend": _parakeet_backend if active_engine == "parakeet" else "whisper.cpp",
            "model": model_name,
            "model_size_mb": model_size_mb,
            "recording": is_recording,
            "whisper_server_mode": _is_whisper_server_alive(),
            "symbol_mode": bool(symbol_settings.get("enabled")),
            "cleanup_mode": bool(cleanup_settings.get("enabled")),
            "cleanup_available": _is_cleanup_server_alive(),
            "cleanup_style": _active_style(),
            "chunked": chunked_supported,
        })
    else:
        return jsonify({
            "status": "error",
            "version": SERVER_VERSION,
            "engine": active_engine,
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

    diag = {"audio_format": audio_format, "audio_ext": audio_ext, "engine": active_engine, "steps": []}

    with tempfile.TemporaryDirectory() as td:
        raw_file = os.path.join(td, f"test.{audio_ext}")
        wav_file = os.path.join(td, "test.wav")

        # Step 1: Record 3 seconds
        rec_cmd = ["termux-microphone-record", "-f", raw_file, "-l", "3"]
        rec_cmd += _encoder_flags(audio_format)
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
                bandwidth = estimate_bandwidth(samples)
                diag["mic_bandwidth"] = bandwidth
                diag["steps"].append({
                    "step": "audio_analysis",
                    "num_samples": len(samples),
                    "duration_sec": round(len(samples) / 16000, 2),
                    "max_amplitude": max_amp,
                    "avg_amplitude": round(avg_amp, 1),
                    "max_amplitude_pct": round(max_amp / 32768 * 100, 1),
                    "silent": max_amp < 100,
                    "bandwidth": bandwidth,
                })
        except Exception as e:
            diag["steps"].append({"step": "audio_analysis", "error": str(e)})

        # Step 4: Run the active transcription engine
        if active_engine == "parakeet" and _parakeet_recognizer is not None:
            try:
                raw_text, engine_ms = run_parakeet_raw(wav_file)
                diag["steps"].append({
                    "step": "parakeet",
                    "duration_ms": engine_ms,
                    "raw_text": raw_text[:500],
                })
            except Exception as e:
                diag["steps"].append({"step": "parakeet", "error": str(e)})
                return jsonify(diag), 500
        else:
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
            raw_text = whisper_result.stdout.strip()

        # Final text
        text = raw_text
        for marker in SILENCE_MARKERS:
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


@app.route("/symbols", methods=["GET"])
def get_symbols():
    """Return the symbol replacement config: {"enabled": bool, "entries": [...]}."""
    return jsonify(symbol_settings)


@app.route("/symbols", methods=["PUT"])
def put_symbols():
    """Update the symbol replacement config.

    Body keys are optional and merged:
      {"enabled": bool, "entries": [{"phrase", "symbol", "spacing"?}]}
    Omitted keys keep their current value, so the PWA toggle can flip
    "enabled" without resending the entry list.
    """
    data = request.get_json(silent=True)
    if data is None or not isinstance(data, dict):
        return jsonify({"error": "invalid_body", "message": "Request body must be a JSON object."}), 400

    if "enabled" in data and not isinstance(data["enabled"], bool):
        return jsonify({"error": "invalid_value", "message": "'enabled' must be a boolean."}), 400

    if "entries" in data:
        entries = data["entries"]
        if not isinstance(entries, list) or not all(_valid_symbol_entry(e) for e in entries):
            return jsonify({
                "error": "invalid_entry",
                "message": "Each entry needs a non-empty 'phrase' and 'symbol', "
                           f"and 'spacing' must be one of {list(SYMBOL_SPACINGS)}.",
            }), 400

    if "enabled" in data:
        symbol_settings["enabled"] = data["enabled"]
    if "entries" in data:
        symbol_settings["entries"] = [_normalize_symbol_entry(e) for e in data["entries"]]

    save_symbols()
    add_log("info", f"Symbol replacements updated: enabled={symbol_settings['enabled']}, {len(symbol_settings['entries'])} entries")
    return jsonify(symbol_settings)


@app.route("/symbols/reset", methods=["POST"])
def reset_symbols():
    """Restore the default symbol entries (keeps the enabled flag)."""
    symbol_settings["entries"] = [dict(e) for e in DEFAULT_SYMBOLS]
    save_symbols()
    add_log("info", "Symbol replacements reset to defaults")
    return jsonify(symbol_settings)


# --- Speech cleanup (toggle, style, model) ---

def _cleanup_models() -> list[dict]:
    """Catalog of known cleanup models with download/active status."""
    active_file = active_cleanup_model_file()
    models = []
    seen = set()
    for entry in CLEANUP_MODEL_CATALOG:
        downloaded = _cleanup_model_present(entry["file"])
        seen.add(entry["file"])
        models.append({
            **entry,
            "downloaded": downloaded,
            "active": downloaded and entry["file"] == active_file,
        })
    # A custom CLEANUP_MODEL env var outside the catalog still shows up.
    if CLEANUP_MODEL_FILE not in seen:
        downloaded = _cleanup_model_present(CLEANUP_MODEL_FILE)
        size_mb = 0
        if downloaded:
            size_mb = round(os.path.getsize(os.path.join(MODEL_DIR, CLEANUP_MODEL_FILE)) / (1024 * 1024))
        models.append({
            "name": CLEANUP_MODEL_FILE,
            "file": CLEANUP_MODEL_FILE,
            "size_mb": size_mb,
            "description": "Custom (CLEANUP_MODEL env var)",
            "downloaded": downloaded,
            "active": downloaded and CLEANUP_MODEL_FILE == active_file,
        })
    return models


def _cleanup_state() -> dict:
    return {
        "enabled": bool(cleanup_settings.get("enabled")),
        "available": _is_cleanup_server_alive(),
        "model": active_cleanup_model_file() if find_cleanup_model() else None,
        "models": _cleanup_models(),
        "style": _active_style(),
        "styles": [
            {"name": name, "label": s["label"], "description": s["description"]}
            for name, s in CLEANUP_STYLES.items()
        ],
    }


@app.route("/cleanup", methods=["GET"])
def get_cleanup():
    """Return the speech cleanup state:
    {"enabled", "available", "model", "models", "style", "styles"}."""
    return jsonify(_cleanup_state())


@app.route("/cleanup", methods=["PUT"])
def put_cleanup():
    """Update speech cleanup settings — partial merge like PUT /symbols.

    Body keys (each optional, at least one required):
      "enabled": bool — apply cleanup to transcripts
      "style":   str  — a CLEANUP_STYLES name (rewrite flavor)
      "model":   str  — a CLEANUP_MODEL_CATALOG name; restarts the
                        llama-server with that GGUF ("available" stays false
                        until the new model finishes loading)
    """
    data = request.get_json(silent=True)
    if data is None or not isinstance(data, dict) or not any(
        k in data for k in ("enabled", "style", "model")
    ):
        return jsonify({
            "error": "invalid_body",
            "message": "Request body must be JSON with 'enabled', 'style', and/or 'model'.",
        }), 400

    if "enabled" in data and not isinstance(data["enabled"], bool):
        return jsonify({"error": "invalid_value", "message": "'enabled' must be a boolean."}), 400
    if "style" in data and data["style"] not in CLEANUP_STYLES:
        return jsonify({
            "error": "invalid_style",
            "message": f"'style' must be one of {sorted(CLEANUP_STYLES)}.",
        }), 400
    if "model" in data:
        entry = _cleanup_model_by_name(data["model"]) if isinstance(data["model"], str) else None
        if entry is None:
            return jsonify({
                "error": "invalid_model",
                "message": f"'model' must be one of {[m['name'] for m in CLEANUP_MODEL_CATALOG]}.",
            }), 400
        if not _cleanup_model_present(entry["file"]):
            return jsonify({
                "error": "model_not_found",
                "message": f"Model not downloaded. In Termux run: ./update-model.sh cleanup-4b"
                if entry["name"] == "qwen3-4b"
                else f"Model not downloaded. In Termux run: ./update-model.sh cleanup",
            }), 404

    if "enabled" in data:
        cleanup_settings["enabled"] = data["enabled"]
        add_log("info", f"Speech cleanup {'enabled' if data['enabled'] else 'disabled'}")
    if "style" in data:
        cleanup_settings["style"] = data["style"]
        add_log("info", f"Cleanup style set to: {data['style']}")

    model_changed = False
    if "model" in data:
        entry = _cleanup_model_by_name(data["model"])
        previous_file = active_cleanup_model_file()
        cleanup_settings["model"] = data["model"]
        model_changed = entry["file"] != previous_file or (
            _cleanup_loaded_file and _cleanup_loaded_file != entry["file"]
        )

    save_cleanup_settings()

    if model_changed and STT_CLEANUP != "off":
        add_log("info", f"Cleanup model switched to: {cleanup_settings['model']} — restarting llama-server")
        restart_cleanup_server()

    return jsonify(_cleanup_state())


@app.route("/edit", methods=["POST"])
def edit_text():
    """Apply a spoken editing instruction to a piece of text via the LLM.

    Body: {"text": "...", "command": "replace Mike with Sarah"}
    Returns {"text": <edited>}. The caller keeps its original text on any
    error — this endpoint never partially applies an edit.
    """
    data = request.get_json(silent=True)
    if (
        data is None
        or not isinstance(data, dict)
        or not isinstance(data.get("text"), str)
        or not isinstance(data.get("command"), str)
        or not data["text"].strip()
        or not data["command"].strip()
    ):
        return jsonify({
            "error": "invalid_body",
            "message": "Request body must be JSON with non-empty 'text' and 'command' strings.",
        }), 400

    if not _is_cleanup_server_alive():
        return jsonify({
            "error": "llm_unavailable",
            "message": "Cleanup LLM is not running or still loading.",
        }), 503

    text = data["text"]
    command = data["command"].strip()
    t0 = time.time()
    try:
        edited = _edit_request(text, command)
    except Exception as e:
        add_log("warn", f"Voice edit failed ({e})")
        return jsonify({"error": "edit_failed", "message": str(e)}), 502
    ms = int((time.time() - t0) * 1000)

    # Degenerate-reply guard: empty output or runaway growth is not an edit.
    # (Shrinkage is legitimate — "delete everything after the first line".)
    if not edited or len(edited) > 4 * (len(text) + len(command)) + 64:
        add_log("warn", f"Voice edit rejected ({len(text)} -> {len(edited)} chars, {ms}ms)")
        return jsonify({"error": "edit_rejected", "message": "The model returned a degenerate edit."}), 502

    add_log("info", f"Voice edit applied ({ms}ms): {command[:60]!r}")
    return jsonify({"text": edited, "duration_ms": ms})


@app.route("/corrections/suggest", methods=["POST"])
def suggest_corrections():
    """Ask the LLM to propose word corrections from recent transcripts.

    Returns {"suggestions": [{"wrong", "right"}, ...], "transcripts": N}.
    Suggestions are advisory — nothing is saved until the user accepts one
    (the PWA then PUTs the updated dictionary as usual).
    """
    transcripts = list(recent_transcripts)
    if not transcripts:
        return jsonify({"suggestions": [], "transcripts": 0})

    if not _is_cleanup_server_alive():
        return jsonify({
            "error": "llm_unavailable",
            "message": "Cleanup LLM is not running or still loading.",
        }), 503

    try:
        reply = _suggest_request(transcripts, word_corrections)
    except Exception as e:
        add_log("warn", f"Correction suggestions failed ({e})")
        return jsonify({"error": "suggest_failed", "message": str(e)}), 502

    suggestions = _parse_suggestions(reply, word_corrections)
    add_log("info", f"Correction suggestions: {len(suggestions)} from {len(transcripts)} transcripts")
    return jsonify({"suggestions": suggestions, "transcripts": len(transcripts)})


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

    # Determine which models to benchmark. Parakeet runs through its own
    # in-process engine, not whisper-cli, so it's handled separately.
    all_models = list_models()
    downloaded = [m for m in all_models if m["downloaded"]]
    if not downloaded:
        return jsonify({"error": "no_models", "message": "No models downloaded."}), 400

    if requested_models:
        selected = [m for m in downloaded if m["name"] in requested_models]
        if not selected:
            return jsonify({"error": "no_matching_models", "message": "None of the requested models are downloaded."}), 400
    else:
        selected = downloaded

    targets = [m for m in selected if m["name"] != PARAKEET_MODEL_NAME]
    parakeet_target = next((m for m in selected if m["name"] == PARAKEET_MODEL_NAME), None)

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
            rec_cmd = ["termux-microphone-record", "-f", raw_file, "-l", str(duration)]
            rec_cmd += _encoder_flags(audio_format)
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

        # Benchmark Parakeet via its in-process engine
        if parakeet_target is not None:
            add_log("info", f"Benchmarking {PARAKEET_MODEL_NAME}...")
            try:
                if not load_parakeet():
                    raise RuntimeError("Parakeet engine unavailable (sherpa-onnx not installed?)")
                text, inference_ms = run_parakeet_raw(wav_path)
                speed_ratio = round(audio_duration_sec / (inference_ms / 1000), 1) if inference_ms > 0 else 0
                results.append({
                    "model": PARAKEET_MODEL_NAME,
                    "size_mb": parakeet_target["size_mb"],
                    "text": text,
                    "inference_ms": inference_ms,
                    "speed_ratio": speed_ratio,
                    "error": None,
                })
                add_log("info", f"Benchmark {PARAKEET_MODEL_NAME}: {inference_ms}ms, {speed_ratio}x, \"{text[:60]}\"")
            except Exception as e:
                results.append({
                    "model": PARAKEET_MODEL_NAME,
                    "size_mb": parakeet_target["size_mb"],
                    "text": "",
                    "inference_ms": 0,
                    "speed_ratio": 0,
                    "error": str(e),
                })
                add_log("error", f"Benchmark {PARAKEET_MODEL_NAME} failed: {e}")
            finally:
                # Don't keep ~700MB of Parakeet in RAM if whisper is the active engine
                if active_engine != "parakeet":
                    unload_parakeet()

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

    # Parakeet engine (sherpa-onnx model directory, not a ggml file)
    parakeet_downloaded = find_parakeet_model_files() is not None
    models.append({
        "name": PARAKEET_MODEL_NAME,
        "file": PARAKEET_DIR_NAME,
        "size_mb": parakeet_model_size_mb() if parakeet_downloaded else PARAKEET_CATALOG_SIZE_MB,
        "description": "NVIDIA Parakeet via sherpa-onnx — faster and more accurate than whisper",
        "downloaded": parakeet_downloaded,
        "active": active_engine == "parakeet",
    })

    return models


@app.route("/models", methods=["GET"])
def get_models():
    """List known Whisper models with download and active status."""
    return jsonify({"models": list_models()})


@app.route("/model", methods=["PUT"])
def put_model():
    """Switch the active model — a Whisper model or the Parakeet engine.

    Body: {"model": "small.en"}  (the model name, not the filename)
    """
    global model_path, model_name, model_size_mb, model_loaded, active_engine

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

    # Switch to the Parakeet engine
    if requested == PARAKEET_MODEL_NAME:
        if find_parakeet_model_files() is None:
            return jsonify({
                "error": "model_not_found",
                "message": f"Parakeet model not found. Run: ./update-model.sh parakeet",
            }), 404
        if not load_parakeet():
            return jsonify({
                "error": "engine_unavailable",
                "message": "No Parakeet backend. In Termux run: pkg install python-numpy python-onnxruntime",
            }), 500

        active_engine = "parakeet"
        model_name = PARAKEET_MODEL_NAME
        model_size_mb = parakeet_model_size_mb()
        model_loaded = True
        # Free whisper-server RAM — whisper falls back to subprocess mode if needed
        stop_whisper_server()
        add_log("info", f"Engine switched to: parakeet ({model_size_mb} MB)")
        return jsonify({
            "ok": True,
            "model": model_name,
            "model_size_mb": model_size_mb,
        })

    # Switch to a Whisper model
    new_file = f"ggml-{requested}.bin"
    new_path = os.path.join(MODEL_DIR, new_file)

    if not os.path.isfile(new_path):
        return jsonify({
            "error": "model_not_found",
            "message": f"Model file not found: {new_file}",
        }), 404

    was_parakeet = active_engine == "parakeet"
    active_engine = "whisper"
    model_path = new_path
    model_name = requested
    model_size_mb = round(os.path.getsize(new_path) / (1024 * 1024))
    model_loaded = True
    add_log("info", f"Model switched to: {model_name} ({model_size_mb} MB)")

    # Free Parakeet RAM when leaving the parakeet engine
    if was_parakeet:
        unload_parakeet()

    # (Re)start the persistent whisper-server with the new model
    restart_whisper_server(new_path)

    return jsonify({
        "ok": True,
        "model": model_name,
        "model_size_mb": model_size_mb,
    })


# --- Main ---

def select_engine():
    """Pick the transcription engine at startup.

    Prefers Parakeet (faster + more accurate) when its model and sherpa-onnx
    are available, unless STT_ENGINE=whisper forces whisper.cpp.
    """
    global active_engine, model_name, model_size_mb, model_loaded

    if STT_ENGINE in ("auto", "parakeet") and load_parakeet():
        active_engine = "parakeet"
        model_name = PARAKEET_MODEL_NAME
        model_size_mb = parakeet_model_size_mb()
        model_loaded = True
        add_log("info", f"Engine: parakeet ({model_name}, {model_size_mb} MB)")
        return

    if STT_ENGINE == "parakeet":
        add_log("error", "STT_ENGINE=parakeet but Parakeet is unavailable — falling back to whisper")

    active_engine = "whisper"
    add_log("info", f"Engine: whisper ({model_name or 'no model'})")


if __name__ == "__main__":
    _init_runtime_settings()
    load_corrections()
    load_symbols()
    load_cleanup_settings()
    load_model()
    select_engine()
    detect_audio_format()
    detect_chunked_support()

    whisper_bin = WHISPER_BIN or find_whisper_bin()
    if whisper_bin:
        add_log("info", f"Whisper binary: {whisper_bin}")
    elif active_engine == "whisper":
        add_log("error", "Whisper binary not found — transcription will fail")

    # Persistent whisper-server (model loaded once, fast inference) only makes
    # sense when whisper is the active engine — Parakeet is already in-process.
    if model_loaded and active_engine == "whisper":
        if start_whisper_server(model_path):
            add_log("info", "Using persistent whisper-server mode (model loaded once)")
        else:
            add_log("info", "Using subprocess mode (model loaded per request)")

    # Resident cleanup LLM — started regardless of the runtime toggle so
    # flipping cleanup on never pays a model-load wait mid-dictation.
    if STT_CLEANUP != "off":
        start_cleanup_server()
    else:
        add_log("info", "Speech cleanup: disabled (STT_CLEANUP=off)")

    add_log("info", f"Server starting on port {PORT}")
    app.run(host="127.0.0.1", port=PORT, threaded=True)
