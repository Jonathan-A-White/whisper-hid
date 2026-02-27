#!/data/data/com.termux/files/usr/bin/bash
# start-stt.sh — Main speech-to-text loop
# Captures mic audio, runs whisper.cpp, sends text to localhost:9876
set -euo pipefail

INSTALL_DIR="$HOME/whisper-stt"
# Try whisper-cli first (newer builds), fall back to main (older builds)
WHISPER_BIN="$INSTALL_DIR/whisper.cpp/build/bin/whisper-cli"
if [ ! -x "$WHISPER_BIN" ]; then
    WHISPER_BIN="$INSTALL_DIR/whisper.cpp/build/bin/main"
fi
MODEL="${WHISPER_MODEL:-$INSTALL_DIR/models/ggml-base.en.bin}"
PORT="${WHISPER_PORT:-9876}"
CHUNK_SEC="${WHISPER_CHUNK_SEC:-5}"
AUDIO_DIR="$INSTALL_DIR/audio_tmp"
PID_FILE="$INSTALL_DIR/.stt.pid"

# Silence patterns to filter out
SILENCE_PATTERNS='^\[BLANK_AUDIO\]$|^\(silence\)$|^$|^\[MUSIC\]$|^\[music\]$|^ *$'

cleanup() {
    echo "Shutting down..."
    trap - SIGTERM SIGINT EXIT  # Prevent re-entry
    # Kill child processes (socat and stt-loop.sh) by process group
    kill -- -$$ 2>/dev/null || true
    sleep 0.5
    # Stop any recording
    termux-microphone-record -q 2>/dev/null || true
    # Remove PID file
    rm -f "$PID_FILE"
    # Clean up temp audio
    rm -rf "$AUDIO_DIR"
    exit 0
}

trap cleanup SIGTERM SIGINT EXIT

# Validate dependencies
if [ ! -x "$WHISPER_BIN" ]; then
    echo "Error: whisper.cpp not built. Run setup-termux.sh first."
    exit 1
fi

if [ ! -f "$MODEL" ]; then
    echo "Error: Model not found at $MODEL"
    echo "Run: ./update-model.sh base.en"
    exit 1
fi

if ! command -v socat &>/dev/null; then
    echo "Error: socat not installed. Run: pkg install socat"
    exit 1
fi

if ! command -v ffmpeg &>/dev/null; then
    echo "Error: ffmpeg not installed. Run: pkg install ffmpeg"
    exit 1
fi

if ! command -v termux-microphone-record &>/dev/null; then
    echo "Error: termux-api not installed. Run: pkg install termux-api"
    echo "Also install Termux:API app from F-Droid."
    exit 1
fi

if [ ! -f "$INSTALL_DIR/stt-loop.sh" ]; then
    echo "Error: stt-loop.sh not found. Re-run setup-termux.sh."
    exit 1
fi

# Kill orphaned stt-loop.sh processes from previous runs that may
# periodically call termux-microphone-record -q and stop new recordings.
pkill -f "stt-loop.sh" 2>/dev/null || true
termux-microphone-record -q 2>/dev/null || true

# Store PID
echo $$ > "$PID_FILE"

# Create temp directory for audio chunks
mkdir -p "$AUDIO_DIR"

# --- Test audio pipeline at startup ---
# Try AAC first (default encoder, most compatible), fall back to AMR-WB
echo "Testing audio pipeline..."
RECORD_ARGS=""
RECORD_EXT="aac"

TEST_RAW="$AUDIO_DIR/pipeline_test.aac"
TEST_WAV="$AUDIO_DIR/pipeline_test.wav"
termux-microphone-record -f "$TEST_RAW" -l 1 2>/dev/null
sleep 2
termux-microphone-record -q 2>/dev/null || true
sleep 0.5

if [ ! -s "$TEST_RAW" ]; then
    echo "Error: Microphone recording produced no audio."
    echo "Ensure Termux:API app is installed and has microphone permission."
    rm -f "$TEST_RAW"
    exit 1
fi

if ffmpeg -y -i "$TEST_RAW" -ar 16000 -ac 1 -c:a pcm_s16le "$TEST_WAV" >/dev/null 2>&1; then
    echo "  Audio format: AAC (default)"
else
    # AAC conversion failed — try AMR-WB as fallback
    rm -f "$TEST_RAW" "$TEST_WAV"
    TEST_RAW="$AUDIO_DIR/pipeline_test.amr"
    termux-microphone-record -f "$TEST_RAW" -l 1 -e amr_wb -b 23850 2>/dev/null
    sleep 2
    termux-microphone-record -q 2>/dev/null || true
    sleep 0.5
    if [ -s "$TEST_RAW" ] && ffmpeg -y -i "$TEST_RAW" -ar 16000 -ac 1 -c:a pcm_s16le "$TEST_WAV" >/dev/null 2>&1; then
        RECORD_ARGS="-e amr_wb -b 23850"
        RECORD_EXT="amr"
        echo "  Audio format: AMR-WB (fallback)"
    else
        echo "Error: Cannot convert recorded audio to WAV."
        echo "Neither AAC nor AMR-WB conversion works with installed ffmpeg."
        echo "Try reinstalling ffmpeg: pkg install ffmpeg"
        rm -f "$TEST_RAW" "$TEST_WAV"
        exit 1
    fi
fi
rm -f "$TEST_RAW" "$TEST_WAV"
echo "  Audio pipeline OK"

# Export variables for stt-loop.sh (runs in a subprocess via socat)
export WHISPER_BIN MODEL CHUNK_SEC AUDIO_DIR SILENCE_PATTERNS RECORD_ARGS RECORD_EXT

echo ""
echo "=== Whisper STT Started ==="
echo "Model: $MODEL"
echo "Port: $PORT"
echo "Chunk size: ${CHUNK_SEC}s"
echo "Waiting for connection on localhost:$PORT..."

# Main loop: accept one TCP connection at a time, run transcription loop.
# No 'fork' — prevents multiple processes fighting over the microphone.
# When a connection ends, socat exits and we restart the listener.
while true; do
    socat TCP-LISTEN:"$PORT",reuseaddr SYSTEM:"bash '$INSTALL_DIR/stt-loop.sh'" 2>&1 || true
    echo "Connection ended, listening again on port $PORT..." >&2
    # Brief pause before accepting a new connection
    sleep 1
done
