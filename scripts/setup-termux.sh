#!/data/data/com.termux/files/usr/bin/bash
# setup-termux.sh — One-time Termux environment setup for Whisper STT
set -euo pipefail

WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"
MODEL_REPO="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
DEFAULT_MODEL="ggml-base.en.bin"
INSTALL_DIR="$HOME/whisper-stt"
# Capture script directory before any cd commands change the working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Whisper Bluetooth Keyboard — Termux Setup ==="
echo ""

# 1. Update packages
echo "[1/9] Updating Termux packages..."
pkg update -y && pkg upgrade -y

# 2. Install build tools and Python
echo "[2/9] Installing build tools and Python..."
pkg install -y clang cmake make git tmux termux-api socat ffmpeg python bzip2
pip install flask

# 3. Clone whisper.cpp
echo "[3/9] Cloning whisper.cpp..."
mkdir -p "$INSTALL_DIR"
if [ -d "$INSTALL_DIR/whisper.cpp" ]; then
    echo "  whisper.cpp already cloned, pulling latest..."
    cd "$INSTALL_DIR/whisper.cpp" && git pull
else
    git clone "$WHISPER_REPO" "$INSTALL_DIR/whisper.cpp"
fi

# 4. Build whisper.cpp with ARM64 NEON flags
echo "[4/9] Building whisper.cpp (this may take a few minutes)..."
cd "$INSTALL_DIR/whisper.cpp"
WHISPER_BIN_CLI="$INSTALL_DIR/whisper.cpp/build/bin/whisper-cli"
WHISPER_BIN_MAIN="$INSTALL_DIR/whisper.cpp/build/bin/main"
WHISPER_BIN_SERVER="$INSTALL_DIR/whisper.cpp/build/bin/whisper-server"

# Detect CPU features and pick optimal -march flags (shared with the
# llama.cpp build in step 7)
ARM_MARCH="armv8-a"
CPU_FEATURES=$(cat /proc/cpuinfo 2>/dev/null | grep -i "Features" | head -1 || true)
if echo "$CPU_FEATURES" | grep -q "asimddp"; then
    # CPU supports dot product — safe to use armv8.2-a+dotprod
    if echo "$CPU_FEATURES" | grep -q "fphp"; then
        ARM_MARCH="armv8.2-a+dotprod+fp16"
    else
        ARM_MARCH="armv8.2-a+dotprod"
    fi
fi

if [ -x "$WHISPER_BIN_CLI" ] || [ -x "$WHISPER_BIN_MAIN" ]; then
    echo "  whisper.cpp already built, skipping compile step."
    echo "  (Delete $INSTALL_DIR/whisper.cpp/build to force rebuild)"
else
    echo "  CPU features detected, using: -march=$ARM_MARCH"

    # GGML_NATIVE=OFF prevents ggml from auto-detecting -mcpu=native,
    # which can emit instructions the CPU doesn't actually support (SIGILL).
    # We pass our own -march via CMAKE_{C,CXX}_FLAGS instead.
    cmake -B build \
        -DCMAKE_C_FLAGS="-march=$ARM_MARCH" \
        -DCMAKE_CXX_FLAGS="-march=$ARM_MARCH" \
        -DGGML_NATIVE=OFF \
        -DGGML_FLASH_ATTN=OFF \
        -DWHISPER_NO_ACCELERATE=ON \
        -DWHISPER_BUILD_SERVER=ON \
        -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
    cmake --build build --config Release -j"$(nproc)"
fi

# 5. Download default model
echo "[5/9] Downloading default model ($DEFAULT_MODEL)..."
mkdir -p "$INSTALL_DIR/models"
if [ -f "$INSTALL_DIR/models/$DEFAULT_MODEL" ]; then
    echo "  Model already exists, skipping download."
else
    curl -L -o "$INSTALL_DIR/models/$DEFAULT_MODEL" \
        "$MODEL_REPO/$DEFAULT_MODEL"
fi

# 6. Parakeet engine (optional but recommended — faster + more accurate).
# Failure here is non-fatal: the server falls back to whisper.cpp.
echo "[6/9] Installing Parakeet engine (sherpa-onnx, optional)..."
PARAKEET_DIR="sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
PARAKEET_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${PARAKEET_DIR}.tar.bz2"
PARAKEET_OK=0
# Either backend works: sherpa-onnx (pip, non-Termux) or onnxruntime
# (prebuilt Termux package — pip can't build numpy/onnxruntime against
# Android's libc, so use pkg, never pip, for these).
if python3 -c "import sherpa_onnx, numpy" 2>/dev/null || python3 -c "import onnxruntime, numpy" 2>/dev/null; then
    echo "  Parakeet backend already installed."
    PARAKEET_OK=1
