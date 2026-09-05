#!/data/data/com.termux/files/usr/bin/bash
# update-apk.sh — Download and install the latest Whisper Keyboard APK
#
# Run inside Termux:
#   ./update-apk.sh              # download, stage, open the installer
#   ./update-apk.sh --no-clean   # keep old APKs / CI artifact folders
#   ./update-apk.sh --no-open    # download and stage only, don't launch the installer
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
APK_NAME="whisper-keyboard.apk"
APK_PATH="$HOME/$APK_NAME"
DOWNLOADS="$HOME/storage/downloads"

DO_CLEAN=true
DO_OPEN=true
for arg in "$@"; do
    case "$arg" in
        --no-clean) DO_CLEAN=false ;;
        --no-open)  DO_OPEN=false ;;
        -h|--help)  sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
    esac
done

warn() { echo "  WARNING: $*"; }

# --- Termux's content provider ----------------------------------------
# termux-open hands the APK to Android's package installer through
# TermuxContentProvider, which refuses to serve other apps unless
# `allow-external-apps` is true. Without it the installer never appears and
# you get "TermuxContentProvider requires `allow-external-apps` property to
# be set to `true`" instead.
ensure_allow_external_apps() {
    local props="$HOME/.termux/termux.properties"
    mkdir -p "$HOME/.termux"
    touch "$props"

    if grep -qE '^[[:space:]]*allow-external-apps[[:space:]]*=[[:space:]]*true' "$props"; then
        return 0
    fi

    if grep -qE '^[[:space:]]*allow-external-apps[[:space:]]*=' "$props"; then
        echo "  Setting allow-external-apps = true in $props (was disabled)"
        sed -i 's|^[[:space:]]*allow-external-apps[[:space:]]*=.*|allow-external-apps = true|' "$props"
    else
        echo "  Adding allow-external-apps = true to $props"
        printf '\nallow-external-apps = true\n' >> "$props"
    fi

    termux-reload-settings 2>/dev/null || warn "termux-reload-settings failed — restart Termux if the installer doesn't open."
}

# --- Shared storage ----------------------------------------------------
# Staging a copy in ~/storage/downloads (Android's /sdcard/Download) gives a
# reliable fallback: the Files app can install it directly, with no content
# provider or app chooser in the way. termux-setup-storage prompts for
# confirmation when ~/storage already exists, so only run it when it can't,
# otherwise it blocks a non-interactive run.
ensure_shared_storage() {
    if [ -d "$DOWNLOADS" ]; then
        return 0
    fi
    if [ -e "$HOME/storage" ]; then
        warn "$HOME/storage exists but has no downloads/ link."
        warn "Run 'termux-setup-storage' manually (answer y) to rebuild it."
        return 1
    fi
    echo "  Requesting shared storage access (grant the Android permission prompt)..."
    termux-setup-storage < /dev/null || return 1
    # The permission dialog is asynchronous; give the symlinks a moment.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        [ -d "$DOWNLOADS" ] && return 0
        sleep 1
    done
    [ -d "$DOWNLOADS" ]
}

# --- Cleanup -----------------------------------------------------------
# Only ever removes this project's own build artifacts, by name: unzipped
# CI artifact folders (whisper-keyboard-debug*), their zips, and previous
# APK copies. The APK staged by THIS run is skipped.
clean_old_artifacts() {
    local dir="$1" staged="$2" removed=0 item
    [ -d "$dir" ] || return 0

    shopt -s nullglob
    for item in "$dir"/whisper-keyboard-debug* \
                "$dir"/app-debug*.apk \
                "$dir"/whisper-keyboard*.apk; do
        [ "$item" = "$staged" ] && continue
        echo "  Removing $item"
        rm -rf -- "$item" && removed=$((removed + 1))
    done
    shopt -u nullglob

    if [ "$removed" -eq 0 ]; then
        echo "  Nothing to clean in $dir"
    else
        echo "  Removed $removed old artifact(s) from $dir"
    fi
}

# --- Download ----------------------------------------------------------
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
echo "APK saved to $APK_PATH ($(du -h "$APK_PATH" | cut -f1))"

# --- Stage on shared storage ------------------------------------------
STAGED=""
if ensure_shared_storage; then
    STAGED="$DOWNLOADS/$APK_NAME"
    cp "$APK_PATH" "$STAGED"
    echo "Staged a copy at Internal storage > Download > $APK_NAME"
    # Files written from a shell don't trigger Android's media scanner, so
    # the Files app won't list the APK until it's been indexed.
    termux-media-scan "$STAGED" >/dev/null 2>&1 \
        || warn "termux-media-scan unavailable — the Files app may not list the APK until it rescans."
else
    warn "No shared storage access — skipping the Download folder copy."
fi

if [ "$DO_CLEAN" = true ]; then
    echo "Cleaning up old APKs and CI artifact folders..."
    clean_old_artifacts "$DOWNLOADS" "$STAGED"
fi

# --- Install -----------------------------------------------------------
if [ "$DO_OPEN" = false ]; then
    echo ""
    echo "Skipping the installer (--no-open). Install it yourself from:"
    [ -n "$STAGED" ] && echo "  Files app > Downloads > $APK_NAME"
    echo "  $APK_PATH"
    exit 0
fi

ensure_allow_external_apps

echo ""
echo "Opening the Android installer..."
echo "  If an app chooser appears, pick 'Package installer' — NOT Termux."
echo "  Termux also needs 'Install unknown apps' permission the first time."

# Prefer the shared-storage copy: it goes through Android's own file
# provider rather than TermuxContentProvider, so it can't bounce back into
# Termux as a file share.
OPEN_TARGET="${STAGED:-$APK_PATH}"
if ! termux-open "$OPEN_TARGET"; then
    warn "Could not open the installer automatically."
    if [ -n "$STAGED" ]; then
        echo "  Open the Files app > Downloads > $APK_NAME and tap it."
    else
        echo "  Open $APK_PATH manually."
    fi
    exit 1
fi

echo ""
echo "If the install fails with \"App not installed\", uninstall the existing"
echo "Whisper Keyboard first — debug APKs built before the checked-in keystore"
echo "landed have a different signature and can't be updated over."
