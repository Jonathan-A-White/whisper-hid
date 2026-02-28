#!/data/data/com.termux/files/usr/bin/bash
# start-whisper-server.sh — Start the Whisper HTTP server in a tmux session
set -euo pipefail

INSTALL_DIR="${WHISPER_INSTALL_DIR:-$HOME/whisper-stt}"
SESSION_NAME="whisper-server"
SERVER_SCRIPT="$INSTALL_DIR/whisper-server.py"

if [ ! -f "$SERVER_SCRIPT" ]; then
    echo "Error: whisper-server.py not found at $SERVER_SCRIPT"
    echo "Run setup-termux.sh first."
    exit 1
fi

# Check if already running
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Whisper server is already running in tmux session '$SESSION_NAME'."
    echo "To view: tmux attach -t $SESSION_NAME"
    echo "To stop:  ./stop-whisper-server.sh"
    exit 0
fi

# Start in a new tmux session
tmux new-session -d -s "$SESSION_NAME" \
    "cd '$INSTALL_DIR' && python3 whisper-server.py; echo 'Server exited. Press Enter to close.'; read"

echo "Whisper server started in tmux session '$SESSION_NAME'."
echo "  View logs:  tmux attach -t $SESSION_NAME"
echo "  Stop:       ./stop-whisper-server.sh"
echo "  Health:     curl http://localhost:9876/status"
