#!/data/data/com.termux/files/usr/bin/bash
# stop-stt.sh — Gracefully stop the STT pipeline
#
# Sends SIGTERM to the start-stt.sh tmux session / background processes.
# Usage: bash scripts/stop-stt.sh

set -euo pipefail

SESSION_NAME="whisper-stt"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "[INFO] Stopping tmux session '$SESSION_NAME'…"
    tmux send-keys -t "$SESSION_NAME" C-c ""
    sleep 1
    tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
    echo "[INFO] Session stopped."
else
    echo "[WARN] No tmux session '$SESSION_NAME' found."
fi

# Also kill any stray whisper-main or socat processes
pkill -f "whisper-main\|whisper.cpp/build/bin/main" 2>/dev/null && echo "[INFO] Killed whisper process." || true
pkill -f "socat.*9876" 2>/dev/null && echo "[INFO] Killed socat process." || true

echo "[INFO] Done."
