#!/data/data/com.termux/files/usr/bin/bash
# stt-loop.sh — Record audio, transcribe with whisper, output text to stdout
# Called by start-stt.sh via socat for each client connection.
# Supports two modes:
#   - Continuous (default): Record in CHUNK_SEC second chunks automatically
#   - Push-to-talk: Wait for START/STOP commands from the client
# Expects env vars: WHISPER_BIN, MODEL, CHUNK_SEC, AUDIO_DIR,
#                   SILENCE_PATTERNS, RECORD_ARGS, RECORD_EXT

cleanup() {
    # Guard against re-entrant cleanup (EXIT trap fires after signal traps)
    [ "${_CLEANING_UP:-}" = 1 ] && return
    _CLEANING_UP=1
    termux-microphone-record -q 0</dev/null 1>&2 2>/dev/null || true
    rm -f "$AUDIO_DIR"/chunk_$$_raw.* "$AUDIO_DIR"/chunk_$$_ptt_*.* \
          "$AUDIO_DIR"/chunk_$$.wav "$AUDIO_DIR"/chunk_$$_[0-9]*.wav
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

# --- Shared transcription helpers ---

# Detect supported whisper flags once (lazy, on first transcription)
init_whisper_flags() {
    if [ -z "${WHISPER_FLAGS+x}" ]; then
        WHISPER_HELP=$("$WHISPER_BIN" --help 2>&1 || true)
        WHISPER_FLAGS="-m $MODEL -l en"
        # Disable GPU — no CUDA/Metal in Termux
        if echo "$WHISPER_HELP" | grep -q -- '--no-gpu'; then
            WHISPER_FLAGS="$WHISPER_FLAGS -ng"
        fi
        # Disable timestamps for cleaner output
        if echo "$WHISPER_HELP" | grep -q -- '--no-timestamps'; then
            WHISPER_FLAGS="$WHISPER_FLAGS --no-timestamps"
        fi
        # Disable flash attention — enabled by default since v1.8.0,
        # causes SIGILL on some ARM CPUs (CPU-only, no kernel support)
        if echo "$WHISPER_HELP" | grep -q -- '--no-flash-attn'; then
            WHISPER_FLAGS="$WHISPER_FLAGS -nfa"
        fi
        # -f must be last (takes the filename argument)
        WHISPER_FLAGS="$WHISPER_FLAGS -f"
        echo "  [whisper-flags] $WHISPER_FLAGS" >&2
    fi
}

# transcribe_and_send RAW_FILE AUDIO_FILE
# Converts raw audio to WAV, runs whisper, sends result to stdout (the socket).
# Returns 0 on success, 1 if the socket write fails (caller should exit).
transcribe_and_send() {
    local raw_file="$1" audio_file="$2"

    # Verify raw audio file exists and has content
    if [ ! -s "$raw_file" ]; then
        echo "  [skip] No audio captured" >&2
        rm -f "$raw_file"
        return 0
    fi
    local raw_size
    raw_size=$(stat -c%s "$raw_file" 2>/dev/null || echo 0)
    echo "  [rec] raw=${raw_size}B" >&2

    # Convert to 16kHz 16-bit mono WAV (required by whisper.cpp)
    if ! ffmpeg -y -i "$raw_file" -ar 16000 -ac 1 -c:a pcm_s16le "$audio_file" </dev/null >/dev/null 2>&1; then
        echo "  [error] ffmpeg conversion failed" >&2
        rm -f "$raw_file" "$audio_file"
        return 0
    fi
    rm -f "$raw_file"

    # Skip if WAV file is too small (silence / no real audio)
    local wav_size
    wav_size=$(stat -c%s "$audio_file" 2>/dev/null || echo 0)
    if [ "$wav_size" -lt 1000 ]; then
        echo "  [skip] WAV too small (${wav_size}B < 1000B)" >&2
        rm -f "$audio_file"
        return 0
    fi
    echo "  [wav] size=${wav_size}B, running whisper..." >&2

    init_whisper_flags

    local whisper_err="$AUDIO_DIR/whisper_stderr_${BASHPID}.txt"
    local whisper_out="$AUDIO_DIR/whisper_stdout_${BASHPID}.txt"
    # shellcheck disable=SC2086
    $WHISPER_BIN $WHISPER_FLAGS "$audio_file" >"$whisper_out" 2>"$whisper_err"
    local whisper_rc=$?
    local raw_whisper
    raw_whisper=$(cat "$whisper_out" 2>/dev/null || true)
    # Show exit code and stderr on failure or empty output
    if [ $whisper_rc -ne 0 ] || [ -z "$raw_whisper" ]; then
        echo "  [whisper-exit] rc=$whisper_rc" >&2
        if [ -s "$whisper_err" ]; then
            grep -vE '^$' "$whisper_err" | while IFS= read -r errline; do
                echo "  [stderr] $errline" >&2
            done
        fi
        if [ -s "$whisper_out" ]; then
            echo "  [stdout] $(cat "$whisper_out")" >&2
        fi
    fi
    rm -f "$whisper_err" "$whisper_out"

    local result
    result=$(echo "$raw_whisper" | \
        sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
        grep -vE "$SILENCE_PATTERNS" || true)

    # Send non-empty transcription to stdout (piped to socket by socat).
    # Check echo's exit status: bash builtins don't reliably trigger the
    # SIGPIPE trap, so the script can keep looping after a broken pipe.
    if [ -n "$result" ]; then
        if ! echo "$result"; then
            echo "  [error] Socket write failed (broken pipe), exiting" >&2
            rm -f "$audio_file"
            return 1
        fi
        echo "  >> $result" >&2
    else
        echo "  [whisper] no speech (raw: $(echo "$raw_whisper" | head -1 | cut -c1-60))" >&2
    fi

    rm -f "$audio_file"
    return 0
}

# --- Continuous mode: record in fixed-length chunks ---
continuous_loop() {
    echo "  [mode] Continuous (${CHUNK_SEC}s chunks)" >&2
    while true; do
        # Exit early if socat has closed stdin (client disconnected).
        # read -t 0 returns 0 when data is available on stdin — which includes
        # the EOF condition that socat signals when the TCP connection closes.
        # A real read that immediately returns non-zero confirms it is EOF.
        if IFS= read -r -t 0 _eofcheck 2>/dev/null; then
            if ! IFS= read -r _eofcheck 2>/dev/null; then
                echo "  [continuous] Client disconnected, exiting" >&2
                break
            fi
        fi

        RAW_FILE="$AUDIO_DIR/chunk_${$}_raw.$RECORD_EXT"
        AUDIO_FILE="$AUDIO_DIR/chunk_${$}.wav"

        # shellcheck disable=SC2086
        termux-microphone-record -f "$RAW_FILE" -l "$CHUNK_SEC" $RECORD_ARGS 0</dev/null 1>&2 2>/dev/null

        # Wait for the recording to complete. Add 1s buffer beyond the
        # recording limit so the file is fully flushed before we read it.
        sleep "$((CHUNK_SEC + 1))"

        # Stop recording to finalize the file (may already be stopped via -l limit)
        termux-microphone-record -q 0</dev/null 1>&2 2>/dev/null || true
        sleep 1

        transcribe_and_send "$RAW_FILE" "$AUDIO_FILE" || break
    done
}

# --- Push-to-talk mode: wait for START/STOP commands from client ---
ptt_loop() {
    echo "  [mode] Push-to-talk" >&2
    local recording=false
    local raw_file=""
    local ptt_seq=0

    while IFS= read -r cmd; do
        case "$cmd" in
            START)
                if [ "$recording" = true ]; then
                    echo "  [ptt] Already recording, ignoring START" >&2
                    continue
                fi
                ptt_seq=$((ptt_seq + 1))
                raw_file="$AUDIO_DIR/chunk_${$}_ptt_${ptt_seq}.$RECORD_EXT"
                rm -f "$raw_file"
                # Record without time limit — stopped by STOP command
                # shellcheck disable=SC2086
                termux-microphone-record -f "$raw_file" $RECORD_ARGS 0</dev/null 1>&2 2>/dev/null
                recording=true
                echo "  [ptt] Recording started" >&2
                ;;
            STOP)
                if [ "$recording" != true ]; then
                    echo "  [ptt] Not recording, ignoring STOP" >&2
                    continue
                fi
                termux-microphone-record -q 0</dev/null 1>&2 2>/dev/null || true
                recording=false
                # Capture file info before raw_file is reused by the next START
                local bg_raw="$raw_file"
                local bg_seq="$ptt_seq"
                raw_file=""
                # Transcribe in background so the next START is handled immediately
                # instead of waiting for ffmpeg+whisper to finish (avoids missing
                # the start of the next PTT press).
                (
                    sleep 1
                    echo "  [ptt] Recording stopped, transcribing..." >&2
                    bg_audio="$AUDIO_DIR/chunk_${$}_${bg_seq}.wav"
                    transcribe_and_send "$bg_raw" "$bg_audio" || true
                ) &
                ;;
            *)
                echo "  [cmd] Unknown: $cmd" >&2
                ;;
        esac
    done
    # Wait for any in-flight background transcriptions to finish
    wait
}

# --- Mode selection ---
# The client may send a mode line immediately after connecting.
# Wait briefly for it; default to continuous if nothing arrives.
if read -t 2 mode_line; then
    case "$mode_line" in
        MODE:PTT)
            ptt_loop
            ;;
        *)
            continuous_loop
            ;;
    esac
else
    continuous_loop
fi
