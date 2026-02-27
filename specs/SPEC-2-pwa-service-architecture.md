# Whisper Bluetooth Keyboard — SPEC 2: PWA + Service Architecture

## Summary

Redesign the system into three cleanly separated components: a **Progressive Web App (PWA)** for UI and microphone capture, a **Whisper transcription server** in Termux, and a **headless Kotlin Bluetooth HID service**. This replaces the current two-component architecture (SPEC-1) where Termux owns the mic and the Kotlin app owns both UI and Bluetooth.

## Motivation

The SPEC-1 architecture tightly couples concerns:
- Termux owns mic capture *and* transcription
- The Kotlin app owns UI *and* Bluetooth HID *and* socket listening

This makes it hard to:
- Build a good UI (Android XML layouts in a thin Kotlin app)
- Show transcription history or let the user review/edit text
- Handle Bluetooth disconnections gracefully (text vanishes into the socket)
- Swap the transcription backend without touching the mic capture code

The new architecture separates these concerns. Each component does one thing.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Samsung S24 Ultra                                         │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  PWA (homescreen app, served from localhost)         │  │
│  │  - Mic capture via Web Audio API / MediaRecorder     │  │
│  │  - UI: recording state, transcript history, settings │  │
│  │  - Sends audio to Whisper server                     │  │
│  │  - Sends transcribed text to Kotlin service          │  │
│  │  - Queues text when BT is disconnected               │  │
│  └──────┬──────────────────────────────────┬────────────┘  │
│         │ audio chunks                     │ text          │
│         ▼                                  ▼               │
│  ┌──────────────────┐          ┌───────────────────────┐   │
│  │  Whisper Server   │          │  Kotlin BT HID Service│   │
│  │  (Termux)         │          │  (Android)            │   │
│  │  - Receives audio │          │  - Receives text      │   │
│  │  - Returns text   │          │  - Sends BT HID keys  │   │
│  │  - HTTP/WS API    │          │  - Reports status/logs │   │
│  │  - localhost:9876  │          │  - HTTP API            │   │
│  └──────────────────┘          │  - localhost:9877       │   │
│                                 │         │              │   │
│                                 └─────────│──────────────┘   │
│                                           │                  │
└───────────────────────────────────────────│──────────────────┘
                                            │ Bluetooth HID
                                            ▼
                                      ┌──────────┐
                                      │  Laptop   │
                                      │  (sees a  │
                                      │  keyboard)│
                                      └──────────┘
```

### Why three components

- **PWA**: Web tech gives a modern, iterable UI. Mic capture via Web Audio API works on Android Chrome over localhost. The PWA is the orchestrator — it captures audio, gets transcriptions, and decides when to send text.
- **Whisper server**: A stateless transcription API. Receives audio bytes, returns text. No mic ownership, no socket management. Can be swapped for a different engine or a remote API without changing anything else.
- **Kotlin BT HID service**: A headless service that receives text and sends keystrokes. No UI, no socket listening from Termux, no transcription awareness. Its only job is Bluetooth HID.

### Communication flow

```
User speaks
  → PWA captures audio via MediaRecorder / AudioWorklet
  → PWA sends audio to Whisper server (POST /transcribe)
  → Whisper server returns transcribed text
  → PWA displays text in transcript history
  → PWA sends text to Kotlin service (POST /type)
  → Kotlin service sends keystrokes via Bluetooth HID
  → Text appears on laptop
```

---

## Component 1: PWA

### Tech Stack

| Tool | Purpose |
|------|---------|
| React 19 | UI framework |
| Vite | Build tool / dev server |
| TypeScript | Type-safe JavaScript |
| Tailwind CSS 4 | Utility-first styling |
| vite-plugin-pwa + Workbox | Service worker / offline caching / installability |
| IndexedDB (via `idb`) | Client-side storage (transcript history, settings) |

`idb` is the only runtime dependency beyond React. Tailwind, Vite, and TypeScript are dev-only.

### Hosting

The PWA is built with Vite and served as static files from localhost.

**Development**: `npm run dev` runs Vite's dev server on `localhost:8080` with HMR.

**Production**: `npm run build` outputs optimized static files to `pwa/dist/`. These are served in Termux via:
- `python3 -m http.server 8080 -d dist`
- Or a lightweight HTTP server like `busybox httpd`

Served at `http://localhost:8080`. Chrome on Android allows mic access over localhost without HTTPS.

