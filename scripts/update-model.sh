#!/data/data/com.termux/files/usr/bin/bash
# update-model.sh — Download or swap Whisper models
set -euo pipefail

INSTALL_DIR="$HOME/whisper-stt"
MODEL_DIR="$INSTALL_DIR/models"
WHISPER_CPP_REPO="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
# Minimum expected model size (10 MB) — catches HTML error pages
MIN_MODEL_SIZE=10000000

TURBO_QUANTS_REPO="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
VAD_MODEL_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
VAD_MODEL_FILE="silero-v5.1.2.ggml.bin"
PARAKEET_DIR="sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
PARAKEET_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${PARAKEET_DIR}.tar.bz2"

usage() {
    echo "Usage: $0 <model-name>"
    echo ""
    echo "Available models:"
    echo "  tiny.en                 75 MB   ~10x real-time   Basic accuracy"
    echo "  base.en                142 MB   ~5x real-time    Good accuracy"
    echo "  small.en               466 MB   ~2x real-time    Better accuracy"
    echo "  medium.en             1500 MB   ~0.5x real-time  Great accuracy"
    echo ""
    echo "Quantized (smaller + faster, minimal quality loss):"
    echo "  tiny.en-q5_1            31 MB   ~10x real-time   Basic accuracy"
    echo "  base.en-q5_1            60 MB   ~5x real-time    Good accuracy"
    echo "  small.en-q5_1          190 MB   ~2x real-time    Best speed/accuracy for phone"
    echo "  medium.en-q5_0         515 MB   ~0.5x real-time  Great accuracy, quantized"
    echo ""
    echo "Turbo (distilled large model):"
    echo "  large-v3-turbo        1500 MB                    6x faster than large"
    echo "  large-v3-turbo-q5_0    547 MB                    Best speed/accuracy"
    echo "  large-v3-turbo-q8_0    810 MB                    Near-full accuracy"
    echo ""
    echo "Distilled (knowledge-distilled, English-only):"
    echo "  distil-small.en       ~350 MB   ~2-3x real-time  Better (optimized)"
    echo "  distil-medium.en      ~750 MB   ~1-2x real-time  Great (optimized)"
    echo ""
    echo "Parakeet engine (sherpa-onnx — faster + more accurate than whisper):"
    echo "  parakeet              ~640 MB   ~10x real-time   Best accuracy + speed"
    echo ""
    echo "Special:"
    echo "  vad                    ~2 MB                     Silero VAD model"
    echo ""
    echo "Examples:"
    echo "  $0 parakeet                # recommended"
    echo "  $0 base.en"
    echo "  $0 small.en-q5_1"
    echo "  $0 large-v3-turbo-q5_0"
    echo "  $0 vad"
    echo ""
    echo "After downloading, set WHISPER_MODEL env var or restart whisper-server."
    exit 1
}

if [ $# -lt 1 ]; then
    usage
fi

MODEL_NAME="$1"

# Special case: VAD model download
if [ "$MODEL_NAME" = "vad" ]; then
    mkdir -p "$MODEL_DIR"
    DEST="$MODEL_DIR/$VAD_MODEL_FILE"
    if [ -f "$DEST" ]; then
        echo "VAD model already exists: $DEST"
        read -p "Re-download? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Keeping existing model."
            exit 0
        fi
    fi
    echo "Downloading Silero VAD model..."
    echo "URL: $VAD_MODEL_URL"
    curl -L --progress-bar -o "$DEST" "$VAD_MODEL_URL"
    SIZE=$(du -h "$DEST" | cut -f1)
    echo ""
    echo "Downloaded: $DEST ($SIZE)"
    echo "VAD will be automatically used by the whisper server if the --vad flag is supported."
    exit 0
fi

# Special case: Parakeet model download (sherpa-onnx tarball, not a ggml file)
if [ "$MODEL_NAME" = "parakeet" ] || [ "$MODEL_NAME" = "parakeet-tdt-0.6b-v2" ]; then
    mkdir -p "$MODEL_DIR"
    DEST_DIR="$MODEL_DIR/$PARAKEET_DIR"
    if [ -d "$DEST_DIR" ]; then
        echo "Parakeet model already exists: $DEST_DIR"
        read -p "Re-download? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Keeping existing model."
            exit 0
        fi
        rm -rf "$DEST_DIR"
    fi
    TARBALL="$MODEL_DIR/${PARAKEET_DIR}.tar.bz2"
    echo "Downloading Parakeet TDT 0.6B v2 int8 (~480 MB)..."
    echo "URL: $PARAKEET_URL"
    curl -L --progress-bar -o "$TARBALL" "$PARAKEET_URL"
    echo "Extracting..."
    tar xjf "$TARBALL" -C "$MODEL_DIR"
    rm -f "$TARBALL"
    if [ ! -f "$DEST_DIR/tokens.txt" ]; then
        echo "Error: extraction failed — $DEST_DIR/tokens.txt not found."
        exit 1
    fi
    echo ""
    echo "Downloaded: $DEST_DIR ($(du -sh "$DEST_DIR" | cut -f1))"
    if ! python3 -c "import sherpa_onnx, numpy" 2>/dev/null \
        && ! python3 -c "import onnxruntime, numpy" 2>/dev/null; then
        echo ""
        echo "NOTE: no Parakeet backend installed yet. In Termux run:"
        echo "  pkg install python-numpy python-onnxruntime"
        echo "(elsewhere: pip install sherpa-onnx numpy)"
    fi
    echo ""
    echo "Restart the Whisper server to use Parakeet (preferred automatically):"
    echo "  ./stop-whisper-server.sh && ./start-whisper-server.sh"
    exit 0
fi

# Map model name to filename and download URL.
# Standard models live in ggerganov/whisper.cpp.
# Distil models live in distil-whisper/<model-name> repos.
FILENAME="ggml-${MODEL_NAME}.bin"
case "$MODEL_NAME" in
    tiny.en|base.en|small.en|medium.en|large|large-v2|large-v3)
        URL="${WHISPER_CPP_REPO}/${FILENAME}"
        ;;
    tiny.en-q5_1|base.en-q5_1|small.en-q5_1|medium.en-q5_0)
        URL="${WHISPER_CPP_REPO}/${FILENAME}"
        ;;
    large-v3-turbo)
        URL="${TURBO_QUANTS_REPO}/${FILENAME}"
        ;;
    large-v3-turbo-q5_0|large-v3-turbo-q8_0)
        URL="${TURBO_QUANTS_REPO}/${FILENAME}"
        ;;
    distil-small.en)
        URL="https://huggingface.co/distil-whisper/${MODEL_NAME}/resolve/main/${FILENAME}"
        ;;
    distil-medium.en)
        # The distil-medium.en repo stores the GGML file as ggml-medium-32-2.en.bin,
        # not ggml-distil-medium.en.bin. Download with correct source name, save locally
        # as ggml-distil-medium.en.bin for consistency.
        URL="https://huggingface.co/distil-whisper/${MODEL_NAME}/resolve/main/ggml-medium-32-2.en.bin"
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
