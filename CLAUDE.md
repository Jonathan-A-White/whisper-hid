# Whisper Bluetooth Keyboard

## What this is
Three-component system that turns a Samsung phone into a speech-to-text
Bluetooth keyboard. A PWA provides the UI, a Python+Flask server in Termux
handles mic capture and Whisper transcription, and a headless Kotlin service
sends keystrokes via Bluetooth HID.

## Architecture (SPEC-2)
- Component 1 (PWA): UI + orchestration, hosted on GitHub Pages, saved to homescreen
- Component 2 (Termux): Python+Flask Whisper HTTP server on localhost:9876, owns mic capture
- Component 3 (Kotlin app): Headless BT HID service with HTTP API on localhost:9877
- Communication: HTTP REST APIs between all three components

## Key technical decisions
- BluetoothHidDevice API (Android 9+) — no root needed
- whisper.cpp built natively in Termux (ARM64 NEON)
- HTTP APIs replace the old TCP socket protocol
- PWA hosted on GitHub Pages — UI updates without APK reinstall
- Mic capture stays in Termux (browser can't reliably access BT headset mic)
- Auth token generated per service session, passed via URL from Kotlin app to PWA

## Bluetooth HID typing: post-connect settle delay
A BT HID **host** (the laptop/PC receiving keystrokes) silently drops input
reports for a short window right after the link reaches `STATE_CONNECTED` — it
is still re-enumerating and setting up its input pipe. `hid.sendReport()`
returns success at the link layer during this window, so the leading keystrokes
*look* sent but never reach the host, and the message arrives truncated at the
front (e.g. only "...what has been taught" of a longer sentence). Re-sending the
same text seconds later works because the link is warm.

`BluetoothHidService` guards against this: it records `connectedAtMs` when the
link reaches CONNECTED and `waitForConnectSettle()` blocks the sender thread
until `CONNECT_SETTLE_MS` (1.5s) has elapsed before the first keystroke. This
runs inside the single-threaded keystroke executor, so it never blocks the HTTP
handler (which already returned 200), and it's a no-op for warm-link sends — only
the first send after a (re)connect pays the cost. **Don't remove this delay** to
shave latency; without it the first dictation after any reconnect loses its
opening words. Look for "Waiting Nms for HID link to settle" in HID `/logs`.

## Bluetooth HID typing: throughput for large text
Typing speed is bounded by HID reports sent, not just the keystroke delay.
`HidKeyMapper.buildReports()` merges each character's key-up into the next
character's key-down — a report carrying a new keycode implicitly releases
the previous key (same as a fast typist overlapping keys), so prose costs
~1 report/char instead of 2. An explicit all-up report is inserted only for
repeated keycodes ("ll") and modifier transitions ('aB' — the HID spec
doesn't order modifier bits vs. keycode changes within one report, so
merging across a shift boundary can mis-case characters on some hosts), plus
one final release. Don't "simplify" back to down/up pairs per char.

`keystrokeDelayMs` is the pause after each report (skipped entirely at 0).
The PWA's Keystroke delay setting is sent as `delay_ms` in each `/type`
request body and sticks until the next override; `/status` reports it as
`keystroke_delay_ms`. At 0 delay the stack can refuse to queue a report
under congestion — `sendReportReliably()` retries with a short backoff and
logs "keystroke dropped" if the budget runs out (check HID `/logs` if text
arrives with missing characters).

## Bluetooth headset mic
Termux records from Android's *default* input, so using a Bluetooth headset's
mic requires system-wide SCO routing, handled by the Kotlin HID service
(`BluetoothHidService`, "Headset mic (SCO) routing" section):
- Uses the deprecated `startBluetoothSco()`/`setBluetoothScoOn()` APIs
  **deliberately** — `setCommunicationDevice()` (the Android 12+ replacement)
  only routes the calling app's own audio, and the recording happens in a
  different app (Termux). Don't "modernize" this without testing cross-app.
- An `AudioDeviceCallback` watches for BT SCO input devices, so routing
  engages/disengages automatically as headsets connect/disconnect.
- SCO startup is retried (it commonly fails right after profile connect);
  `setBluetoothScoOn(true)` is applied once `ACTION_SCO_AUDIO_STATE_UPDATED`
  reports connected.
- State exposed in HID `/status` as `"headset_mic": {available, active, device}`;
  the PWA StatusBar shows a 🎧 dot (green = headset mic in use).
- While SCO is active, phone audio plays through the headset at call quality
  (16 kHz mono) — acceptable for a dedicated dictation device.
- Some devices (observed on Samsung/OneUI) silently tear down the SCO link
  every ~15-30s. Two mechanisms combat this:
  1. Holds `AUDIOFOCUS_GAIN` (voice communication usage) while the headset
     mic is wanted.
  2. **The decisive fix**: plays a continuous inaudible silence stream
     (`startScoKeepAlive()`, an `AudioTrack` with `USAGE_VOICE_COMMUNICATION`)
     over the SCO channel. Audio focus alone was NOT enough — the audio HAL
     reaps the link when no *active stream in this app* uses it, and Termux's
     mic reads are in a separate process the policy can't attribute to the
     link. The silent output stream keeps the link "in use"; since SCO is one
     bidirectional connection, keeping the output warm keeps the mic path up.
     It's output-only, so it doesn't contend with Termux's mic capture.
  If periodic SCO drops reappear (🎧 dot flashing yellow/green, audio blip on
  the headset), check `/logs` for "SCO keep-alive stream started" (should
  appear once per headset connect) and "Audio focus request denied" entries.

### Zoom mode (release headset mic to another device)
A headset has a single call-audio (SCO) channel. Because the HID service
holds it continuously (keep-alive stream + auto-retry), a laptop sharing the
same multipoint headset can never open its own channel — Zoom on the laptop
gets no headset mic. "Zoom mode" releases the link without stopping anything:
- `PUT /headset-mic {"enabled": false}` (auth required) calls `disableSco()`
  and suppresses the auto-re-enable paths (the `headsetMicEnabled` flag
  guards `enableSco()`); `enabled: true` reclaims the link. `GET /headset-mic`
  returns the state unauthenticated; `/status` `headset_mic` includes
  `"enabled"`.
- The flag persists in SharedPreferences so a service restart mid-call
  doesn't snatch the headset back from the laptop.
- While released, BT HID typing still works and dictation falls back to the
  phone's built-in mic.
- PWA: `ZoomModeToggle` pill on the Talk screen (`hid.setHeadsetMic` in
  `useHidService`); the StatusBar 🎧 dot turns gray while released.

## Build
- Android app: `./gradlew assembleDebug` (output: app/build/outputs/apk/debug/)
- PWA: `cd pwa && npm install && npm run build` (output: pwa/dist/)
- Termux scripts: Copy to phone, run setup-termux.sh once
- CI builds APK on push to main, deploys PWA to GitHub Pages on push to main

## Coding conventions
- Kotlin for Android app, Bash for Termux scripts, Python for Whisper server
- TypeScript + React + Tailwind for PWA
- Minimal dependencies — prefer Android SDK built-ins for Kotlin
- No external Kotlin libraries (uses com.sun.net.httpserver for HTTP)
- Shell scripts should be POSIX-compatible where possible but can use bash features

## Testing
- Kotlin: `./gradlew test` — JUnit tests for HidKeyMapper and state machine
- Python: `pytest scripts/tests/` — Whisper server API tests
- PWA: Playwright E2E tests (future)
- Full pipeline: Start Whisper server in Termux, open PWA, speak, verify text on laptop

## Whisper server debugging

The Whisper server (scripts/whisper-server.py) wraps whisper.cpp via subprocess.
Most "no speech detected" bugs are NOT mic problems — check the full pipeline:

### Diagnostic endpoints
- `GET /logs` — circular buffer of recent events with timestamps
- `POST /debug/test-pipeline` — records 3s of audio and returns diagnostics
  for every pipeline stage (recording, transcode, audio energy, whisper output).
  Includes `mic_bandwidth` (`estimate_bandwidth()`, pure-Python FFT — no numpy
  dependency): verdict `narrowband` means the audio has no content above
  ~4 kHz. With a Bluetooth headset mic that's the SCO link on CVSD instead of
  mSBC — a major transcription quality hit no server-side processing can
  recover (try re-pairing / headset firmware update). The Setup Wizard mic
  test surfaces this verdict.

### Pipeline stages (each can fail independently)
1. **Mic capture**: `termux-microphone-record` → raw AAC/AMR file
   - Check: file size > 100B in logs ("Recording finished: ... size=NB")
   - Failure mode: 0-byte file = Termux:API not installed or mic permission denied
2. **Transcode**: `ffmpeg` converts to 16kHz mono WAV
   - Check: WAV size should be ~(duration × 32000) bytes
   - Failure mode: small WAV (<1000B) = corrupt input or wrong codec
3. **Whisper inference**: whisper-cli processes WAV → text
   - Check: processing time should be proportional to audio length (seconds, not milliseconds)
   - Failure mode: **if whisper finishes in <100ms for multi-second audio, it didn't
     process the file** — it printed help text and exited. This means a CLI flag is wrong.

### whisper.cpp CLI flag compatibility
**Critical**: whisper.cpp CLI flags change between versions. The server uses dynamic
flag detection — probing `whisper-cli --help` output before building the command.
When adding new whisper flags:
- Boolean flags (--no-timestamps, --no-gpu) take NO argument — never pass "true"/"false"
- Always check `--help` output before assuming a flag exists
- See `_detect_whisper_flags()` in whisper-server.py

### Parakeet engine
The server supports a second transcription engine: NVIDIA Parakeet TDT 0.6B v2
(int8), run in-process. It is both faster (~10x real-time on phone-class CPUs
vs ~2x for whisper base.en) and more accurate (WER comparable to whisper
large-v3). When the model directory and a backend are present, the server
prefers Parakeet automatically at startup.

Two interchangeable backends (tried in this order by `load_parakeet()`):
1. **sherpa-onnx** Python package — C++ decode loop, used where pip wheels
   exist (laptops/CI). NOT pip-installable in Termux: pip tries to compile
   numpy/ninja against Android's libc and fails (missing `spawn.h` etc.).
2. **parakeet_onnx.py** (bundled, `scripts/parakeet_onnx.py`) — pure
   numpy + onnxruntime port of the upstream reference implementation
   (fbank features + TDT greedy decode). On Termux install prebuilt
   binaries with `pkg install python-numpy python-onnxruntime` — never pip.
   Verified to produce byte-identical transcripts to the upstream
   sherpa-onnx reference script on real audio.

- **Engine selection**: `STT_ENGINE` env var — `auto` (default, prefers
  parakeet), `whisper` (force whisper.cpp), `parakeet`
- **Model files**: `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/`
  (encoder/decoder/joiner .int8.onnx + tokens.txt, ~630 MB on disk)
- **Install**: `./update-model.sh parakeet` downloads the model;
  setup-termux.sh installs backend + model automatically (non-fatally)
- **Switching**: `PUT /model {"model": "parakeet-tdt-0.6b-v2"}` — also listed
  in `GET /models` and the PWA model dropdown like any whisper model
- **Status**: `GET /status` includes `"engine": "parakeet" | "whisper"` and
  `"engine_backend"` ("sherpa-onnx", "onnxruntime", or "whisper.cpp")
- **Fallback**: any Parakeet failure falls back to whisper.cpp per-request;
  switching engines frees the inactive engine's RAM (parakeet ~700 MB loaded)
- **Threads**: `PARAKEET_THREADS` env var (default 4)
- **fbank gotchas** (parakeet_onnx.py must match kaldi-native-fbank exactly):
  hann window is PERIODIC (2π/N, not 2π/(N-1)); std normalization is
  UNBIASED (ddof=1, matching torch.std); librosa/Slaney mel scale
- Tests: `pytest scripts/tests/test_parakeet.py` (fake sherpa_onnx /
  parakeet_onnx modules injected into sys.modules — no model download
  needed; fbank golden values verified against kaldi-native-fbank)

### Chunked (streaming) transcription
Long dictations normally pay the whole transcription cost as one wait after
tapping Stop. When the recording file is decodable *while still being written*,
the server instead transcribes silence-delimited chunks in the background
during the recording, so Stop only costs the final uncommitted tail (~1s
instead of ~duration/10 with Parakeet).

- **Format matters**: ADTS AAC, raw AMR-WB, and Ogg Opus decode mid-write;
  MP4-family containers do not (moov atom is written at stop). Some devices
  (observed on Samsung) wrap BOTH aac and amr_wb in MP4 containers. This is
  probed at startup (`detect_chunked_support()`): if the detected format
  fails the probe, the server tries AMR-WB, then Opus (`-e opus` → Ogg
  container, streamable pages), and switches recording to whichever passes.
- **How it works**: `ChunkedSession` snapshots the growing file every 2s
  (copy first — ffmpeg racing the encoder is unreliable), decodes it, finds
  silence boundaries via per-frame levels (`find_commit_boundary()`, adaptive
  threshold), and transcribes new complete chunks. Only pauses ≥1.2s split
  (`CHUNK_SILENCE_SEC`): each chunk is transcribed as an independent
  utterance the engine sentence-cases and punctuates, so splitting at short
  mid-sentence thinking pauses litters the joined text with spurious
  capitals/periods ("I wonder how quickly It'll take"). Don't lower this to
  commit chunks sooner without weighing that cost. Silent-only spans (thinking
  pauses) advance the committed pointer without an engine call. A chunk only
  counts as speech if above-threshold frames accumulate to ≥0.25s
  (`CHUNK_MIN_SPEECH_SEC`, not necessarily consecutive) OR any frame is ≥3×
  threshold (`CHUNK_LOUD_FACTOR` — keeps short sharp words) — a lone
  breath/noise blip no longer triggers a ~200ms engine call that returns
  empty text. A skipped chunk is never transcribed later, so when tuning,
  err toward "speech": a false positive costs one brief engine call, a
  false negative loses words.
- **Post-processing runs ONCE on the joined text** at stop — chunks are
  transcribed raw (`run_transcription(..., postprocess=False)`) so word
  corrections and symbol phrases spanning a chunk boundary still match.
  Don't "fix" this by post-processing per chunk.
- **Failure = fallback, never breakage**: any poller error, a probe failure,
  or an unjoinable thread degrades to the plain stop-time transcription of
  the full file. The committed prefix is still used when valid.
- **Config**: `STT_CHUNKED` env var — `auto` (default) or `off`.
- **Status**: `GET /status` includes `"chunked": bool`; `/transcribe/stop`
  responses include `"chunked": true` and `"chunks": N` when it was used.
  Look for "Chunked: committed X-Ys" lines in `/logs`.
- Tests: `pytest scripts/tests/test_chunked.py` (boundary detection on
  synthetic levels, WAV slicing, poller with mocked decode/engine, join+
  postprocess assembly).

### Persistent whisper-server mode
The server can use a long-running `whisper-server` process (from whisper.cpp) that
loads the model once and serves inference requests via HTTP on port 9878. This
eliminates the ~1-3s model load overhead on every transcription.

- **Binary**: built with `-DWHISPER_BUILD_SERVER=ON` in setup-termux.sh
- **Startup**: launched automatically if the binary exists; falls back to
  subprocess mode (whisper-cli per request) if not
- **Model switching**: `PUT /model` restarts the whisper-server with the new model
- **Status**: `GET /status` includes `"whisper_server_mode": true/false`
- **Benchmarks**: still use one-shot subprocess mode (tests multiple models)
- **Config**: `WHISPER_SERVER_PORT` env var (default 9878)

### Common "no speech" causes (ranked by likelihood)
1. Wrong whisper CLI flags → whisper prints help and exits instantly (check timing)
2. Audio file not flushed → add sleep after `termux-microphone-record -q` (currently 2s)
3. AAC codec mismatch → server auto-detects AAC vs AMR-WB at startup
4. Actual silence → check audio_analysis step in /debug/test-pipeline (max_amplitude < 100)

## New-phone setup flow

Two pieces make setup on a fresh phone (with Termux installed) nearly automatic:

- `scripts/bootstrap.sh` — run via `curl ... | bash` inside Termux. Clones the
  repo, runs setup-termux.sh, downloads the latest APK from the rolling
  `latest-apk` GitHub Release (updated by CI on every push to main, see
  build-apk.yml) and opens the Android installer, then starts the Whisper
  server. Idempotent. Commands that might read stdin use `< /dev/null` so they
  don't swallow the piped script.
- PWA Setup Wizard (`pwa/src/components/SetupWizard.tsx`) — shown automatically
  when the PWA has no auth token (i.e., new phone), and reachable from
  Settings > Setup guide. Polls both `/status` endpoints (unauthenticated) to
  auto-detect progress: Whisper server up → steps 1-2 done, HID service up →
  step 3, token present → step 4, bluetooth "connected" → step 5. Includes a
  mic test using `POST /debug/test-pipeline`.

If the bootstrap URL, APK release tag, or PWA URL changes, update both
bootstrap.sh and the constants at the top of SetupWizard.tsx.

## Word corrections (auto-correct dictionary)

Whisper often misrecognizes proper nouns (e.g., "quad" instead of "Claude").
A post-transcription word correction system fixes these automatically.

### How it works
- `scripts/word-corrections.json` stores a `{"wrong": "correct"}` dictionary
- After Whisper returns text, `apply_corrections()` does case-insensitive
  whole-word replacement using `\b` regex boundaries
- Implemented in whisper-server.py — applied automatically after each transcription

### API endpoints
- `GET /corrections` — returns the current dictionary
- `PUT /corrections` — replaces the entire dictionary (body = JSON object)
- `POST /corrections/suggest` — the cleanup LLM scans recent transcripts
  (in-memory `recent_transcripts` deque, never persisted) for likely
  mishearings and returns advisory `{"wrong", "right"}` pairs. Nothing is
  saved until the user accepts one (the PWA then PUTs as usual). 503 when
  the LLM is down; a malformed LLM reply yields `[]`, never an error
  (`_parse_suggestions()`).
- Tests: `pytest scripts/tests/test_corrections.py` and
  `scripts/tests/test_llm_features.py` (suggestions)

### Context-aware corrections (glossary injection)
The regex pass can't fix contextual mishearings ("cloud" vs "Claude" depends
on the sentence). So the corrections dictionary's *values* — the vocabulary
the user actually means — are injected into the cleanup LLM's system prompt
as a glossary (`_glossary_terms()`, capped at 40 terms). While cleanup is
enabled, the LLM fixes these in context; the regex pass still runs after it
as the deterministic backstop. Appended at the END of the system prompt so
the static prefix stays byte-identical across glossary edits.