### Mic Capture

Two approaches, in order of preference:

1. **AudioWorklet (preferred)**: Captures raw PCM samples at a configurable sample rate. The worklet outputs 16kHz 16-bit mono PCM directly, which is what whisper.cpp expects. No transcoding needed.

2. **MediaRecorder (fallback)**: Captures audio as WebM/Opus or MP4/AAC. Requires server-side transcoding (FFmpeg in Termux) before Whisper can process it. Simpler browser code but adds a format conversion step.

The PWA should segment audio into chunks (configurable, default 5 seconds) and send each chunk to the Whisper server for transcription.

### UI

#### Default mode (auto-send)

```
┌──────────────────────────────────┐
│  Whisper Keyboard                │
│                                  │
│  ● Recording                    │
│                                  │
│  ┌────────────────────────────┐  │
│  │ hello world              ✓ │  │
│  │ this is a test           ✓ │  │
│  │ the quick brown fox      ✓ │  │
│  │ jumped over the lazy dog ✓ │  │
│  └────────────────────────────┘  │
│                                  │
│  ⚙ Settings                     │
└──────────────────────────────────┘
```

- Transcribed text is sent to the Kotlin service immediately
- Each entry shows a checkmark when confirmed sent
- The transcript is a scrolling log of everything sent to the laptop

#### Edit-before-send mode (optional, off by default)

```
┌──────────────────────────────────┐
│  Whisper Keyboard                │
│                                  │
│  ● Recording                    │
│                                  │
│  │ hello world              ✓ │  │
│  │ this is a test           ✓ │  │
│  ├────────────────────────────┤  │
│  │ the quik brown fox jumpd  │  │
│  │           [Send] [Discard] │  │
│  └────────────────────────────┘  │
│                                  │
│  ⚙ Settings                     │
└──────────────────────────────────┘
```

- Transcription lands in an editable text buffer
- User can fix errors before tapping Send
- New utterances queue below if the user keeps talking before sending
- Enabled via a toggle in Settings

#### Editing history

Tapping any sent entry in the transcript opens it for editing:

```
┌──────────────────────────────────┐
│  │ hello world              ✓ │  │
│  │ ┌──────────────────────┐   │  │
│  │ │the quick brown fox   │   │  │
│  │ │  [Resend] [Cancel]   │   │  │
│  │ └──────────────────────┘   │  │
│  │ jumped over the lazy dog ✓ │  │
└──────────────────────────────────┘
```

**Resend sends the corrected text as new keystrokes** at wherever the laptop's cursor currently is. The PWA does not attempt to erase the original text on the laptop (backspacing would be fragile and unreliable since the user may have moved their cursor). It is the user's responsibility to position their cursor and clean up the old text on the laptop side.

#### Bluetooth disconnection

When the Kotlin service reports BT is disconnected, the PWA shows a banner and queues text:

```
┌──────────────────────────────────┐
│  ⚠ Laptop disconnected          │
│                                  │
│  ● Recording                    │
│                                  │
│  │ hello world              ✓ │  │
│  │ this is a test           ✓ │  │
│  │ fix the bug in main      ⏳│  │
│  │ and update the tests     ⏳│  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

- Mic capture and transcription continue working
- Transcribed text queues with a pending indicator
- When BT reconnects, the PWA flushes the queue to `/type` in order
- No text is lost

#### Connection status

The PWA polls the Kotlin service's `/status` endpoint (every 2-3 seconds) or holds an open WebSocket for real-time state changes. Displays:
- Bluetooth connection state (connected / disconnected / pairing)
- Connected device name
- Whisper server reachability

#### Debug view

A collapsible panel or a separate `/debug` route that aggregates logs from both backend services:

```
┌──────────────────────────────────┐
│  Debug Log                       │
│                                  │
│  12:05:45 [hid]  BT connected    │
│           to ThinkPad T480       │
│  12:12:03 [hid]  BT dropped     │
│  12:12:08 [hid]  BT reconnected │
│  12:14:22 [wsp]  Model loaded    │
│           base.en (142 MB)       │
│  12:14:25 [wsp]  Transcribed     │
│           420ms "hello world"    │
└──────────────────────────────────┘
```

Pulls from `/logs` on both the Kotlin service and the Whisper server.

### Settings

Stored in IndexedDB (via `idb`). No accounts, no cloud.

| Setting | Default | Description |
|---------|---------|-------------|
| Edit before send | Off | Require manual send for each transcription |
| Whisper model | base.en | Model used for transcription |
| Audio chunk length | 5s | Duration of audio segments sent to Whisper |
| Language | en | Language hint for Whisper |

### PWA Manifest & Service Worker

Handled by `vite-plugin-pwa`. The plugin generates a `manifest.webmanifest` and a Workbox-powered service worker from the Vite config:

```ts
// vite.config.ts (relevant excerpt)
VitePWA({
  registerType: "autoUpdate",
  manifest: {
    name: "Whisper Keyboard",
    short_name: "Whisper",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
  },
  workbox: {
    globPatterns: ["**/*.{js,css,html,woff2,png,svg}"],
  },
})
```

The service worker caches the PWA shell for offline use. API calls (`/transcribe`, `/type`, `/status`) are **not** cached — they must be live.

---

## Component 2: Whisper Server (Termux)

### Overview

A lightweight HTTP server wrapping whisper.cpp. It receives audio, transcribes it, and returns text. It does not capture audio from the mic — the PWA handles that.

### API

#### `POST /transcribe`

Accepts audio data, returns transcribed text.

**Request:**
```
POST /transcribe
Content-Type: application/octet-stream

