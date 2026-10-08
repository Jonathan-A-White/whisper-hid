#!/data/data/com.termux/files/usr/bin/bash
# setup-termux.sh — One-time Termux environment setup for Whisper STT
set -euo pipefail

INSTALL_DIR="$HOME/whisper-stt"
# Capture script directory before any cd commands change the working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Whisper Bluetooth Keyboard — Termux Setup ==="
echo ""

# 1. Update packages
echo "[1/6] Updating Termux packages..."
pkg update -y && pkg upgrade -y

# 2. Install build tools and Python
echo "[2/6] Installing build tools and Python..."
# libandroid-spawn: bionic has no spawn.h/posix_spawn; this Termux package
# provides both. llama-server's tool-exec code (vendor/sheredom/subprocess.h)
# needs it — see the llama.cpp build in step 4.
pkg install -y clang cmake make git tmux termux-api socat ffmpeg python bzip2 libandroid-spawn
pip install -r "$SCRIPT_DIR/requirements.txt"

# Detect CPU features and pick optimal -march flags (used by the llama.cpp
# build in step 4)
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
mkdir -p "$INSTALL_DIR/models"

# 3. Parakeet, the speech-to-text engine. The server cannot transcribe without
# it, so a failure here is reported at the end and fails the setup — but the
# remaining steps still run, so a retry only has to redo this one
# (./update-model.sh parakeet).
echo "[3/6] Installing Parakeet speech-to-text engine..."
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
        echo "  Dictation will not work until this is fixed. To retry:"
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

# 4. Speech cleanup LLM (optional — a small local model strips filler words
# and false starts, applies spoken self-corrections, and fixes punctuation on
# the final transcript). Failure here is non-fatal: the whisper server just
# reports cleanup as unavailable.
echo "[4/6] Installing speech cleanup LLM (llama.cpp + Qwen3, optional)..."
LLAMA_REPO="https://github.com/ggml-org/llama.cpp.git"
LLAMA_BIN_SERVER="$INSTALL_DIR/llama.cpp/build/bin/llama-server"
# Keep the model file name in sync with whisper-server.py and update-model.sh
CLEANUP_MODEL_FILE="Qwen3-1.7B-Q4_K_M.gguf"
# unsloth repo: the official Qwen/Qwen3-1.7B-GGUF repo doesn't carry the
# Q4_K_M quant (its /resolve URL returns "Entry not found").
CLEANUP_MODEL_URL="https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/${CLEANUP_MODEL_FILE}"
# A failed download can leave a tiny error-page file — anything smaller than
# this is not a model and gets re-downloaded.
CLEANUP_MODEL_MIN_BYTES=$((10 * 1024 * 1024))
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
    # GGML_NATIVE=OFF avoids SIGILL from
    # -mcpu=native; LLAMA_CURL=OFF drops the libcurl dependency (models are
    # downloaded with curl below, not by llama-server).
    # MTMD_VIDEO=OFF: video decode shells out to ffmpeg at runtime and is
    # unneeded for text-only cleanup — skip building it.
    # -landroid-spawn: llama-server's tool-exec code (vendored subprocess.h)
    # uses posix_spawn, which bionic lacks; the libandroid-spawn package
    # (installed in step 2) supplies spawn.h and the implementation.
    if [ -d "$INSTALL_DIR/llama.cpp" ] \
        && (cd "$INSTALL_DIR/llama.cpp" \
            && cmake -B build \
                -DCMAKE_C_FLAGS="-march=$ARM_MARCH" \
                -DCMAKE_CXX_FLAGS="-march=$ARM_MARCH" \
                -DCMAKE_EXE_LINKER_FLAGS="-landroid-spawn" \
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
    CLEANUP_MODEL_PATH="$INSTALL_DIR/models/$CLEANUP_MODEL_FILE"
    if [ -f "$CLEANUP_MODEL_PATH" ] \
        && [ "$(wc -c < "$CLEANUP_MODEL_PATH")" -lt "$CLEANUP_MODEL_MIN_BYTES" ]; then
        echo "  Existing cleanup model is only $(wc -c < "$CLEANUP_MODEL_PATH") bytes (broken download) — re-downloading."
        rm -f "$CLEANUP_MODEL_PATH"
    fi
    if [ -f "$CLEANUP_MODEL_PATH" ]; then
        echo "  Cleanup model already downloaded."
    else
        echo "  Downloading cleanup model (~1.1 GB)..."
        # -f: fail on an HTTP error instead of saving the error page as the model
        if curl -fL --progress-bar -o "$CLEANUP_MODEL_PATH" "$CLEANUP_MODEL_URL" \
            && [ "$(wc -c < "$CLEANUP_MODEL_PATH")" -ge "$CLEANUP_MODEL_MIN_BYTES" ]; then
            echo "  Cleanup model installed."
        else
            rm -f "$CLEANUP_MODEL_PATH"
            CLEANUP_OK=0
            echo "  WARNING: cleanup model download failed. To retry later:"
            echo "    ./update-model.sh cleanup"
        fi
    fi
fi

# 5. Copy scripts
echo "[5/6] Setting up scripts..."
MISSING_SCRIPTS=()
for script in whisper-server.py parakeet_onnx.py requirements.txt start-whisper-server.sh stop-whisper-server.sh update-model.sh; do
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

# 6. Set up Termux:Boot auto-start (optional)
echo "[6/6] Setting up Termux:Boot auto-start..."
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
if [ "$PARAKEET_OK" = "1" ] && [ -f "$INSTALL_DIR/models/$PARAKEET_DIR/tokens.txt" ]; then
    echo "Parakeet engine: installed"
else
    echo "Parakeet engine: NOT installed — dictation will not work. Fix with:"
    echo "  pkg install python-numpy python-onnxruntime && $INSTALL_DIR/update-model.sh parakeet"
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
echo "To download a model: ./update-model.sh <parakeet|cleanup|cleanup-4b|cleanup-2b|cleanup-0.8b>"
echo "  Note: Restart the Whisper server afterwards."

# Parakeet is required: a setup that left it out has not succeeded.
if [ "$PARAKEET_OK" != "1" ]; then
    exit 1
fi
