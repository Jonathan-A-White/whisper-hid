#!/data/data/com.termux/files/usr/bin/bash
# stop-stt.sh — Gracefully stop the STT process
set -euo pipefail

INSTALL_DIR="$HOME/whisper-stt"
PID_FILE="$INSTALL_DIR/.stt.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "STT is not running (no PID file found)."
    exit 0
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping STT process (PID $PID)..."
    # Kill the process group to include socat and stt-loop.sh children
    kill -- -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
    # Wait for process to exit
    for i in $(seq 1 10); do
        if ! kill -0 "$PID" 2>/dev/null; then
            echo "STT stopped."
            rm -f "$PID_FILE"
            exit 0
        fi
        sleep 0.5
    done
    # Force kill if still running
    echo "Force killing STT process..."
    kill -9 -- -"$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "STT stopped."
else
    echo "STT process (PID $PID) is not running. Cleaning up."
    rm -f "$PID_FILE"
fi

# Kill any orphaned stt-loop.sh processes (SIGKILL — old versions trap TERM)
pkill -9 -f "stt-loop.sh" 2>/dev/null || true

# Stop any lingering recording
termux-microphone-record -q 2>/dev/null || true
