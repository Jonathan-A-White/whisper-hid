#!/data/data/com.termux/files/usr/bin/bash
# start-stt.sh — Main speech-to-text loop
#
# Records microphone audio in chunks, transcribes each chunk with whisper.cpp,
# and writes the resulting text lines to a TCP socket on localhost:9876.
# The Kotlin app reads from that socket and sends keystrokes over Bluetooth.
#
# Usage: bash scripts/start-stt.sh [options]
#   --model <name>    Model name without extension (default: base.en)
#   --port  <num>     TCP port for the Kotlin app (default: 9876)
#   --chunk <sec>     Audio chunk length in seconds (default: 5)
#   --overlap <sec>   Chunk overlap in seconds (default: 0)
#   --lang  <code>    Whisper language code (default: en)
#   --tmux            Run inside a new tmux session (survives screen-off)
#   --stream          Prefer stream mode over chunked mode (experimental)
#
# The script chooses the audio capture method automatically:
#   - If stream binary exists and --stream is passed, uses whisper stream mode
#   - Otherwise uses termux-microphone-record + chunked whisper main

set -euo pipefail

# ─────────────────────────────────────────────
# Parse arguments
# ─────────────────────────────────────────────
MODEL_NAME="base.en"
PORT=9876
CHUNK_SEC=5
OVERLAP_SEC=0
LANG="en"
USE_TMUX=0
USE_STREAM=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)   MODEL_NAME="$2";  shift 2 ;;
        --port)    PORT="$2";         shift 2 ;;
        --chunk)   CHUNK_SEC="$2";    shift 2 ;;
        --overlap) OVERLAP_SEC="$2";  shift 2 ;;
        --lang)    LANG="$2";         shift 2 ;;
        --tmux)    USE_TMUX=1;        shift   ;;
        --stream)  USE_STREAM=1;      shift   ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
WHISPER_DIR="$REPO_DIR/whisper.cpp"
MODEL_PATH="$REPO_DIR/models/ggml-${MODEL_NAME}.bin"
WHISPER_MAIN="$WHISPER_DIR/build/bin/main"
WHISPER_STREAM="$WHISPER_DIR/build/bin/stream"
SESSION_NAME="whisper-stt"

# ─────────────────────────────────────────────
# Validate environment
# ─────────────────────────────────────────────
if [ ! -f "$WHISPER_MAIN" ]; then
    echo "[ERROR] whisper.cpp binary not found at: $WHISPER_MAIN" >&2
    echo "        Run scripts/setup-termux.sh first." >&2
    exit 1
fi

if [ ! -f "$MODEL_PATH" ]; then
    echo "[ERROR] Model file not found: $MODEL_PATH" >&2
    echo "        Run: bash scripts/update-model.sh $MODEL_NAME" >&2
    exit 1
fi

# ─────────────────────────────────────────────
# Re-launch inside tmux if requested
# ─────────────────────────────────────────────
if [ "$USE_TMUX" = "1" ] && [ -z "${TMUX:-}" ]; then
    echo "[INFO] Starting tmux session: $SESSION_NAME"
    tmux new-session -d -s "$SESSION_NAME" \
        "bash '$SCRIPT_DIR/start-stt.sh' --model '$MODEL_NAME' --port '$PORT' \
         --chunk '$CHUNK_SEC' --lang '$LANG' \
         $([ "$USE_STREAM" = "1" ] && echo "--stream" || true)"
    echo "[INFO] Session started. Attach with: tmux attach -t $SESSION_NAME"
    echo "[INFO] Stop with: bash scripts/stop-stt.sh"
    exit 0
fi

echo "[INFO] Whisper BT Keyboard — STT engine"
echo "[INFO] Model:  $MODEL_PATH"
echo "[INFO] Port:   $PORT"
echo "[INFO] Mode:   $([ "$USE_STREAM" = "1" ] && echo "stream" || echo "chunked (${CHUNK_SEC}s)")"
echo ""

# ─────────────────────────────────────────────
# Clean up on exit
# ─────────────────────────────────────────────
AUDIO_FIFO="/tmp/whisper_audio_$$.fifo"
AUDIO_TMP="/tmp/whisper_chunk_$$.wav"
SOCAT_PID=""

cleanup() {
    echo ""
    echo "[INFO] Shutting down…"
    [ -n "$SOCAT_PID" ] && kill "$SOCAT_PID" 2>/dev/null || true
    rm -f "$AUDIO_FIFO" "$AUDIO_TMP" /tmp/whisper_chunk_$$.*.wav
    termux-microphone-record -q 2>/dev/null || true
    echo "[INFO] Stopped."
}
trap cleanup EXIT INT TERM

# ─────────────────────────────────────────────
# Start TCP socket server (socat)
# Listens on localhost:PORT — Kotlin app connects here.
# socat will buffer writes and deliver them to the client.
# ─────────────────────────────────────────────
SOCKET_FILE="/tmp/whisper_socket_$$.sock"
mkfifo "$AUDIO_FIFO"

