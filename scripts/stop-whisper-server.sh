#!/data/data/com.termux/files/usr/bin/bash
# stop-whisper-server.sh — Stop the Whisper HTTP server
set -euo pipefail

SESSION_NAME="whisper-server"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux send-keys -t "$SESSION_NAME" C-c
    sleep 1
    # If still running, kill the session
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        tmux kill-session -t "$SESSION_NAME"
    fi
    echo "Whisper server stopped."
else
    echo "Whisper server is not running (no tmux session '$SESSION_NAME')."
fi
