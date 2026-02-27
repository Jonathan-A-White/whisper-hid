#!/data/data/com.termux/files/usr/bin/bash
# update-model.sh — Download or swap Whisper models
set -euo pipefail

INSTALL_DIR="$HOME/whisper-stt"
MODEL_DIR="$INSTALL_DIR/models"
MODEL_REPO="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

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

# Map model name to filename
case "$MODEL_NAME" in
    tiny.en|base.en|small.en|medium.en|large)
        FILENAME="ggml-${MODEL_NAME}.bin"
        ;;
    distil-small.en|distil-medium.en|distil-large-v2|distil-large-v3)
        FILENAME="ggml-${MODEL_NAME}.bin"
        ;;
    *)
        echo "Error: Unknown model '$MODEL_NAME'"
        usage
        ;;
esac

mkdir -p "$MODEL_DIR"

DEST="$MODEL_DIR/$FILENAME"
URL="$MODEL_REPO/$FILENAME"

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

if [ -f "$DEST" ]; then
    SIZE=$(du -h "$DEST" | cut -f1)
    echo ""
    echo "Downloaded: $DEST ($SIZE)"
    echo ""
    echo "To use this model, either:"
    echo "  export WHISPER_MODEL=$DEST"
    echo "  ./start-stt.sh"
    echo ""
    echo "Or edit start-stt.sh to change the default MODEL path."
else
    echo "Error: Download failed."
    exit 1
fi
