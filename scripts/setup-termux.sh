#!/data/data/com.termux/files/usr/bin/bash
# setup-termux.sh — One-time Termux environment setup for Whisper STT
set -euo pipefail

WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"
MODEL_REPO="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
DEFAULT_MODEL="ggml-base.en.bin"
INSTALL_DIR="$HOME/whisper-stt"

echo "=== Whisper Bluetooth Keyboard — Termux Setup ==="
echo ""

# 1. Update packages
echo "[1/6] Updating Termux packages..."
pkg update -y && pkg upgrade -y

# 2. Install build tools
echo "[2/6] Installing build tools..."
pkg install -y clang cmake make git tmux termux-api socat

# 3. Clone whisper.cpp
echo "[3/6] Cloning whisper.cpp..."
mkdir -p "$INSTALL_DIR"
if [ -d "$INSTALL_DIR/whisper.cpp" ]; then
    echo "  whisper.cpp already cloned, pulling latest..."
    cd "$INSTALL_DIR/whisper.cpp" && git pull
else
    git clone "$WHISPER_REPO" "$INSTALL_DIR/whisper.cpp"
fi

# 4. Build whisper.cpp with ARM64 NEON flags
echo "[4/6] Building whisper.cpp (this may take a few minutes)..."
cd "$INSTALL_DIR/whisper.cpp"
cmake -B build \
    -DCMAKE_C_FLAGS="-march=armv8.2-a+dotprod+fp16" \
    -DCMAKE_CXX_FLAGS="-march=armv8.2-a+dotprod+fp16" \
    -DWHISPER_NO_ACCELERATE=ON
cmake --build build --config Release -j"$(nproc)"

# 5. Download default model
echo "[5/6] Downloading default model ($DEFAULT_MODEL)..."
mkdir -p "$INSTALL_DIR/models"
if [ -f "$INSTALL_DIR/models/$DEFAULT_MODEL" ]; then
    echo "  Model already exists, skipping download."
else
    curl -L -o "$INSTALL_DIR/models/$DEFAULT_MODEL" \
        "$MODEL_REPO/$DEFAULT_MODEL"
fi

# 6. Copy scripts
echo "[6/6] Setting up scripts..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for script in start-stt.sh stop-stt.sh update-model.sh; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        cp "$SCRIPT_DIR/$script" "$INSTALL_DIR/$script"
        chmod +x "$INSTALL_DIR/$script"
    fi
done

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Installation directory: $INSTALL_DIR"
echo "Model: $INSTALL_DIR/models/$DEFAULT_MODEL"
echo "Whisper binary: $INSTALL_DIR/whisper.cpp/build/bin/main"
echo ""
echo "Next steps:"
echo "  1. Grant Termux:API microphone permission"
echo "  2. Start the Whisper Keyboard Android app"
echo "  3. Run: cd $INSTALL_DIR && ./start-stt.sh"
echo ""
echo "To swap models: ./update-model.sh <model-name>"
echo "  Available: tiny.en, base.en, small.en, distil-small.en"