### PWA UI
- `WordCorrections` component in `pwa/src/components/WordCorrections.tsx`
- Shown in Settings view — lets users add/remove correction entries, plus a
  "✨ Suggest corrections" button that surfaces LLM suggestions with
  one-tap accept
- Calls `getCorrections()` / `putCorrections()` / `suggestCorrections()`
  from `pwa/src/lib/api.ts`

### CORS gotcha
The CORS `Access-Control-Allow-Methods` header in `cors_headers()` must
include every HTTP method used by the PWA. When the corrections PUT endpoint
was added, the CORS header had to be updated to include PUT — otherwise
browsers block the preflight request silently. If adding new HTTP methods
to any endpoint, update `cors_headers()` in whisper-server.py.

## Symbol replacements (spoken words → symbols)

For dictating to Claude Code and other CLIs: spoken phrases are replaced by
symbols, e.g. "forward slash help" → "/help", "foo dash bar" → "foo-bar".

### How it works
- `scripts/symbol-replacements.json` stores `{"enabled": bool, "entries": [...]}`;
  each entry is `{"phrase", "symbol", "spacing"}`
- `spacing` controls which adjacent spaces the symbol absorbs: `both`
  (foo-bar), `left` (key: value), `right` ("(x"), `none` (plain word swap)
- `apply_symbols()` in whisper-server.py runs in `_postprocess_text()` AFTER
  word corrections (so corrections can fix misheard phrases first). Matching
  is case-insensitive, whole-phrase (`\b` boundaries), longest phrase first.