<raw audio bytes — 16kHz 16-bit mono PCM, or other format if transcoding is enabled>
```

**Response (success):**
```json
{
  "text": "hello world",
  "duration_ms": 420
}
```

**Response (error):**
```json
{
  "error": "model_not_loaded",
  "message": "Whisper model is not loaded. Run setup first."
}
```

#### `GET /status`

Reports server health and loaded model.

**Response:**
```json
{
  "status": "ready",
  "model": "base.en",
  "model_size_mb": 142
}
```

#### `GET /logs`

Returns recent log entries for debugging.

**Response:**
```json
{
  "logs": [
    { "ts": 1709012422, "level": "info", "msg": "Model loaded: base.en (142 MB)" },
    { "ts": 1709012425, "level": "info", "msg": "Transcribed 420ms -> \"hello world\"" },
    { "ts": 1709012430, "level": "warn", "msg": "Empty audio segment, skipping" }
  ]
}
```

### Implementation

The server can be built as:
- A **Python Flask/FastAPI** app (Python is available in Termux) that shells out to the whisper.cpp binary
- A **Bash script with socat/ncat** that wraps the whisper.cpp binary in an HTTP interface
- A **small C/C++ HTTP server** linked directly against whisper.cpp's library

Python with Flask is probably the pragmatic choice — easy to write, available in Termux, and the transcription time dominates any framework overhead.

### Audio Format

The server expects **16kHz 16-bit mono PCM WAV** by default (what whisper.cpp needs). If the PWA sends a different format (WebM/Opus from MediaRecorder), the server transcodes with FFmpeg before inference:

```
ffmpeg -i input.webm -ar 16000 -ac 1 -f wav pipe:1 | whisper ...
```

If the PWA uses AudioWorklet to send raw PCM, no transcoding is needed.

### Port

`localhost:9876` (same port as the current SPEC-1 socket, repurposed as HTTP).

---

## Component 3: Kotlin Bluetooth HID Service

### Overview

A headless Android foreground service that:
1. Registers as a Bluetooth HID keyboard
2. Exposes an HTTP API on localhost for receiving text and reporting status
3. Sends received text as keystrokes to the paired laptop

The Kotlin app is stripped down to the minimum: a thin Activity for lifecycle management, plus the BT HID service.

### Kotlin Activity

A single-screen Activity that:
1. Starts the foreground service
2. Shows basic status (service running, BT connection state)
3. Has a button to open the PWA in Chrome (`http://localhost:8080`)
4. Has a button to stop the service

```
┌──────────────────────────────────┐
│  Whisper HID Service             │
│                                  │
│  Service: Running ●              │
│  Bluetooth: Connected to         │
│    "ThinkPad T480"               │
│                                  │
│  [Open Whisper Keyboard]         │
│  [Stop Service]                  │
└──────────────────────────────────┘
```

The "Open Whisper Keyboard" button fires an intent to Chrome with the PWA URL, including the auth token as a query parameter (see Security section). This is the last time the user sees this Activity during normal operation.

