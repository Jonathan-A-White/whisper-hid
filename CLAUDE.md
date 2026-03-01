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
**Critical**: whisper.cpp CLI flags change between versions. The server and stt-loop.sh
both use dynamic flag detection — probing `whisper-cli --help` output before building
the command. When adding new whisper flags:
- Boolean flags (--no-timestamps, --no-gpu) take NO argument — never pass "true"/"false"
- Always check `--help` output before assuming a flag exists
- See `_detect_whisper_flags()` in whisper-server.py and `init_whisper_flags()` in stt-loop.sh
- The bash and Python implementations must stay in sync on which flags they use

### Common "no speech" causes (ranked by likelihood)
1. Wrong whisper CLI flags → whisper prints help and exits instantly (check timing)
2. Audio file not flushed → add sleep after `termux-microphone-record -q` (currently 2s)
3. AAC codec mismatch → server auto-detects AAC vs AMR-WB at startup
4. Actual silence → check audio_analysis step in /debug/test-pipeline (max_amplitude < 100)

## Word corrections (auto-correct dictionary)

Whisper often misrecognizes proper nouns (e.g., "quad" instead of "Claude").
A post-transcription word correction system fixes these automatically.

### How it works
- `scripts/word-corrections.json` stores a `{"wrong": "correct"}` dictionary
- After Whisper returns text, `apply_corrections()` does case-insensitive
  whole-word replacement using `\b` regex boundaries
- Implemented in both Python (whisper-server.py) and Bash (stt-loop.sh) —
  both pipelines must apply the same corrections

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

## PWA UI conventions
- The PWA runs on a phone screen — all layouts must work on narrow viewports
  (~360px wide) without horizontal scrolling
- Form inputs should stack vertically on mobile rather than sit in a single row
- Action buttons (Add, Save, etc.) should be full-width or visually prominent,
  never hidden off-screen to the right
