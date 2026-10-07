#!/data/data/com.termux/files/usr/bin/bash
# update-model.sh — Download the Parakeet speech model and the cleanup LLMs
set -euo pipefail

INSTALL_DIR="$HOME/whisper-stt"
MODEL_DIR="$INSTALL_DIR/models"
# Minimum expected model size (10 MB) — catches HTML error pages
MIN_MODEL_SIZE=10000000

PARAKEET_DIR="sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
PARAKEET_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${PARAKEET_DIR}.tar.bz2"
# Speech cleanup LLMs — keep file names in sync with the
# CLEANUP_MODEL_CATALOG in whisper-server.py and with setup-termux.sh.
# unsloth repos: the official Qwen/Qwen3-*-GGUF repos don't carry the
# Q4_K_M quant (their /resolve URLs return "Entry not found").
CLEANUP_MODEL_FILE="Qwen3-1.7B-Q4_K_M.gguf"
CLEANUP_MODEL_URL="https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/${CLEANUP_MODEL_FILE}"
CLEANUP_4B_MODEL_FILE="Qwen3-4B-Q4_K_M.gguf"
CLEANUP_4B_MODEL_URL="https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/${CLEANUP_4B_MODEL_FILE}"

usage() {
    echo "Usage: $0 <model-name>"
    echo ""
    echo "Available models:"
    echo "  parakeet              ~640 MB   ~10x real-time   Speech-to-text engine (required)"
    echo "  cleanup              ~1.1 GB                     Qwen3-1.7B speech cleanup LLM (default)"
    echo "  cleanup-4b           ~2.4 GB                     Qwen3-4B cleanup LLM (smarter, needs ~3 GB RAM)"
    echo ""
    echo "Examples:"
    echo "  $0 parakeet"
    echo "  $0 cleanup"
    echo ""
    echo "After downloading, restart the Whisper server."
    exit 1
}

if [ $# -lt 1 ]; then
    usage
fi

MODEL_NAME="$1"

# Speech cleanup LLMs (GGUF for llama.cpp)
if [ "$MODEL_NAME" = "cleanup" ] || [ "$MODEL_NAME" = "cleanup-4b" ]; then
    if [ "$MODEL_NAME" = "cleanup-4b" ]; then
        DL_FILE="$CLEANUP_4B_MODEL_FILE"
        DL_URL="$CLEANUP_4B_MODEL_URL"
        DL_DESC="Qwen3-4B Q4_K_M speech cleanup model (~2.4 GB)"
    else
        DL_FILE="$CLEANUP_MODEL_FILE"
        DL_URL="$CLEANUP_MODEL_URL"
        DL_DESC="Qwen3-1.7B Q4_K_M speech cleanup model (~1.1 GB)"
    fi
    mkdir -p "$MODEL_DIR"
    DEST="$MODEL_DIR/$DL_FILE"
    if [ -f "$DEST" ]; then
        echo "Cleanup model already exists: $DEST"
        read -p "Re-download? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Keeping existing model."
            exit 0
        fi
    fi
    echo "Downloading $DL_DESC..."
    echo "URL: $DL_URL"
    curl -fL --progress-bar -o "$DEST" "$DL_URL"
    ACTUAL_SIZE=$(wc -c < "$DEST")
    if [ "$ACTUAL_SIZE" -lt "$MIN_MODEL_SIZE" ]; then
        echo "Error: Downloaded file is only ${ACTUAL_SIZE} bytes — expected a model file (>10 MB)."
        rm -f "$DEST"
        exit 1
    fi
    echo ""
    echo "Downloaded: $DEST ($(du -h "$DEST" | cut -f1))"
    if [ ! -x "$INSTALL_DIR/llama.cpp/build/bin/llama-server" ]; then
        echo ""
        echo "NOTE: llama-server is not built yet — re-run setup-termux.sh to build it."
    fi
    echo ""
    if [ "$MODEL_NAME" = "cleanup-4b" ]; then
        echo "Pick the model in PWA Settings > Speech cleanup (no server restart needed),"
        echo "or restart the Whisper server to apply a CLEANUP_MODEL env var:"
    else
        echo "Restart the Whisper server, then flip the Cleanup toggle in the PWA:"
    fi
    echo "  ./stop-whisper-server.sh && ./start-whisper-server.sh"
    exit 0
fi

# Parakeet model download (sherpa-onnx tarball)
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
    echo "Restart the Whisper server to load Parakeet:"
    echo "  ./stop-whisper-server.sh && ./start-whisper-server.sh"
    exit 0
fi

echo "Error: Unknown model '$MODEL_NAME'"
usage