The foreground service notification in the tray brings the user back here if tapped.

### HTTP API

Served on `localhost:9877`.

#### `POST /type`

Sends text as Bluetooth HID keystrokes to the connected laptop.

**Request:**
```json
{
  "text": "hello world"
}
```

**Response (success):**
```json
{
  "ok": true
}
```

**Response (error — BT disconnected):**
```json
{
  "ok": false,
  "error": "bluetooth_disconnected",
  "message": "No Bluetooth device connected."
}
```

**Response (error — unauthorized):**
```json
{
  "ok": false,
  "error": "unauthorized",
  "message": "Invalid or missing auth token."
}
```

The PWA uses the response to decide whether to queue text (BT disconnected) or show an error.

#### `GET /status`

Reports service and Bluetooth connection state.

**Response:**
```json
{
  "service": "running",
  "bluetooth": "connected",
  "device": "ThinkPad T480",
  "uptime_seconds": 3842
}
```

Bluetooth states: `"connected"`, `"disconnected"`, `"pairing"`, `"reconnecting"`.

#### `GET /logs`

Returns recent log entries.

**Response:**
```json
{
  "logs": [
    { "ts": 1709012345, "level": "info", "msg": "Service started" },
    { "ts": 1709012350, "level": "info", "msg": "BT registered as HID device" },
    { "ts": 1709012355, "level": "info", "msg": "BT connected to ThinkPad T480" },
    { "ts": 1709012400, "level": "warn", "msg": "BT connection dropped" },
    { "ts": 1709012405, "level": "info", "msg": "BT reconnecting..." },
    { "ts": 1709012410, "level": "info", "msg": "BT reconnected to ThinkPad T480" }
  ]
}
```

### Bluetooth HID

Unchanged from SPEC-1:
- Registers via `BluetoothHidDevice` API
- Standard USB HID keyboard descriptor (boot protocol compatible)
- 8-byte report: `[modifier, reserved, key1, key2, key3, key4, key5, key6]`
- Character-to-HID keycode mapping (see SPEC-1 for full table)
- Configurable keystroke delay (default 10ms)

### HTTP Server Implementation

The service runs a lightweight HTTP server using Android's built-in `com.sun.net.httpserver.HttpServer` (available in Android's JVM) or a minimal custom implementation using `ServerSocket`. No external dependencies.

### Permissions

Same as SPEC-1, plus network permission for the HTTP server:

```xml
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
<uses-permission android:name="android.permission.INTERNET" />
```

### Port

`localhost:9877` (distinct from the Whisper server on `:9876`).

---

## Security: API Authentication

### Threat Model

Any app on the phone can hit `localhost:9877` and send arbitrary keystrokes to the paired laptop. This must be prevented.

Browser-based attacks (malicious web pages calling localhost) are a secondary concern but also addressed.

### Shared Secret Token

1. **Token generation**: The Kotlin Activity generates a cryptographically random token (32 bytes, hex-encoded) each time the service starts.

2. **Token delivery**: When the user taps "Open Whisper Keyboard", the Activity opens Chrome with the token in the URL:
   ```
   http://localhost:8080/?token=a7f2b9c1e4d83f...
   ```

3. **Token storage**: The PWA reads the token from the URL query parameter, stores it in `sessionStorage`, and strips the token from the URL bar (via `history.replaceState`).

4. **Token usage**: The PWA sends the token with every request to the Kotlin service:
   ```
   POST /type
   Authorization: Bearer a7f2b9c1e4d83f...
   ```

5. **Token validation**: The Kotlin service rejects any request without a valid `Authorization` header with HTTP 403.

6. **Token lifetime**: The token lives only as long as the service is running. Restarting the service generates a new token. `sessionStorage` clears when the browser tab closes, so there's no stale token on disk.

### CORS

The Kotlin service sets CORS headers to restrict browser-based access:

```
Access-Control-Allow-Origin: http://localhost:8080
Access-Control-Allow-Methods: GET, POST
Access-Control-Allow-Headers: Authorization, Content-Type
```

This prevents arbitrary web pages from calling the API. Combined with the token, both native app and browser-based attacks are mitigated.

### What this does NOT protect against

- An attacker with root access to the phone (can read process memory, intercept localhost traffic)
- An attacker who can read Chrome's `sessionStorage` (requires device compromise)

