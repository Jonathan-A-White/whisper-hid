#!/data/data/com.termux/files/usr/bin/bash
# bootstrap.sh — One-command setup for a new phone.
#
# Run inside Termux:
#   curl -fsSL https://raw.githubusercontent.com/Jonathan-A-White/whisper-hid/main/scripts/bootstrap.sh | bash
#
# Clones the repo, runs the full Termux setup (whisper.cpp build + model
# download), fetches the latest Android app APK and opens the installer,
# then starts the Whisper server. Safe to re-run — every step is idempotent.
#
# Note: commands that might read from stdin get `< /dev/null` so they can't
# swallow the rest of this script when it is piped into bash.
set -euo pipefail

REPO_URL="https://github.com/Jonathan-A-White/whisper-hid"
REPO_DIR="$HOME/whisper-hid"
# Rolling release updated by CI on every push to main; fall back to the
# latest tagged release if it doesn't exist yet.
APK_URLS=(
    "$REPO_URL/releases/download/latest-apk/app-debug.apk"
    "$REPO_URL/releases/latest/download/app-debug.apk"
)
APK_PATH="$HOME/whisper-keyboard.apk"
PWA_URL="https://jonathan-a-white.github.io/whisper-hid/"

step() { echo ""; echo "==> $*"; }
warn() { echo "  WARNING: $*"; }

# --- Preflight ---------------------------------------------------------
if [ ! -d "/data/data/com.termux" ] || [ -z "${PREFIX:-}" ]; then
    echo "Error: this script must be run inside Termux on Android."
    echo "Install Termux from F-Droid: https://f-droid.org/en/packages/com.termux/"
    exit 1
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ]; then
    echo "Error: unsupported architecture '$ARCH' — this project requires ARM64 (aarch64)."
    exit 1
fi

step "[1/5] Installing git and curl..."
pkg install -y git curl < /dev/null

step "[2/5] Cloning whisper-hid repo..."
if [ -d "$REPO_DIR/.git" ]; then
    echo "  Repo already cloned, pulling latest..."
    git -C "$REPO_DIR" pull --ff-only < /dev/null
else
    git clone "$REPO_URL" "$REPO_DIR" < /dev/null
fi

step "[3/5] Running Termux setup (builds whisper.cpp — takes a few minutes on first run)..."
bash "$REPO_DIR/scripts/setup-termux.sh" < /dev/null

step "[4/5] Downloading latest Android app APK..."
APK_OK=false
for url in "${APK_URLS[@]}"; do
    if curl -fSL --retry 3 -o "$APK_PATH" "$url" < /dev/null; then
        APK_OK=true
        break
    fi
done
if [ "$APK_OK" = true ]; then
    echo "  APK saved to $APK_PATH — opening Android installer..."
    echo "  (If nothing happens, open the file manually and allow installs from Termux.)"
    termux-open "$APK_PATH" || warn "Could not open installer automatically. Open $APK_PATH manually."
else
    warn "Could not download the APK from GitHub Releases."
    warn "Download it manually from $REPO_URL/releases or build with ./gradlew assembleDebug."
fi

step "[5/5] Starting Whisper server..."
bash "$REPO_DIR/scripts/start-whisper-server.sh" < /dev/null

# Termux:API check — termux-toast hangs if the Termux:API *app* is missing,
# so a timeout doubles as a presence test.
TERMUX_API_OK=true
if ! timeout 5 termux-toast "Whisper setup" >/dev/null 2>&1; then
    TERMUX_API_OK=false
fi

echo ""
echo "=== Bootstrap complete ==="
echo ""
if [ "$TERMUX_API_OK" = false ]; then
    echo "ACTION NEEDED: Termux:API app not responding. Install it from F-Droid:"
    echo "  https://f-droid.org/en/packages/com.termux.api/"
    echo "Then grant it microphone permission in Android Settings."
    echo ""
fi
echo "Remaining manual steps:"
echo "  1. Install the Whisper Keyboard app (installer should have opened above)"
echo "  2. Grant Termux:API microphone permission (Android Settings > Apps > Termux:API)"
echo "  3. Open the Whisper Keyboard app and tap 'Open Whisper Keyboard'"
echo "  4. On your laptop, pair Bluetooth with 'Whisper Keyboard'"
echo ""
echo "The PWA has a guided setup checklist that detects each step automatically:"
echo "  $PWA_URL"