else
    echo "  Installing onnxruntime + numpy (prebuilt Termux packages)..."
    pkg install -y python-numpy python-onnxruntime || true
    if python3 -c "import onnxruntime, numpy" 2>/dev/null; then
        PARAKEET_OK=1
    else
        echo "  WARNING: onnxruntime/numpy install failed — Parakeet engine unavailable."
        echo "  The server will use whisper.cpp instead. To retry later:"
        echo "    pkg install python-numpy python-onnxruntime && ./update-model.sh parakeet"
    fi
fi
if [ "$PARAKEET_OK" = "1" ]; then
    if [ -f "$INSTALL_DIR/models/$PARAKEET_DIR/tokens.txt" ]; then
        echo "  Parakeet model already downloaded."
    else
        echo "  Downloading Parakeet model (~480 MB)..."
        if curl -L --progress-bar -o "$INSTALL_DIR/models/${PARAKEET_DIR}.tar.bz2" "$PARAKEET_URL" \
            && tar xjf "$INSTALL_DIR/models/${PARAKEET_DIR}.tar.bz2" -C "$INSTALL_DIR/models"; then
            rm -f "$INSTALL_DIR/models/${PARAKEET_DIR}.tar.bz2"
            echo "  Parakeet model installed."
        else
            rm -f "$INSTALL_DIR/models/${PARAKEET_DIR}.tar.bz2"
            PARAKEET_OK=0
            echo "  WARNING: Parakeet model download failed. To retry later:"
            echo "    ./update-model.sh parakeet"
        fi
    fi
fi

# 7. Speech cleanup LLM (optional — a small local model strips filler words
# and false starts, applies spoken self-corrections, and fixes punctuation on
# the final transcript). Failure here is non-fatal: the whisper server just
# reports cleanup as unavailable.
echo "[7/9] Installing speech cleanup LLM (llama.cpp + Qwen3, optional)..."
LLAMA_REPO="https://github.com/ggml-org/llama.cpp.git"
LLAMA_BIN_SERVER="$INSTALL_DIR/llama.cpp/build/bin/llama-server"
# Keep the model file name in sync with whisper-server.py and update-model.sh
CLEANUP_MODEL_FILE="Qwen3-1.7B-Q4_K_M.gguf"
CLEANUP_MODEL_URL="https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/${CLEANUP_MODEL_FILE}"
CLEANUP_OK=0
if [ -x "$LLAMA_BIN_SERVER" ]; then
    echo "  llama.cpp already built, skipping compile step."
    CLEANUP_OK=1
else
    if [ ! -d "$INSTALL_DIR/llama.cpp" ]; then
        git clone "$LLAMA_REPO" "$INSTALL_DIR/llama.cpp" || true
    else
        # A clone without a built binary is left over from a failed build —
        # pull latest so upstream fixes (and the MTMD_VIDEO guard) are present.
        (cd "$INSTALL_DIR/llama.cpp" && git pull) || true
    fi
    # Same -march story as whisper.cpp: GGML_NATIVE=OFF avoids SIGILL from
    # -mcpu=native; LLAMA_CURL=OFF drops the libcurl dependency (models are
    # downloaded with curl below, not by llama-server).
    # MTMD_VIDEO=OFF: mtmd's video support (on by default) pulls in a vendored
    # subprocess.h that needs spawn.h, which Termux's libc doesn't ship — the
    # build dies there. Cleanup only sends text, so video support is unneeded.
    if [ -d "$INSTALL_DIR/llama.cpp" ] \
        && (cd "$INSTALL_DIR/llama.cpp" \
            && cmake -B build \
                -DCMAKE_C_FLAGS="-march=$ARM_MARCH" \
                -DCMAKE_CXX_FLAGS="-march=$ARM_MARCH" \
                -DGGML_NATIVE=OFF \
                -DLLAMA_CURL=OFF \
                -DLLAMA_BUILD_SERVER=ON \
                -DMTMD_VIDEO=OFF \
            && cmake --build build --config Release -j"$(nproc)" --target llama-server); then
        CLEANUP_OK=1
    else
        echo "  WARNING: llama.cpp build failed — speech cleanup unavailable."
        echo "  The rest of the system works without it. To retry later, re-run setup-termux.sh."
    fi