- Only applied while `enabled` is true ("symbol mode") — words like "dash"
  occur in normal prose, so the mode is toggled per dictation context.
- A default starter set (`DEFAULT_SYMBOLS`) is materialized into the JSON
  file on first run, so users can edit/delete built-in entries individually.
  The file is gitignored (per-device, user-owned).

### API endpoints
- `GET /symbols` — current config
- `PUT /symbols` — partial merge: `enabled` and/or `entries` (lets the PWA
  toggle flip `enabled` without resending the entry list)
- `POST /symbols/reset` — restore default entries (keeps `enabled`)
- `GET /status` includes `"symbol_mode": bool`
- Tests: `pytest scripts/tests/test_symbols.py`

### PWA UI
- `SymbolReplacements` component in Settings — entry list with per-entry
  spacing dropdown, add form, restore-defaults button, enable toggle
- `SymbolModeToggle` pill on the Talk screen for quick on/off switching

## Speech cleanup (local LLM post-processing)

A small local LLM (Qwen3-1.7B Q4_K_M by default) rewrites the final
transcript: filler words (um/uh) and false starts removed, spoken
self-corrections resolved ("meet at 3 no wait 4pm" → "meet at 4pm"),
punctuation/capitalization/sentence breaks fixed. Runs on the phone next to
Parakeet — no network. The same resident llama-server also powers cleanup
*styles*, voice editing (`POST /edit`), correction suggestions
(`POST /corrections/suggest`), and glossary-aware corrections.

