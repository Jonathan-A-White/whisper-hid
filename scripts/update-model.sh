#!/data/data/com.termux/files/usr/bin/bash
# update-model.sh — Download or swap the Whisper model used for transcription
#
# Usage: bash scripts/update-model.sh <model-name>
#
# Examples:
#   bash scripts/update-model.sh tiny.en
#   bash scripts/update-model.sh base.en         # default
#   bash scripts/update-model.sh small.en
#   bash scripts/update-model.sh distil-small.en
#   bash scripts/update-model.sh medium.en
#
# Model reference (S24 Ultra / Snapdragon 8 Gen 3):
# ┌─────────────────┬──────────┬────────────────────┬──────────────┐
# │ Model           │ Size     │ Speed (vs RT)       │ Accuracy     │
# ├─────────────────┼──────────┼────────────────────┼──────────────┤
# │ tiny.en         │  75 MB   │ ~10x real-time      │ Basic        │
# │ base.en         │ 142 MB   │ ~5x real-time       │ Good         │
# │ small.en        │ 466 MB   │ ~2x real-time       │ Better       │
# │ distil-small.en │ ~350 MB  │ ~2-3x real-time     │ Better (opt) │
# │ medium.en       │ 1.5 GB   │ ~1x real-time       │ Best (en)    │
# └─────────────────┴──────────┴────────────────────┴──────────────┘
#
# Models are downloaded from Hugging Face:
#   https://huggingface.co/ggerganov/whisper.cpp/tree/main

set -euo pipefail

# ─────────────────────────────────────────────
# Arguments
# ─────────────────────────────────────────────
if [ $# -eq 0 ]; then
    echo "Usage: $0 <model-name>"
    echo ""
    echo "Available models:"
    echo "  tiny.en          75 MB   — fastest"
    echo "  base.en         142 MB   — default"
    echo "  small.en        466 MB   — better accuracy"
    echo "  distil-small.en ~350 MB  — optimized accuracy"
    echo "  medium.en       1.5 GB   — best English accuracy"
    exit 1
fi

MODEL_NAME="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
MODELS_DIR="$REPO_DIR/models"
MODEL_FILE="ggml-${MODEL_NAME}.bin"
MODEL_PATH="$MODELS_DIR/$MODEL_FILE"
HF_BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
MODEL_URL="${HF_BASE_URL}/${MODEL_FILE}"

# ─────────────────────────────────────────────
# Validate model name (known models)
# ─────────────────────────────────────────────
case "$MODEL_NAME" in
    tiny|tiny.en|\
    base|base.en|\
    small|small.en|\
    medium|medium.en|\
    large|large-v2|large-v3|\
    distil-small.en|distil-medium.en)
        ;;  # known — continue
    *)
        echo "[WARN] '$MODEL_NAME' is not a known model name."
        echo "       Attempting download anyway…"
        ;;
esac

# ─────────────────────────────────────────────
# Create models directory
# ─────────────────────────────────────────────
mkdir -p "$MODELS_DIR"

# ─────────────────────────────────────────────
# Check if already downloaded
# ─────────────────────────────────────────────
if [ -f "$MODEL_PATH" ]; then
    SIZE_MB=$(( $(wc -c < "$MODEL_PATH") / 1048576 ))
    echo "[INFO] Model already present: $MODEL_PATH (${SIZE_MB} MB)"
    read -r -p "Re-download? [y/N] " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "[INFO] Keeping existing model."
        exit 0
    fi
    rm -f "$MODEL_PATH"
fi

# ─────────────────────────────────────────────
# Download
# ─────────────────────────────────────────────
echo "[INFO] Downloading: $MODEL_FILE"
echo "[INFO] Source:      $MODEL_URL"
echo "[INFO] Destination: $MODEL_PATH"
echo ""

if command -v wget &>/dev/null; then
    wget -q --show-progress --continue -O "$MODEL_PATH" "$MODEL_URL"
elif command -v curl &>/dev/null; then
    curl -L --progress-bar --continue-at - -o "$MODEL_PATH" "$MODEL_URL"
else
    echo "[ERROR] Neither wget nor curl found. Install one: pkg install wget" >&2
    exit 1
fi

# Verify file is non-empty (basic sanity check)
if [ ! -s "$MODEL_PATH" ]; then
    echo "[ERROR] Download failed or empty file: $MODEL_PATH" >&2
    rm -f "$MODEL_PATH"
    exit 1
fi

SIZE_MB=$(( $(wc -c < "$MODEL_PATH") / 1048576 ))
echo ""
echo "[INFO] Download complete: $MODEL_PATH (${SIZE_MB} MB)"

# ─────────────────────────────────────────────
# Update symlink / config pointer (optional)
# ─────────────────────────────────────────────
CURRENT_LINK="$MODELS_DIR/current.bin"
ln -sf "$MODEL_FILE" "$CURRENT_LINK"
echo "[INFO] Symlink updated: models/current.bin → $MODEL_FILE"

echo ""
echo "[INFO] To use this model, run:"
echo "       bash scripts/start-stt.sh --model $MODEL_NAME"
echo ""
