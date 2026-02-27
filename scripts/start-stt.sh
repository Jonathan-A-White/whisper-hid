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

# Store PID
echo $$ > "$PID_FILE"

# Create temp directory for audio chunks
mkdir -p "$AUDIO_DIR"

echo "=== Whisper STT Started ==="
echo "Model: $MODEL"
echo "Port: $PORT"
echo "Chunk size: ${CHUNK_SEC}s"
echo "Waiting for connection on localhost:$PORT..."

# Main loop: accept TCP connections and stream transcription
socat TCP-LISTEN:"$PORT",reuseaddr,fork SYSTEM:"
    echo 'Client connected' >&2
    # Stop any stale recording from a previous connection
    termux-microphone-record -q 2>/dev/null || true
    while true; do
        RAW_FILE=\"$AUDIO_DIR/chunk_\$\$_raw.amr\"
        AUDIO_FILE=\"$AUDIO_DIR/chunk_\$\$.wav\"

        # Record audio chunk (AMR-WB format)
        termux-microphone-record -f \"\$RAW_FILE\" -l $CHUNK_SEC -e amr_wb -b 23850 2>/dev/null
        sleep $CHUNK_SEC

        # Stop recording for this chunk
        termux-microphone-record -q 2>/dev/null || true

        # Convert AMR to 16kHz 16-bit mono WAV (required by whisper.cpp)
        if ! ffmpeg -y -i \"\$RAW_FILE\" -ar 16000 -ac 1 -c:a pcm_s16le \"\$AUDIO_FILE\" 2>/dev/null; then
            echo 'Audio conversion failed' >&2
            rm -f \"\$RAW_FILE\" \"\$AUDIO_FILE\"
            continue
        fi
        rm -f \"\$RAW_FILE\"

        # Skip if file is too small (no audio)
        if [ ! -f \"\$AUDIO_FILE\" ] || [ \$(stat -c%s \"\$AUDIO_FILE\" 2>/dev/null || echo 0) -lt 1000 ]; then
            rm -f \"\$AUDIO_FILE\"
            continue
        fi

        # Run whisper transcription
        RESULT=\$(\"$WHISPER_BIN\" \\
            --model \"$MODEL\" \\
            --language en \\
            --no-timestamps \\
            --no-context \\
            --file \"\$AUDIO_FILE\" 2>/dev/null | \\
            sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \\
            grep -vE '$SILENCE_PATTERNS' || true)

        # Send non-empty results
        if [ -n \"\$RESULT\" ]; then
            echo \"\$RESULT\"
        fi

        # Clean up audio chunk
        rm -f \"\$AUDIO_FILE\"
    done
" &

wait
