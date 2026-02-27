#!/data/data/com.termux/files/usr/bin/bash
# stt-loop.sh — Record audio, transcribe with whisper, output text to stdout
# Called by start-stt.sh via socat for each client connection.
# Expects env vars: WHISPER_BIN, MODEL, CHUNK_SEC, AUDIO_DIR,
#                   SILENCE_PATTERNS, RECORD_ARGS, RECORD_EXT

cleanup() {
    termux-microphone-record -q </dev/null >/dev/null 2>/dev/null || true
    rm -f "$AUDIO_DIR"/chunk_$$_raw.* "$AUDIO_DIR"/chunk_$$.wav
}
trap cleanup EXIT TERM INT PIPE

echo "Client connected" >&2

# Save stderr fd for our own logging, then set up redirects.
# socat connects our stdin/stdout to the TCP socket, but termux-microphone-record
# (via termux-api binary) needs clean I/O for its IPC with the Termux:API app.
# Redirect stdin/stdout on all termux-microphone-record calls to /dev/null.

# Stop any stale recording from a previous connection
termux-microphone-record -q </dev/null >/dev/null 2>/dev/null || true

while true; do
    RAW_FILE="$AUDIO_DIR/chunk_${$}_raw.$RECORD_EXT"
    AUDIO_FILE="$AUDIO_DIR/chunk_${$}.wav"

    # Record audio chunk using the format determined at startup.
    # Redirect stdin/stdout to /dev/null — socat has them wired to the TCP socket
    # which breaks termux-api's internal IPC protocol.
    # shellcheck disable=SC2086
    termux-microphone-record -f "$RAW_FILE" -l "$CHUNK_SEC" $RECORD_ARGS </dev/null >/dev/null 2>/dev/null

    # Wait for the recording to complete. Add 1s buffer beyond the recording limit
    # so the file is fully flushed before we try to read it.
    sleep "$((CHUNK_SEC + 1))"

    # Stop recording to finalize the file (may already be stopped via -l limit)
    termux-microphone-record -q </dev/null >/dev/null 2>/dev/null || true
    sleep 1

    # Verify raw audio file exists and has content
    if [ ! -s "$RAW_FILE" ]; then
        echo "  [skip] No audio captured" >&2
        rm -f "$RAW_FILE"
        continue
    fi

    # Convert to 16kHz 16-bit mono WAV (required by whisper.cpp)
    if ! ffmpeg -y -i "$RAW_FILE" -ar 16000 -ac 1 -c:a pcm_s16le "$AUDIO_FILE" </dev/null >/dev/null 2>&1; then
        echo "  [error] ffmpeg conversion failed" >&2
        rm -f "$RAW_FILE" "$AUDIO_FILE"
        continue
    fi
    rm -f "$RAW_FILE"

    # Skip if WAV file is too small (silence / no real audio)
    WAV_SIZE=$(stat -c%s "$AUDIO_FILE" 2>/dev/null || echo 0)
    if [ "$WAV_SIZE" -lt 1000 ]; then
        rm -f "$AUDIO_FILE"
        continue
    fi

    # Run whisper transcription
    RESULT=$("$WHISPER_BIN" \
        --model "$MODEL" \
        --language en \
        --no-timestamps \
        --no-context \
        --file "$AUDIO_FILE" 2>/dev/null | \
        sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
        grep -vE "$SILENCE_PATTERNS" || true)

    # Send non-empty transcription to stdout (piped to socket by socat)
    if [ -n "$RESULT" ]; then
        echo "$RESULT"
        echo "  >> $RESULT" >&2
    fi

    rm -f "$AUDIO_FILE"
done
