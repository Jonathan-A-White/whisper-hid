#!/data/data/com.termux/files/usr/bin/bash
# update-all.sh — Update everything on the phone after merging changes.
#
# Run inside Termux:
#   ~/whisper-hid/scripts/update-all.sh
#
# Pulls the repo, restarts the Whisper server on the new code, then
# downloads and installs the latest APK (staging it in Downloads and
# clearing out old copies). The PWA needs nothing — it's served from
# GitHub Pages and updates itself.
#
# Options:
#   --no-pull     Skip the git pull (use the checkout as-is)
#   --no-apk      Skip the APK download/install (server side only)
#   --no-server   Skip the Whisper server restart (APK only)
#   --no-clean    Keep old APKs and CI artifact folders in Downloads
#   --no-open     Download and stage the APK but don't launch the installer
set -euo pipefail

REPO_DIR="${WHISPER_REPO_DIR:-$HOME/whisper-hid}"
WHISPER_PORT="${WHISPER_PORT:-9876}"
HID_PORT="${HID_PORT:-9877}"

DO_PULL=true
DO_APK=true
DO_SERVER=true
APK_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --no-pull)   DO_PULL=false ;;
        --no-apk)    DO_APK=false ;;
        --no-server) DO_SERVER=false ;;
        --no-clean)  APK_ARGS+=("--no-clean") ;;
        --no-open)   APK_ARGS+=("--no-open") ;;
        -h|--help)   sed -n '2,19p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
    esac
done

step() { echo ""; echo "==> $*"; }
warn() { echo "  WARNING: $*"; }

if [ ! -d "$REPO_DIR/.git" ]; then
    echo "Error: no repo checkout at $REPO_DIR."
    echo "Clone it first, or set WHISPER_REPO_DIR to where it lives."
    exit 1
fi

# Report what a service says its version is, or why it can't be reached.
report_version() {
    local label="$1" port="$2"
    local body
    if ! body="$(curl -fsS --max-time 5 "http://localhost:$port/status" 2>/dev/null)"; then
        echo "  $label: not responding on port $port"
        return
    fi
    echo "  $label: $(printf '%s' "$body" | python3 -c \
        'import json,sys; print(json.load(sys.stdin).get("version","(no version field)"))' \
        2>/dev/null || echo "(unparseable /status)")"
}

if [ "$DO_PULL" = true ]; then
    step "Pulling the latest code..."
    # Runs before everything else so the steps below use the code that was
    # just pulled — including update-apk.sh, which is invoked as a separate
    # process and so picks up its new version even though this script is
    # already running from the old one.
    git -C "$REPO_DIR" pull --ff-only
fi

if [ "$DO_SERVER" = true ]; then
    step "Restarting the Whisper server..."
    # start-whisper-server.sh copies the server scripts from this checkout
    # into the install dir on the way up, so a stop/start is the whole
    # update — setup-termux.sh only needs re-running when the build or
    # model steps change.
    bash "$REPO_DIR/scripts/stop-whisper-server.sh"
    bash "$REPO_DIR/scripts/start-whisper-server.sh"
fi

if [ "$DO_APK" = true ]; then
    step "Updating the Android app..."
    bash "$REPO_DIR/scripts/update-apk.sh" "${APK_ARGS[@]}"
fi

step "Versions"
report_version "Whisper server" "$WHISPER_PORT"
report_version "HID service   " "$HID_PORT"
echo "  PWA: check Settings in the app — it updates itself from GitHub Pages."

echo ""
echo "=== Update complete ==="
if [ "$DO_APK" = true ]; then
    echo "Finish the APK install in the Android installer if it's still open."
    echo "The HID service version above won't change until you reopen the app."
fi