# Start socat: creates a TCP server; we write lines to its stdin via the FIFO
socat -u "PIPE:$AUDIO_FIFO" "TCP4-LISTEN:${PORT},reuseaddr,fork,retry=30" &
SOCAT_PID=$!

echo "[INFO] TCP server listening on localhost:$PORT (PID $SOCAT_PID)"
echo "[INFO] Waiting for Kotlin app to connect…"

# Give socat a moment to bind
sleep 1

# ─────────────────────────────────────────────
# Helper: write a line to the socket FIFO
# ─────────────────────────────────────────────
send_text() {
    local text="$1"
    printf '%s\n' "$text" > "$AUDIO_FIFO"
}

# ─────────────────────────────────────────────
# Helper: run whisper on a WAV file, return text
# ─────────────────────────────────────────────
transcribe() {
    local wav_file="$1"
    "$WHISPER_MAIN" \
        --model     "$MODEL_PATH" \
        --language  "$LANG" \
        --no-timestamps \
        --print-special false \
        --no-context \
        --file      "$wav_file" \
        2>/dev/null \
        | tr -d '\r'
}

# ─────────────────────────────────────────────
# Helper: VAD filter — skip silence-only output
# Returns 0 (true) if text is meaningful
# ─────────────────────────────────────────────
is_meaningful() {
    local text="$1"
    # Strip leading/trailing whitespace
    text="$(echo "$text" | xargs)"
    # Empty
    [ -z "$text" ] && return 1
    # Whisper silence markers
    case "$text" in
        "[BLANK_AUDIO]"|"(silence)"|"[silence]"|"..."|\
        "(Silence)"|"[ Blank_Audio ]"|"[blank_audio]") return 1 ;;
    esac
    # Mostly non-alphanumeric (timestamp artifacts, etc.)
    local alnum_count
    alnum_count=$(echo "$text" | tr -cd '[:alnum:]' | wc -c)
    [ "$alnum_count" -lt 2 ] && return 1
    return 0
}

# ─────────────────────────────────────────────
# STREAM MODE (experimental)
# Uses whisper.cpp stream binary, reads directly from audio device.
# Requires pulseaudio or compatible audio routing in Termux.
# ─────────────────────────────────────────────
if [ "$USE_STREAM" = "1" ] && [ -f "$WHISPER_STREAM" ]; then
    echo "[INFO] Starting stream mode…"
    "$WHISPER_STREAM" \
        --model      "$MODEL_PATH" \
        --language   "$LANG" \
        --step       3000 \
        --length     8000 \
        --keep       1000 \
        --vad-thold  0.6 \
        --no-timestamps \
        2>/dev/null \
        | while IFS= read -r line; do
            if is_meaningful "$line"; then
                echo "[STT] $line"
                send_text "$line"
            fi
        done
    exit 0
fi

# ─────────────────────────────────────────────
# CHUNKED MODE (default / reliable)
# Records fixed-length WAV chunks with termux-microphone-record,
# runs whisper on each chunk, writes text to socket.
# ─────────────────────────────────────────────
echo "[INFO] Starting chunked recording (${CHUNK_SEC}s chunks)…"
echo "[INFO] Speak now. Press Ctrl+C to stop."
echo ""

CHUNK_IDX=0

while true; do
    CHUNK_FILE="/tmp/whisper_chunk_$$.${CHUNK_IDX}.wav"
    CHUNK_IDX=$(( CHUNK_IDX + 1 ))

    # Record chunk using Termux:API microphone
    # termux-microphone-record records at 44100Hz by default; we need 16kHz mono.
    # We record to a raw PCM file and convert with sox/ffmpeg.
    RAW_FILE="/tmp/whisper_raw_$$.pcm"

    termux-microphone-record \
        -l "$CHUNK_SEC" \
        -r 16000 \
        -c 1 \
        -b 16 \
        -f wav \
        -o "$CHUNK_FILE" \
        > /dev/null 2>&1

    # Wait for recording to complete
    sleep $(( CHUNK_SEC + 1 ))

    if [ ! -f "$CHUNK_FILE" ] || [ ! -s "$CHUNK_FILE" ]; then
        echo "[WARN] Empty audio chunk — is Termux:API installed and mic permission granted?"
        sleep 2
        continue
    fi

    # Transcribe the chunk
    TRANSCRIPT="$(transcribe "$CHUNK_FILE" 2>/dev/null || true)"

    # Clean up chunk file
    rm -f "$CHUNK_FILE"

    # VAD: only send non-silent transcriptions
    if is_meaningful "$TRANSCRIPT"; then
        # Strip leading/trailing whitespace
        TRANSCRIPT="$(echo "$TRANSCRIPT" | xargs)"
        echo "[STT] $TRANSCRIPT"
        send_text "$TRANSCRIPT"
    else
        echo "[VAD] (silence — skipped)"
    fi
done
