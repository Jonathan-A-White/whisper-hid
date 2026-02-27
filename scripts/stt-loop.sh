#!/data/data/com.termux/files/usr/bin/bash
# stt-loop.sh — Record audio, transcribe with whisper, output text to stdout
# Called by start-stt.sh via socat for each client connection.
# Expects env vars: WHISPER_BIN, MODEL, CHUNK_SEC, AUDIO_DIR,
#                   SILENCE_PATTERNS, RECORD_ARGS, RECORD_EXT

cleanup() {
    # Guard against re-entrant cleanup (EXIT trap fires after signal traps)
    [ "${_CLEANING_UP:-}" = 1 ] && return
    _CLEANING_UP=1
    termux-microphone-record -q 0</dev/null 1>&2 2>/dev/null || true
    rm -f "$AUDIO_DIR"/chunk_$$_raw.* "$AUDIO_DIR"/chunk_$$.wav
    exit 0
}
trap cleanup EXIT TERM INT PIPE

echo "Client connected" >&2

# socat connects our stdin/stdout to the TCP socket, but termux-microphone-record
# (via termux-api binary) needs a functional stdout for its IPC with the Termux:API app.
# All termux-microphone-record calls redirect: stdin from /dev/null, stdout to
# stderr (the terminal), and suppress stderr — keeping output off the TCP socket
# while giving termux-api a real fd to write to.

# Stop any stale recording from a previous connection
termux-microphone-record -q 0</dev/null 1>&2 2>/dev/null || true

while true; do
    RAW_FILE="$AUDIO_DIR/chunk_${$}_raw.$RECORD_EXT"
    AUDIO_FILE="$AUDIO_DIR/chunk_${$}.wav"

    # Record audio chunk using the format determined at startup.
    # Redirect stdin from /dev/null and stdout to stderr (the terminal) — socat
    # has stdin/stdout wired to the TCP socket.  termux-api needs a functional
    # stdout fd for its IPC with the Termux:API app; /dev/null breaks it.
    # shellcheck disable=SC2086
    termux-microphone-record -f "$RAW_FILE" -l "$CHUNK_SEC" $RECORD_ARGS 0</dev/null 1>&2 2>/dev/null

    # Wait for the recording to complete. Add 1s buffer beyond the recording limit
    # so the file is fully flushed before we try to read it.
    sleep "$((CHUNK_SEC + 1))"

    # Stop recording to finalize the file (may already be stopped via -l limit)
    termux-microphone-record -q 0</dev/null 1>&2 2>/dev/null || true
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
