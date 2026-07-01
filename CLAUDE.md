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
  for every pipeline stage (recording, transcode, audio energy, whisper output)

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
- Tests: `pytest scripts/tests/test_corrections.py`

### PWA UI
- `WordCorrections` component in `pwa/src/components/WordCorrections.tsx`
- Shown in Settings view — lets users add/remove correction entries
- Calls `getCorrections()` / `putCorrections()` from `pwa/src/lib/api.ts`

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
