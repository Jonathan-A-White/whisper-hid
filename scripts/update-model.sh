#!/data/data/com.termux/files/usr/bin/bash
# update-model.sh — Download or swap Whisper models
set -euo pipefail

INSTALL_DIR="$HOME/whisper-stt"
MODEL_DIR="$INSTALL_DIR/models"
WHISPER_CPP_REPO="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
# Minimum expected model size (10 MB) — catches HTML error pages
MIN_MODEL_SIZE=10000000

usage() {
    echo "Usage: $0 <model-name>"
    echo ""
    echo "Available models:"
    echo "  tiny.en          75 MB   ~10x real-time   Basic accuracy"
    echo "  base.en         142 MB   ~5x real-time    Good accuracy"
    echo "  small.en        466 MB   ~2x real-time    Better accuracy"
    echo "  distil-small.en ~350 MB  ~2-3x real-time  Better (optimized)"
    echo ""
    echo "Examples:"
    echo "  $0 base.en"
    echo "  $0 distil-small.en"
    echo ""
    echo "After downloading, set WHISPER_MODEL env var or update start-stt.sh."
    exit 1
}

if [ $# -lt 1 ]; then
    usage
fi

MODEL_NAME="$1"

# Map model name to filename and download URL.
# Standard models live in ggerganov/whisper.cpp.
# Distil models live in distil-whisper/<model-name> repos.
FILENAME="ggml-${MODEL_NAME}.bin"
case "$MODEL_NAME" in
    tiny.en|base.en|small.en|medium.en|large|large-v2|large-v3)
        URL="${WHISPER_CPP_REPO}/${FILENAME}"
        ;;
    distil-small.en|distil-medium.en)
        URL="https://huggingface.co/distil-whisper/${MODEL_NAME}/resolve/main/${FILENAME}"
        ;;
    distil-large-v2)
        URL="https://huggingface.co/distil-whisper/${MODEL_NAME}/resolve/main/${FILENAME}"
        ;;
    distil-large-v3)
        URL="https://huggingface.co/distil-whisper/${MODEL_NAME}-ggml/resolve/main/${FILENAME}"
        ;;
    *)
        echo "Error: Unknown model '$MODEL_NAME'"
        usage
        ;;
esac

mkdir -p "$MODEL_DIR"

DEST="$MODEL_DIR/$FILENAME"

if [ -f "$DEST" ]; then
    echo "Model already exists: $DEST"
    read -p "Re-download? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing model."
        exit 0
    fi
fi

echo "Downloading $FILENAME..."
echo "URL: $URL"
curl -L --progress-bar -o "$DEST" "$URL"

if [ ! -f "$DEST" ]; then
    echo "Error: Download failed — no file created."
    exit 1
fi

# Validate file size to catch HTML error pages masquerading as models
ACTUAL_SIZE=$(wc -c < "$DEST")
if [ "$ACTUAL_SIZE" -lt "$MIN_MODEL_SIZE" ]; then
    echo "Error: Downloaded file is only ${ACTUAL_SIZE} bytes — expected a model file (>10 MB)."
    echo "The download URL may be wrong or the model may not exist."
    echo "URL was: $URL"
    rm -f "$DEST"
    exit 1
fi

SIZE=$(du -h "$DEST" | cut -f1)
echo ""
echo "Downloaded: $DEST ($SIZE)"
echo ""
echo "To use this model, either:"
echo "  export WHISPER_MODEL=$(basename "$DEST")"
echo "  ./start-whisper-server.sh"
echo ""
echo "Or set the WHISPER_MODEL env var before starting the server."
echo ""
echo "IMPORTANT: Restart the Whisper server after swapping models:"
echo "  ./stop-whisper-server.sh && ./start-whisper-server.sh"