These are acceptable risks — if the attacker has root, the entire device is compromised regardless.

---

## Repository Structure

```
whisper-hid/
├── specs/
│   ├── SPEC-1-termux-hid.md            # Original spec (Termux + Kotlin two-component)
│   └── SPEC-2-pwa-service-architecture.md  # This spec (PWA + services three-component)
│
├── app/                                 # Android Kotlin app (BT HID service)
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       └── java/com/whisperbt/keyboard/
│           ├── MainActivity.kt          # Thin launcher Activity
│           ├── BluetoothHidService.kt   # BT HID + HTTP API
│           └── HidKeyMapper.kt          # Char → HID keycode mapping
│
├── pwa/                                 # Progressive Web App (React + Vite + TypeScript)
│   ├── index.html                       # Vite entry HTML
│   ├── vite.config.ts                   # Vite + PWA plugin config
│   ├── tailwind.config.ts               # Tailwind CSS config
│   ├── tsconfig.json
│   ├── package.json
│   ├── public/                          # Static assets (icons, etc.)
│   └── src/
│       ├── main.tsx                     # React entry point
│       ├── App.tsx                      # Root component + routing
│       ├── index.css                    # Tailwind directives
│       ├── hooks/
│       │   ├── useAudioCapture.ts       # Mic capture (AudioWorklet / MediaRecorder)
│       │   ├── useWhisper.ts            # Whisper server API client
│       │   ├── useHidService.ts         # Kotlin HID service API client
│       │   └── useTranscriptStore.ts    # IndexedDB transcript history
│       ├── components/
│       │   ├── TranscriptList.tsx       # Scrolling transcript log
│       │   ├── RecordingIndicator.tsx   # Recording state display
│       │   ├── EditBuffer.tsx           # Edit-before-send text area
│       │   ├── StatusBar.tsx            # BT + Whisper connection status
│       │   ├── Settings.tsx             # Settings panel
│       │   └── DebugLog.tsx             # Debug log view
│       ├── lib/
│       │   ├── api.ts                   # HTTP client helpers
│       │   ├── db.ts                    # IndexedDB via idb
│       │   └── audio-worklet.ts         # AudioWorklet processor
│       └── types.ts                     # Shared TypeScript types
│
├── scripts/                             # Termux scripts
│   ├── setup-termux.sh                  # One-time environment setup
│   ├── start-whisper-server.sh          # Start Whisper HTTP server
│   ├── stop-whisper-server.sh           # Stop Whisper server
│   ├── whisper-server.py                # Whisper HTTP API server
│   ├── serve-pwa.sh                     # Serve PWA static files on :8080
│   └── update-model.sh                  # Download/swap Whisper models
│
├── build.gradle.kts
├── settings.gradle.kts
├── CLAUDE.md
├── README.md
│
└── .github/
    └── workflows/
        └── build-apk.yml
```

### Key differences from SPEC-1

| Concern | SPEC-1 | SPEC-2 |
|---------|--------|--------|
| Mic capture | Termux (`termux-microphone-record`) | PWA (Web Audio API) |
| UI | Kotlin Activity | PWA (HTML/CSS/JS) |
| Transcription | whisper.cpp CLI in a bash loop | Whisper HTTP server |
| Kotlin app role | UI + socket listener + BT HID | BT HID service + HTTP API only |
| Communication | Raw TCP socket, newline-delimited | HTTP REST APIs |
| BT disconnect handling | Text lost | PWA queues text, flushes on reconnect |
| Auth/security | None (any app can write to socket) | Shared secret token + CORS |
| Files removed | — | `SocketListenerService.kt`, `BootReceiver.kt`, `start-stt.sh`, `stop-stt.sh` |
| Files added | — | `pwa/` (Vite + React + TS), `whisper-server.py`, `serve-pwa.sh` |

---

## Development Phases

### Phase 1: Whisper HTTP Server

**Goal**: Replace the bash loop + socket with an HTTP API wrapping whisper.cpp.

Steps:
1. Write `whisper-server.py` (Python + Flask) that accepts audio and returns text
2. Test with `curl -X POST --data-binary @test.wav http://localhost:9876/transcribe`
3. Verify `/status` and `/logs` endpoints work

**Success criteria**: Audio file submitted via HTTP, correct transcription returned as JSON.

### Phase 2: PWA Shell

