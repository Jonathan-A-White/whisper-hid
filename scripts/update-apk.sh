#!/data/data/com.termux/files/usr/bin/bash
# update-apk.sh — Download and install the latest Whisper Keyboard APK
#
# Run inside Termux:
#   ./update-apk.sh
#
# Fetches the latest Android app APK from the rolling `latest-apk` GitHub
# Release (updated by CI on every push to main) and opens the Android
# installer. Safe to re-run any time a new APK build is available.
set -euo pipefail

REPO_URL="https://github.com/Jonathan-A-White/whisper-hid"
# Rolling release updated by CI on every push to main; fall back to the
# latest tagged release if it doesn't exist yet.
APK_URLS=(
    "$REPO_URL/releases/download/latest-apk/app-debug.apk"
    "$REPO_URL/releases/latest/download/app-debug.apk"
)
APK_PATH="$HOME/whisper-keyboard.apk"

echo "Downloading latest Android app APK..."
APK_OK=false
for url in "${APK_URLS[@]}"; do
    if curl -fSL --progress-bar --retry 3 -o "$APK_PATH" "$url"; then
        APK_OK=true
        break
    fi
done

if [ "$APK_OK" = false ]; then
    echo "Error: could not download the APK from GitHub Releases."
    echo "Download it manually from $REPO_URL/releases or build with ./gradlew assembleDebug."
    exit 1
fi

echo "APK saved to $APK_PATH — opening Android installer..."
echo "(If nothing happens, open the file manually and allow installs from Termux.)"
termux-open "$APK_PATH" || {
    echo "Could not open installer automatically. Open $APK_PATH manually."
    exit 1
}