### How it works
- A resident `llama-server` (built from llama.cpp, same Termux build story as
  whisper.cpp) runs on localhost:9879, launched at whisper-server startup and
  mirroring the persistent whisper-server lifecycle. The model stays loaded
  (~1.3 GB RAM for the 1.7B) so flipping the toggle never pays a load wait.
- `apply_cleanup()` is called from `_postprocess_text()` BEFORE word
  corrections and symbols, so corrections/symbol phrases still match the
  cleaned text. In chunked mode this means it runs ONCE on the joined full
  text — never per chunk (false starts and self-corrections span chunk
  boundaries). Don't move it into the chunk loop.
- **Skipped while symbol mode is on** — CLI dictation wants verbatim text and
  the LLM would mangle "/help" or "foo-bar" back into prose.
- **Failure = fallback, never breakage**: server not ready, request error, or
  a degenerate response (empty / outside the style's length-ratio window,
  `_cleanup_result_ok()`) all deliver the raw transcript. Look for
  "Cleanup [style] applied"/"rejected"/"Cleanup failed" in `/logs`.
- Prompting: per-style system prompt + few-shot pairs pin down the rewrite;
  `/no_think` disables Qwen3 thinking mode and any `<think>` block is
  stripped from the reply. llama-server KV-caches the shared prompt prefix
  across requests (per style — switching styles re-pays prompt processing
  once). `max_tokens` is capped relative to input length so a runaway
  generation can't stall Stop.
