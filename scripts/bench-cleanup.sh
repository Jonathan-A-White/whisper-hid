#!/data/data/com.termux/files/usr/bin/bash
# bench-cleanup.sh — Time each installed speech-cleanup model on this phone.
#
# For every *.gguf in the models dir it starts a llama-server (on its own port,
# so the running Whisper server and its resident model are never touched),
# runs the same three cleanup requests (a short, a 20-second and a 60-second
# dictation, fixed below), and prints one row per model: size on disk, seconds
# to load, and seconds per cleanup. The bench server is stopped afterwards.
#
# Usage: bench-cleanup.sh [--dry-run]
#   --dry-run   print the plan (models, prompts, port); start nothing
#
# Env: WHISPER_INSTALL_DIR (~/whisper-stt), BENCH_PORT (9889), BENCH_RUNS (3
# timed runs per prompt after one untimed warm-up), BENCH_LOAD_TIMEOUT (180 s),
# CLEANUP_THREADS (4, same as the server).
#
# Memory: the bench model loads next to the server's resident one. If a big
# model will not fit, stop the Whisper server first (stop-whisper-server.sh).
set -euo pipefail

INSTALL_DIR="${WHISPER_INSTALL_DIR:-$HOME/whisper-stt}"
MODEL_DIR="$INSTALL_DIR/models"
SERVER_BIN="$INSTALL_DIR/llama.cpp/build/bin/llama-server"
PORT="${BENCH_PORT:-9889}"
RUNS="${BENCH_RUNS:-3}"
LOAD_TIMEOUT="${BENCH_LOAD_TIMEOUT:-180}"
THREADS="${CLEANUP_THREADS:-4}"

DRY_RUN=0
case "${1:-}" in
    "") ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

# The three dictations. A person talks at about 150 words a minute, so the
# 20-second one is ~50 words and the 60-second one ~150.
PROMPT_SHORT="so um I think we should uh send the report to Mike no wait send it to Sarah by friday"
PROMPT_20S="so um the thing I wanted to to talk about is the login page right now when you tap the button it takes like three seconds before anything happens so I want to show the screen first and load the profile in the background no wait let us keep the spinner but only for one second and then show the screen"
PROMPT_60S="okay so um let me give you the full picture on the release because there are a few things going on at once the first thing is that the build from tuesday I mean wednesday is still failing on the android side and I think it is the signing step because the keystore path changed when we moved the repo so I need to fix that first and after that we can look at the server where the the cleanup model takes too long on long dictations like it takes maybe ten seconds when you talk for a whole minute and that is way too slow it should feel about as fast as the speech recognition so I want to try a couple of smaller models and time them on the actual phone not the laptop then we pick one send the report to Mike no scratch that send it to Sarah and she can decide whether to change the default and we also need to update the docs so the next person knows how to run the benchmark thanks"

# Same rewrite rules as CLEANUP_SYSTEM_PROMPT / CLEANUP_EXAMPLES (standard
# style) in whisper-server.py, so the timing matches what Stop pays.
SYSTEM_PROMPT='/no_think You clean up raw speech-to-text transcripts. Rewrite the transcript with:
- filler words (um, uh, you know), false starts, and stuttered/repeated words removed
- spoken self-corrections resolved, keeping only the corrected version — the speaker signals these with phrases like "no wait", "I mean", "actually", "sorry", "scratch that"; drop both the marker and the words it corrects
- punctuation, capitalization, and sentence breaks fixed
Never paraphrase, reorder, summarize, or add words — keep the speaker'"'"'s exact wording apart from those removals and fixes. Reply with ONLY the cleaned transcript.'

word_count() { printf '%s' "$1" | wc -w | tr -d ' '; }