**Goal**: Scaffold the PWA with Vite + React + TypeScript + Tailwind, capture mic audio, display transcription.

Steps:
1. Scaffold Vite project in `pwa/` (`npm create vite@latest . -- --template react-ts`)
2. Add Tailwind CSS 4, `vite-plugin-pwa`, and `idb`
3. Configure `vite.config.ts` with PWA plugin and dev server on port 8080
4. Build `App.tsx`, `useAudioCapture` hook (AudioWorklet, fallback: MediaRecorder)
5. Build `useWhisper` hook — send audio chunks to Whisper server, receive text
6. Build `TranscriptList` component — display transcription history
7. `npm run build` → deploy `dist/` to phone, verify homescreen install

**Success criteria**: Speak into phone, see transcribed text in the PWA.

### Phase 3: Kotlin Service Refactor

**Goal**: Strip the Kotlin app down to a headless BT HID service with HTTP API.

Steps:
1. Remove `SocketListenerService`, simplify `MainActivity`
2. Add HTTP server to `BluetoothHidService` (using `HttpServer` or `ServerSocket`)
3. Implement `/type`, `/status`, `/logs` endpoints
4. Implement auth token generation and validation
5. Add "Open PWA" button that passes token via URL

**Success criteria**: `curl -X POST -H "Authorization: Bearer <token>" -d '{"text":"hello"}' http://localhost:9877/type` sends keystrokes to the paired laptop.

### Phase 4: Integration

**Goal**: Wire all three components together.

Steps:
1. PWA reads auth token from URL, stores in `sessionStorage`
2. PWA sends transcribed text to Kotlin service via `/type`
3. PWA polls `/status` and displays BT connection state
4. Implement text queuing when BT is disconnected
5. Implement queue flush on BT reconnect

**Success criteria**: Speak into phone → text appears on laptop. Disconnect BT → text queues. Reconnect → queued text sent.

### Phase 5: Edit and Polish

**Goal**: Add edit-before-send mode, history editing, debug view.

Steps:
1. Implement `Settings` component with IndexedDB persistence (via `idb`)
2. Add edit-before-send toggle
3. Add tap-to-edit on history entries with resend (`EditBuffer` component)
4. Add `DebugLog` component pulling from both services' `/logs` endpoints
5. Verify PWA manifest and Workbox service worker (generated by `vite-plugin-pwa`)

### Phase 6: Hardening

**Goal**: Production readiness.

- Auto-reconnect to Whisper server if Termux restarts
- Graceful handling of service crashes
- Battery optimization (release mic when not recording)
- Error states and user-facing error messages
- Startup script that launches all three components (`whisper-server`, `serve-pwa`, Kotlin service)

---

## Key Technical References

- **React 19**: https://react.dev/
- **Vite**: https://vite.dev/
- **Tailwind CSS 4**: https://tailwindcss.com/
- **vite-plugin-pwa**: https://vite-pwa-org.netlify.app/
- **idb (IndexedDB)**: https://github.com/jakearchibald/idb
- **Web Audio API / AudioWorklet**: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
- **MediaRecorder API**: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
- **BluetoothHidDevice API**: https://developer.android.com/reference/android/bluetooth/BluetoothHidDevice
- **whisper.cpp**: https://github.com/ggml-org/whisper.cpp
- **Flask**: https://flask.palletsprojects.com/

## Constraints

All constraints from SPEC-1 still apply:
- **No software on laptop**: Laptop sees a standard Bluetooth keyboard
- **On-device processing**: All transcription happens on the phone, no cloud APIs
- **Sideloaded APK**: Built via GitHub Actions, not on Play Store
- **Samsung S24 Ultra**: Primary target device (Snapdragon 8 Gen 3, Android 14+)
- **No external Kotlin dependencies**: Android SDK built-ins only for the Kotlin app

Additional constraints:
- **PWA must work on Android Chrome**: Tested on Chrome for Android over localhost
- **PWA built with Vite + React 19 + TypeScript**: Built output (`pwa/dist/`) is static files served as-is. Node.js is a dev-time dependency only — not required on the phone
- **Minimal PWA runtime dependencies**: Only `react`, `react-dom`, and `idb`. Tailwind, Vite, and TypeScript are dev-only
- **Python available in Termux**: Used for the Whisper server, installable via `pkg install python`