- **Latency**: adds roughly 3–7s after Stop for typical dictations (scales
  with length, ~2x that on the 4B model) — that's the accepted tradeoff;
  the toggle is the escape hatch.

### Cleanup styles (rewrite flavors)
`CLEANUP_STYLES` defines one active rewrite flavor at a time
(`cleanup_settings["style"]`): `standard` (plain cleanup), `prompt`
(restructure dictation into a Claude Code prompt — bullets, identifiers kept
verbatim), `commit` (git commit message), `slack` (tidy chat message),
`email` (polished prose), `bug` (concise bug report). Each style declares
its own sanity ratio window (a commit summary legitimately compresses a
ramble far below the standard 0.35 floor — don't share one window). The PWA
exposes a style `<select>` next to the `CleanupToggle` pill on the Talk
screen. Styles are still skipped in symbol mode.

### Cleanup models (1.7B vs 4B)
`CLEANUP_MODEL_CATALOG` in whisper-server.py knows `qwen3-1.7b` (default,
~1.1 GB file) and `qwen3-4b` (~2.4 GB file, needs ~3 GB free RAM, roughly 2x
slower, noticeably smarter rewrites/edits). `PUT /cleanup {"model": name}`
persists the selection and restarts the llama-server with that GGUF;
`"available"` stays false until the new model finishes loading (the PWA
`CleanupSettings` section in Settings polls until it comes back). A missing
file returns 404 with the `./update-model.sh cleanup-4b` hint. `CLEANUP_MODEL`
(env) still overrides the *default* file; a persisted runtime selection wins
when its file is on disk (`active_cleanup_model_file()`).

### Voice editing (`POST /edit`)
Body `{"text", "command"}` — the LLM applies a spoken instruction ("replace
Mike with Sarah", "delete the last sentence", "make it more formal") to the
pending text and returns `{"text": edited}`. Used by the PWA edit-before-send
buffer (`EditBuffer`): with "Edit before send" enabled and the LLM up, an
"🎙 Edit by voice" button records an instruction via the normal
`/transcribe/start`+`stop` flow and applies it to the buffer. Any error or a
degenerate reply (empty, or >4x growth) returns 5xx and the caller keeps its
original text — the endpoint never partially applies an edit.

### Config / API
- `GET /cleanup` → `{"enabled", "available", "model", "models", "style",
  "styles"}`; `PUT /cleanup` merges any of `{"enabled": bool, "style": str,
  "model": str}` — persisted in `scripts/cleanup-settings.json`
  (gitignored, per-device)
- `/status` includes `"cleanup_mode"` (toggle), `"cleanup_available"`
  (llama-server up with model loaded), and `"cleanup_style"`
- Env: `STT_CLEANUP` (`auto`/`off` — whether the llama-server is started at
  all), `CLEANUP_SERVER_PORT` (9879), `CLEANUP_MODEL` (GGUF filename),
  `CLEANUP_THREADS` (4), `CLEANUP_TIMEOUT_SEC` (45)
- Install: setup-termux.sh builds llama.cpp (`-DGGML_NATIVE=OFF`,
  `-DLLAMA_CURL=OFF`, non-fatal) and downloads the 1.7B model;
  `./update-model.sh cleanup` re-downloads it, `./update-model.sh cleanup-4b`
  adds the 4B. Model file names are duplicated in whisper-server.py
  (`CLEANUP_MODEL_CATALOG`), setup-termux.sh, and update-model.sh — keep all
  three in sync.
- PWA: `CleanupToggle` pill + style picker on the Talk screen (hidden when
  unavailable, except while enabled so it can still be turned off);
  `CleanupSettings` model selector in Settings; voice edit in `EditBuffer`
- Tests: `pytest scripts/tests/test_cleanup.py` (cleanup, styles, models)
  and `scripts/tests/test_llm_features.py` (/edit, suggestions) — fake
  request helpers, no llama-server or model needed

## Component versioning
All three components expose version info, displayed together in PWA Settings.
Versions use the format `1.0.<commit-count>+<short-hash>` and are auto-generated
at build time from git — no manual bumps needed.

### PWA
- Generated in `pwa/vite.config.ts` via Vite `define` → `__APP_VERSION__`
- Type declaration in `pwa/src/vite-env.d.ts`
- Auto-bumps when CI deploys (triggered by `pwa/**` changes on main)

### Kotlin app (HID service)
- Generated in `app/build.gradle.kts` via `gitVersionName()` → `BuildConfig.APP_VERSION`
- Exposed in `/status` response as `"version"` field
- Auto-bumps when CI builds APK (triggered by `app/**` changes on main)

### Whisper server (Termux)
- `SERVER_VERSION` constant at top of `scripts/whisper-server.py`
- Exposed in `/status` response as `"version"` field
- Manually maintained — bump when making changes to the server script
  (not built by CI, just copied to the phone)

## PWA UI conventions
- The PWA runs on a phone screen — all layouts must work on narrow viewports
  (~360px wide) without horizontal scrolling
- Form inputs should stack vertically on mobile rather than sit in a single row
- Action buttons (Add, Save, etc.) should be full-width or visually prominent,
  never hidden off-screen to the right