shopt -s nullglob
MODELS=("$MODEL_DIR"/*.gguf)
if [ "${#MODELS[@]}" -eq 0 ]; then
    echo "No models (*.gguf) in $MODEL_DIR." >&2
    echo "Download one: ./update-model.sh cleanup (or cleanup-2b, cleanup-0.8b, cleanup-4b)" >&2
    exit 1
fi

mb_of() { echo $(( ($(wc -c < "$1") + 524288) / 1048576 )); }

if [ "$DRY_RUN" = "1" ]; then
    echo "Cleanup bench — dry run (nothing is started)"
    echo "  llama-server: $SERVER_BIN"
    echo "  port:         $PORT (the Whisper server's own llama-server is left alone)"
    echo "  per model:    start, wait up to ${LOAD_TIMEOUT}s for /health, 1 warm-up, then $RUNS timed run(s) of each prompt, stop"
    echo "  prompts:"
    echo "    short:      $(word_count "$PROMPT_SHORT") words"
    echo "    20-second:  $(word_count "$PROMPT_20S") words"
    echo "    60-second:  $(word_count "$PROMPT_60S") words"
    echo "  models:"
    for m in "${MODELS[@]}"; do
        echo "    $(basename "$m")  $(mb_of "$m") MB"
    done
    exit 0
fi

if [ ! -x "$SERVER_BIN" ]; then
    echo "llama-server not found at $SERVER_BIN — run setup-termux.sh to build it." >&2
    exit 1
fi

SERVER_PID=""
stop_bench_server() {
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
        SERVER_PID=""
    fi
}
trap stop_bench_server EXIT

now() { date +%s.%N; }

# chat_seconds PROMPT — one cleanup request; prints seconds taken, fails on error.
chat_seconds() {
    SYSTEM_PROMPT="$SYSTEM_PROMPT" python3 -I -c '
import json, os, sys, time, urllib.request
port, text = sys.argv[1], sys.argv[2]
payload = {
    "messages": [
        {"role": "system", "content": os.environ["SYSTEM_PROMPT"]},
        {"role": "user", "content": "so um I think we should uh we should probably start with the the login page"},
        {"role": "assistant", "content": "I think we should probably start with the login page."},
        {"role": "user", "content": "the demo is on tuesday I mean wednesday at ten"},
        {"role": "assistant", "content": "The demo is on Wednesday at ten."},
        {"role": "user", "content": text},
    ],
    "temperature": 0,
    "max_tokens": max(64, len(text) // 2),
}
req = urllib.request.Request(
    "http://127.0.0.1:%s/v1/chat/completions" % port,
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
)
t0 = time.time()
with urllib.request.urlopen(req, timeout=300) as r:
    json.loads(r.read())["choices"][0]["message"]["content"]
print("%.2f" % (time.time() - t0))
' "$PORT" "$1"
}

# median of the numbers on stdin
median() {
    sort -n | awk '{ a[NR] = $1 } END { if (NR == 0) print "0.00"; else if (NR % 2) printf "%.2f\n", a[(NR + 1) / 2]; else printf "%.2f\n", (a[NR / 2] + a[NR / 2 + 1]) / 2 }'
}

# bench_prompt PROMPT — median seconds over RUNS timed requests
bench_prompt() {
    local i out=""
    for ((i = 0; i < RUNS; i++)); do
        out+="$(chat_seconds "$1")"$'\n'
    done
    printf '%s' "$out" | median
}

printf '%-30s %7s %8s %8s %8s %8s %8s\n' model MB load_s short_s 20s_s 60s_s median_s
for m in "${MODELS[@]}"; do
    name="$(basename "$m")"
    mb="$(mb_of "$m")"
    t0="$(now)"
    "$SERVER_BIN" --model "$m" --host 127.0.0.1 --port "$PORT" \
        --ctx-size 4096 --threads "$THREADS" >/dev/null 2>&1 &
    SERVER_PID=$!

    ready=0
    for ((i = 0; i < LOAD_TIMEOUT; i++)); do
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
        if curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ready=1; break; fi
        sleep 1
    done
    if [ "$ready" != "1" ]; then
        printf '%-30s %7s  FAILED to load (exited, or not ready in %ss)\n' "$name" "$mb" "$LOAD_TIMEOUT"
        stop_bench_server
        continue
    fi
    load_s="$(awk -v a="$t0" -v b="$(now)" 'BEGIN { printf "%.2f", b - a }')"

    if ! chat_seconds "$PROMPT_SHORT" >/dev/null 2>&1; then   # warm-up, untimed
        printf '%-30s %7s %8s  FAILED: cleanup request errored\n' "$name" "$mb" "$load_s"
        stop_bench_server
        continue
    fi
    s_short="$(bench_prompt "$PROMPT_SHORT")"
    s_20="$(bench_prompt "$PROMPT_20S")"
    s_60="$(bench_prompt "$PROMPT_60S")"
    s_all="$(printf '%s\n%s\n%s\n' "$s_short" "$s_20" "$s_60" | median)"
    printf '%-30s %7s %8s %8s %8s %8s %8s\n' "$name" "$mb" "$load_s" "$s_short" "$s_20" "$s_60" "$s_all"
    stop_bench_server
done
echo
echo "median_s = median of the three prompts' medians; Parakeet runs at ~0.1x the audio length for comparison."
