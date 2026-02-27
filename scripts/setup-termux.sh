#!/data/data/com.termux/files/usr/bin/bash
# setup-termux.sh — One-time setup for Whisper STT engine in Termux
#
# Run this once after installing Termux (from F-Droid) and Termux:API.
# It installs build tools, clones and compiles whisper.cpp, and downloads
# the default model.
#
# Usage: bash setup-termux.sh [model_name]
#   model_name: optional (default: base.en)
#   Example:   bash setup-termux.sh distil-small.en

set -euo pipefail

MODEL_NAME="${1:-base.en}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
WHISPER_DIR="$REPO_DIR/whisper.cpp"
MODELS_DIR="$REPO_DIR/models"

# ─────────────────────────────────────────────
# Colors
# ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ─────────────────────────────────────────────
# 1. Update and upgrade packages
# ─────────────────────────────────────────────
info "Updating package lists…"
pkg update -y

info "Upgrading installed packages…"
pkg upgrade -y

# ─────────────────────────────────────────────
# 2. Install required packages
# ─────────────────────────────────────────────
info "Installing build tools and dependencies…"
pkg install -y \
    clang \
    cmake \
    make \
    git \
    tmux \
    termux-api \
    socat \
    wget \
    ffmpeg \
    sox

# ─────────────────────────────────────────────
# 3. Clone whisper.cpp
# ─────────────────────────────────────────────
if [ -d "$WHISPER_DIR" ]; then
    info "whisper.cpp already cloned — pulling latest changes"
    git -C "$WHISPER_DIR" pull
else
    info "Cloning whisper.cpp…"
    git clone https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
fi

# ─────────────────────────────────────────────
# 4. Build whisper.cpp (ARM64 with NEON/dotprod)
# ─────────────────────────────────────────────
info "Building whisper.cpp for ARM64 (this will take a few minutes)…"

cd "$WHISPER_DIR"

cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="-march=armv8.2-a+dotprod+fp16" \
    -DCMAKE_CXX_FLAGS="-march=armv8.2-a+dotprod+fp16" \
    -DWHISPER_NO_ACCELERATE=ON \
    -DBUILD_SHARED_LIBS=OFF

cmake --build build --config Release -j"$(nproc)"

info "Build complete."

# Verify key binaries exist
for bin in main; do
    if [ ! -f "$WHISPER_DIR/build/bin/$bin" ]; then
        error "Expected binary not found: build/bin/$bin"
        exit 1
    fi
done

# stream binary is optional — whisper.cpp may not build it on all configs
if [ -f "$WHISPER_DIR/build/bin/stream" ]; then
    info "Stream binary also available: build/bin/stream"
else
    warn "Stream binary not built — will use chunked mode in start-stt.sh"
fi

# ─────────────────────────────────────────────
# 5. Create models directory and download model
# ─────────────────────────────────────────────
mkdir -p "$MODELS_DIR"

MODEL_FILE="ggml-${MODEL_NAME}.bin"
MODEL_PATH="$MODELS_DIR/$MODEL_FILE"

if [ -f "$MODEL_PATH" ]; then
    info "Model already present: $MODEL_PATH"
else
    info "Downloading model: $MODEL_NAME (~$(model_size "$MODEL_NAME"))…"
    MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}"
    wget -q --show-progress -O "$MODEL_PATH" "$MODEL_URL"
    info "Downloaded: $MODEL_PATH"
fi

# ─────────────────────────────────────────────
# 6. Create convenience symlinks in scripts/
# ─────────────────────────────────────────────
ln -sf "$WHISPER_DIR/build/bin/main" "$SCRIPT_DIR/whisper-main" 2>/dev/null || true
if [ -f "$WHISPER_DIR/build/bin/stream" ]; then
    ln -sf "$WHISPER_DIR/build/bin/stream" "$SCRIPT_DIR/whisper-stream" 2>/dev/null || true
fi

# ─────────────────────────────────────────────
# 7. Make scripts executable
# ─────────────────────────────────────────────
chmod +x "$SCRIPT_DIR"/*.sh

# ─────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Setup complete!                                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Model:    $MODEL_PATH"
echo "  Binary:   $WHISPER_DIR/build/bin/main"
echo ""
echo "  Next steps:"
echo "  1. Install and open the Whisper BT Keyboard APK"
echo "  2. Pair your phone with your laptop as a Bluetooth keyboard"
echo "  3. Run:  bash scripts/start-stt.sh"
echo "  4. Speak — text will appear on your laptop"
echo ""
echo "  To swap models later:"
echo "  bash scripts/update-model.sh <model-name>"
echo ""
echo "  Supported models:"
echo "    tiny.en        (~75 MB)   — fastest"
echo "    base.en        (~142 MB)  — default, good balance"
echo "    small.en       (~466 MB)  — better accuracy"
echo "    distil-small.en (~350 MB) — optimized accuracy"
echo ""

# Helper function referenced above (must be defined before use in bash —
# pulled down here since it's only called in step 5)
model_size() {
    case "$1" in
        tiny.en)          echo "75 MB"    ;;
        base.en)          echo "142 MB"   ;;
        small.en)         echo "466 MB"   ;;
        distil-small.en)  echo "350 MB"   ;;
        medium.en)        echo "1.5 GB"   ;;
        *)                echo "unknown size" ;;
    esac
}