fi
if [ "$CLEANUP_OK" = "1" ]; then
    if [ -f "$INSTALL_DIR/models/$CLEANUP_MODEL_FILE" ]; then
        echo "  Cleanup model already downloaded."
    else
        echo "  Downloading cleanup model (~1.1 GB)..."
        if curl -L --progress-bar -o "$INSTALL_DIR/models/$CLEANUP_MODEL_FILE" "$CLEANUP_MODEL_URL"; then
            echo "  Cleanup model installed."
        else
            rm -f "$INSTALL_DIR/models/$CLEANUP_MODEL_FILE"
            CLEANUP_OK=0
            echo "  WARNING: cleanup model download failed. To retry later:"
            echo "    ./update-model.sh cleanup"
        fi
    fi
fi

# 8. Copy scripts
echo "[8/9] Setting up scripts..."
MISSING_SCRIPTS=()
for script in whisper-server.py parakeet_onnx.py start-whisper-server.sh stop-whisper-server.sh update-model.sh diagnose-sigill.sh; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        cp "$SCRIPT_DIR/$script" "$INSTALL_DIR/$script"
        chmod +x "$INSTALL_DIR/$script"
        echo "  Installed $script"
    else
        MISSING_SCRIPTS+=("$script")
    fi
done
if [ ${#MISSING_SCRIPTS[@]} -gt 0 ]; then
    echo ""
    echo "Error: The following scripts were not found in $SCRIPT_DIR:"
    for s in "${MISSING_SCRIPTS[@]}"; do
        echo "  - $s"
    done
    echo ""
    echo "Please ensure you are running setup-termux.sh from the whisper-hid/scripts/"
    echo "directory of a complete git clone:"
    echo "  git clone <repo-url>"
    echo "  cd whisper-hid/scripts && bash setup-termux.sh"
    exit 1
fi

# 9. Set up Termux:Boot auto-start (optional)
echo "[9/9] Setting up Termux:Boot auto-start..."
BOOT_DIR="$HOME/.termux/boot"
mkdir -p "$BOOT_DIR"
cat > "$BOOT_DIR/start-whisper-server" << 'BOOTEOF'
#!/data/data/com.termux/files/usr/bin/bash
# Auto-start Whisper server on boot
sleep 5  # Wait for system to settle
INSTALL_DIR="$HOME/whisper-stt"
if [ -f "$INSTALL_DIR/start-whisper-server.sh" ]; then
    cd "$INSTALL_DIR" && bash start-whisper-server.sh
fi
BOOTEOF
chmod +x "$BOOT_DIR/start-whisper-server"
echo "  Termux:Boot script installed at $BOOT_DIR/start-whisper-server"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Installation directory: $INSTALL_DIR"
echo "Model: $INSTALL_DIR/models/$DEFAULT_MODEL"
if [ -x "$INSTALL_DIR/whisper.cpp/build/bin/whisper-cli" ]; then
    echo "Whisper binary: $INSTALL_DIR/whisper.cpp/build/bin/whisper-cli"
else
    echo "Whisper binary: $INSTALL_DIR/whisper.cpp/build/bin/main"
fi
if [ -x "$WHISPER_BIN_SERVER" ]; then
    echo "Whisper server: $WHISPER_BIN_SERVER (persistent mode — model loaded once)"
else
    echo "Whisper server: not built (will use subprocess mode)"
fi
if [ "$PARAKEET_OK" = "1" ] && [ -f "$INSTALL_DIR/models/$PARAKEET_DIR/tokens.txt" ]; then
    echo "Parakeet engine: installed (used automatically — faster + more accurate)"
else
    echo "Parakeet engine: not installed (whisper.cpp will be used)"
fi
if [ "$CLEANUP_OK" = "1" ] && [ -f "$INSTALL_DIR/models/$CLEANUP_MODEL_FILE" ]; then
    echo "Speech cleanup LLM: installed (toggle it from the PWA Talk screen)"
else
    echo "Speech cleanup LLM: not installed (dictation works without it)"
fi
echo ""
echo "Next steps:"
echo "  1. Grant Termux:API microphone permission"
echo "  2. Start the Whisper HID Service Android app"
echo "  3. Run: cd $INSTALL_DIR && ./start-whisper-server.sh"
echo "  4. Open the PWA from the Android app's 'Open Whisper Keyboard' button"
echo ""
echo "To update after code changes:"
echo "  cd $(dirname $INSTALL_DIR)/whisper-hid"
echo "  scripts/stop-whisper-server.sh && git pull && scripts/start-whisper-server.sh"
echo ""
echo "To swap models: ./update-model.sh <model-name>"
echo "  Available: parakeet, tiny.en, base.en, small.en, distil-small.en"
echo "  Note: Restart the Whisper server after swapping models."
