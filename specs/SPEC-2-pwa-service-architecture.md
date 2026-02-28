# Whisper Bluetooth Keyboard — SPEC 2: PWA + Service Architecture

## Summary

Redesign the system into three cleanly separated components: a **Progressive Web App (PWA)** for UI and orchestration, a **Whisper transcription server** in Termux (which also owns mic capture), and a **headless Kotlin Bluetooth HID service**. This replaces the current two-component architecture (SPEC-1) where Termux owns the mic and the Kotlin app owns both UI and Bluetooth.

## Motivation

The three-component split is primarily about **separation of deployment and development velocity**, not just separation of concerns within the code (the current codebase already has separate classes for each concern):

1. **PWA for UI**: Web tech iterates faster than Android XML layouts. Hot reload via Vite vs. rebuild+sideload APK. The UI can be updated by pushing to GitHub Pages — no APK reinstall, no device in hand. This is the killer feature.
2. **Whisper server as a stateless API**: Decouples the transcription engine from the Kotlin app lifecycle. Today, if the bash script dies mid-transcription, the socket listener in Kotlin doesn't know why. With an HTTP API, the PWA gets a proper error response. It also makes it trivial to swap whisper.cpp for a different engine (or even a remote API) without touching anything else.
3. **Headless Kotlin HID service**: The BT HID API _requires_ an Android app. By stripping it to a headless service with an HTTP API, the Kotlin app becomes a stable, rarely-changed piece of infrastructure. No UI churn, no Fragment lifecycle bugs, no reason to redeploy it unless the BT stack changes.

The real win is being able to **update the UI without touching the APK**.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Samsung S24 Ultra                                         │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  PWA (saved to homescreen from GitHub Pages)         │  │
│  │  - UI: PTT button, transcript history, settings      │  │
│  │  - Orchestrator: triggers recording, displays text   │  │
│  │  - Sends transcribed text to Kotlin service          │  │
│  │  - Queues text when BT is disconnected               │  │
│  └──────┬──────────────────────────────────┬────────────┘  │
│         │ start/stop recording             │ text          │
│         │ http://localhost:9876             │ http://localhost:9877
│         ▼                                  ▼               │
│  ┌──────────────────┐          ┌───────────────────────┐   │
│  │  Whisper Server   │          │  Kotlin BT HID Service│   │
│  │  (Termux)         │          │  (Android)            │   │
│  │  - Owns mic via   │          │  - Receives text      │   │
│  │    termux-api      │          │  - Sends BT HID keys  │   │
│  │  - Runs whisper   │          │  - Manages BT SCO     │   │
│  │  - HTTP API       │          │  - Reports status/logs │   │
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

PWA hosted at: https://jonathan-a-white.github.io/whisper-hid/
API servers on phone: http://localhost:9876 (Whisper), http://localhost:9877 (HID)
```

### Why three components

- **PWA**: Web tech gives a modern, iterable UI. Hosted on GitHub Pages (HTTPS), saved to homescreen via Chrome's "Add to Home Screen". The PWA is the orchestrator — it triggers recording, displays transcriptions, manages pinned items and history, and decides when to send text to the HID service. It does **not** own the mic (see "Why the PWA doesn't capture audio" below).
- **Whisper server**: Owns mic capture (via `termux-microphone-record`) and transcription. Receives start/stop commands from the PWA, records audio, transcribes it, and returns text. Stateless from the PWA's perspective — each request is independent.
- **Kotlin BT HID service**: A headless service that receives text and sends keystrokes. Also manages Bluetooth SCO routing for headset mic access. No UI, no transcription awareness. Its only job is Bluetooth.

### Why the PWA doesn't capture audio

Chrome on Android **cannot reliably access a Bluetooth headset mic** via `getUserMedia()`. Bluetooth audio has two modes: A2DP (high-quality playback, no mic) and SCO/HFP (bidirectional audio with mic). The SCO link must be explicitly activated via native Android APIs (`AudioManager.setCommunicationDevice()` on Android 12+, `startBluetoothSco()` on older versions). Neither is available to web apps.

Even if SCO were activated, HFP audio is limited to **8kHz mono** — Whisper expects **16kHz**. The native `termux-microphone-record` with `VOICE_COMMUNICATION` audio source handles SCO activation and can get higher sample rates depending on the headset's codec support.

**Decision**: Mic capture stays in Termux via `termux-microphone-record` (the same approach as SPEC-1). The PWA sends start/stop commands to the Whisper server, which handles recording and transcription. The PWA gets all the UI benefits without owning the mic.

**Sources**:
- [Chromium Issue 40222537](https://issues.chromium.org/issues/40222537) — Android 12+ Chrome ignores BT devices
- [Daily.co: Why Bluetooth audio quality suffers](https://www.daily.co/blog/why-bluetooth-audio-quality-suffers-in-video-calls/) — HFP 8kHz limitation
- [Google Oboe Wiki: Bluetooth Audio](https://github.com/google/oboe/wiki/TechNote_BluetoothAudio) — SCO vs A2DP

### Communication flow

```
User taps PTT button in PWA
  → PWA sends POST /transcribe/start to Whisper server
  → Whisper server starts mic recording via termux-microphone-record
User taps PTT button again (stop)
  → PWA sends POST /transcribe/stop to Whisper server
  → Whisper server stops recording, runs whisper.cpp, returns text
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
| React | UI framework |
| Vite | Build tool / dev server |
| TypeScript | Type-safe JavaScript |
| Tailwind CSS | Utility-first styling |
| vite-plugin-pwa + Workbox | Service worker / offline caching / installability |

No runtime dependencies beyond React. Tailwind, Vite, and TypeScript are dev-only. Settings and transcript history use `localStorage` (see "Storage" below).

### Hosting

The PWA is hosted on **GitHub Pages** at `https://jonathan-a-white.github.io/whisper-hid/`. Users save it to their homescreen via Chrome's "Add to Home Screen" — it then launches as a standalone app.

**Why GitHub Pages instead of localhost**:
- No need to run a local HTTP server on the phone
- PWA updates automatically when code is pushed — no file copying to the phone
- HTTPS is a secure context, so service workers work natively
- The Workbox service worker caches the app shell, so after first load it works offline

**Development**: `npm run dev` runs Vite's dev server on `localhost:5173` with HMR.

**Production**: CI builds the PWA and deploys to GitHub Pages on push to `main`. Vite's `base` config is set to `/whisper-hid/` to match the GitHub Pages path.

**Private Network Access**: The PWA (HTTPS) makes requests to localhost services (HTTP). Chrome allows this but requires the localhost servers to respond to CORS preflight with `Access-Control-Allow-Private-Network: true`. Both the Whisper server and Kotlin HID service must include this header (see Security section).

**Known risk**: Private Network Access (PNA) is still under active development in Chrome. The `Access-Control-Allow-Private-Network` header behavior has changed across Chrome versions. If PNA tightens in a future release:
- **Fallback A**: Host the PWA on localhost too (via a simple Termux HTTP server). Loses the "update by pushing to GitHub" advantage but eliminates the mixed-context problem.
- **Fallback B**: Use a WebView in the Kotlin app instead of Chrome.

Document the minimum Chrome version requirement and test PNA behavior on each Chrome update.

### UI

The PWA has three views, matching the current app's bottom navigation: **Talk**, **History**, and **Settings**.

#### Talk view (PTT mode — primary interaction)

```
┌──────────────────────────────────┐
│  Whisper Keyboard                │
│                                  │
│  ● Connected to ThinkPad T480   │
│                                  │
│  ┌────────────────────────────┐  │
│  │ Let me share my screen  ↗ │  │
│  │ sounds good             ↗ │  │
│  └────────────────────────────┘  │
│        (pinned items chips)      │
│                                  │
│         ┌──────────┐             │
│         │          │             │
│         │   TALK   │             │
│         │          │             │
│         └──────────┘             │
│                                  │
│  Last: "the quick brown fox"    │
│                                  │
│  [Talk]  [History]  [Settings]  │
└──────────────────────────────────┘
```

- Large PTT button (tap to start recording, tap again to stop)
- Button shows "Recording..." with scale animation while active
- Haptic feedback on every tap
- Connection status with colored dot (green = connected, red = disconnected)
- **Pinned items** as horizontal scrollable chips — tap to resend immediately
- Last transcription preview below the button

#### History view

```
┌──────────────────────────────────┐
│  History                 [Clear] │
│  ┌────────────────────────────┐  │
│  │ 🔍 Search...              │  │
│  └────────────────────────────┘  │
│                                  │
│  │ the quick brown fox    📌 🗑│  │
│  │ Feb 28, 2026  2:15 PM      │  │
│  │────────────────────────────│  │
│  │ hello world            📌 🗑│  │
│  │ Feb 28, 2026  2:14 PM      │  │
│  │────────────────────────────│  │
│  │ this is a test         📌 🗑│  │
│  │ Feb 28, 2026  2:13 PM      │  │
│                                  │
│  [Talk]  [History]  [Settings]  │
└──────────────────────────────────┘
```

- Full searchable transcript history (live filtering)
- Pin/unpin items (pinned items appear as chips on Talk view)
- Delete individual items or clear all with confirmation
- Tap an entry to open a preview dialog with full text, timestamp, and Send/Pin/Cancel buttons
- Pinned items sorted first, then by timestamp descending

#### Edit-before-send mode (optional, off by default)

When enabled in Settings, transcription lands in an editable text buffer instead of being sent immediately:

```
┌──────────────────────────────────┐
│  │ the quik brown fox jumpd  │  │
│  │           [Send] [Discard] │  │
│  └────────────────────────────┘  │
```

**Resend from history** sends corrected text as new keystrokes at wherever the laptop cursor currently is. The PWA does not attempt to erase original text on the laptop (backspacing would be unreliable since the user may have moved their cursor).

#### Bluetooth disconnection

When the Kotlin service reports BT is disconnected, the PWA shows a status banner driven by the `/status` response. The banner adapts as the service moves through the state machine (see Resilience section):

- **`reconnecting`**: Shows attempt counter and auto-retry progress. No user action needed
- **`failed`**: Shows action buttons — "Restart HID" (`POST /restart`) and "View Debug Log"
- **`connected`** (recovered): Banner clears, queued text flushes automatically

```
┌──────────────────────────────────────┐
│  ⚠ Laptop disconnected              │
│  Reconnecting... (attempt 3 of 10)  │
│                                      │
│  [TALK button]                       │
│                                      │
│  │ hello world                  ✓ │  │
│  │ fix the bug in main          ⏳│  │
│  │ and update the tests         ⏳│  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

If auto-reconnect fails:

```
┌──────────────────────────────────────┐
│  ✖ Connection failed                │
│  Auto-reconnect timed out           │
│  [Restart HID]  [View Debug Log]    │
└──────────────────────────────────────┘
```

Throughout all disconnection states:
- Recording and transcription continue working
- Transcribed text queues with a pending indicator (⏳)
- When BT reconnects (by any means), the PWA flushes the queue to `/type` in order
- No text is lost

#### Connection status

The PWA polls the Kotlin service's `/status` endpoint every 3 seconds. Displays:
- Bluetooth connection state (connected / disconnected / reconnecting / failed)
- Connected device name
- Whisper server reachability

Polling is simple and adequate — BT connection state changes infrequently, and reconnections take seconds anyway, so 3s of status lag is invisible. No WebSocket needed.

#### Debug view

A collapsible panel or a separate route that shows recent log entries from both backend services. Designed to answer "why isn't it working?" at a glance.

```
┌──────────────────────────────────┐
│  Debug Log           [Copy][Clr] │
│                                  │
│  12:05:45 [hid]  BT connected    │
│           to ThinkPad T480       │
│  12:12:03 [hid]  BT dropped     │
│  12:12:08 [hid]  BT reconnected │
│  12:14:22 [wsp]  Transcribed     │
│           420ms "hello world"    │
└──────────────────────────────────┘
```

Pulls from `/logs` on both services. Log buffer capped at 200 entries (circular buffer). A `<pre>` tag with raw entries is fine — no fancy component needed.

### Settings

Stored in `localStorage` (JSON-serialized settings object). No accounts, no cloud.

| Setting | Default | Description |
|---------|---------|-------------|
| Edit before send | Off | Require manual send for each transcription |
| Append newline | Off | Add `\n` after each transcription segment |
| Append space | On | Add space after each transcription segment |
| Keystroke delay | 10ms | Delay between HID keystroke reports |
| Whisper model | base.en | Model used for transcription (display only — model swap via Termux) |
| Audio chunk length | 5s | Duration of audio segments in continuous mode |
| Language | en | Language hint for Whisper |

### Storage

Settings and transcript history use **`localStorage`**:
- **Settings**: `JSON.stringify` a settings object. Simple, synchronous, sufficient.
- **Transcript history**: Store the last ~500 entries as a JSON array. Pinned status stored with each entry.

`localStorage` is simpler than IndexedDB and sufficient for this use case. IndexedDB would only be needed for thousands of entries, full-text search, or large blob storage — none of which apply here.

### PWA Manifest & Service Worker

Handled by `vite-plugin-pwa`. The plugin generates a `manifest.webmanifest` and a Workbox-powered service worker from the Vite config:

```ts
// vite.config.ts (relevant excerpt)
VitePWA({
  registerType: "autoUpdate",
  manifest: {
    name: "Whisper Keyboard",
    short_name: "Whisper",
    start_url: "/whisper-hid/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
  },
  workbox: {
    globPatterns: ["**/*.{js,css,html,woff2,png,svg}"],
  },
})
```

The service worker caches the PWA shell for offline use. API calls (`/transcribe/*`, `/type`, `/status`) are **not** cached — they must be live.

---

## Component 2: Whisper Server (Termux)

### Overview

A Python + Flask HTTP server wrapping whisper.cpp. It owns mic capture (via `termux-microphone-record`), runs transcription, and returns text. The PWA sends start/stop commands; the server handles audio recording and processing.

**Why Python + Flask**: An HTTP server in Bash is fragile and hard to maintain. C/C++ linked against whisper.cpp is more work than needed for a localhost API. Python + Flask is ~30 lines for the core endpoint, easy to write, and available in Termux (`pkg install python`, `pip install flask`). The transcription time dominates any framework overhead. The disk space cost (~100MB for Python + Flask) is acceptable.

### API

#### `POST /transcribe` (one-shot mode)

Accepts a pre-recorded audio file, returns transcribed text. Used when the PWA sends a recorded audio blob.

**Request:**
```
POST /transcribe
Content-Type: application/octet-stream

<raw audio bytes — WAV, WebM, or other format>
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

If the audio is not 16kHz mono PCM WAV, the server transcodes with FFmpeg before inference.

#### `POST /transcribe/start` (PTT mode)

Starts mic recording. Returns immediately.

**Response:**
```json
{
  "ok": true,
  "message": "Recording started"
}
```

#### `POST /transcribe/stop` (PTT mode)

Stops mic recording, transcribes the captured audio, returns text.

**Response (success):**
```json
{
  "text": "the quick brown fox",
  "duration_ms": 850
}
```

**Response (error — no active recording):**
```json
{
  "ok": false,
  "error": "not_recording",
  "message": "No active recording to stop."
}
```

#### `GET /status`

Reports server health and loaded model.

**Response:**
```json
{
  "status": "ready",
  "model": "base.en",
  "model_size_mb": 142,
  "recording": false
}
```

If the model file is missing, the server starts but reports `"status": "error"` and `/transcribe` returns 503.

#### `GET /logs`

Returns recent log entries for debugging. Circular buffer, capped at 200 entries.

**Response:**
```json
{
  "logs": [
    { "ts": 1709012422, "level": "info", "msg": "Model loaded: base.en (142 MB)" },
    { "ts": 1709012425, "level": "info", "msg": "Transcribed 420ms -> \"hello world\"" }
  ]
}
```

### Model Loading Lifecycle

- The model is loaded **at server startup**
- If the model file is missing, the server starts but `/status` reports `"status": "error"` and `/transcribe` returns 503 Service Unavailable
- Model swap requires server restart (no hot-reload — keep it simple)
- `update-model.sh` should note that the server must be restarted after swapping models

### Concurrent Requests

The server serializes `/transcribe` requests: one at a time, FIFO queue. If a request arrives while another is processing, it waits. This is the simplest correct behavior — whisper.cpp inference is CPU-bound and concurrent inference would just thrash the CPU.

### Audio Format

The server accepts any audio format that FFmpeg can handle. If the input is not 16kHz mono PCM WAV, the server transcodes:

```
ffmpeg -i input.webm -ar 16000 -ac 1 -f wav pipe:1 | whisper ...
```

For PTT mode (start/stop), the server records via `termux-microphone-record` and converts the output (AAC or AMR-WB, depending on device support) to 16kHz WAV via FFmpeg before running whisper.cpp. This is the same approach as the current SPEC-1 implementation.

### Port

`localhost:9876`. This port was used for the raw TCP socket in SPEC-1 — it is repurposed as HTTP in SPEC-2. The TCP socket protocol from SPEC-1 is replaced entirely by the HTTP API.

---

## Component 3: Kotlin Bluetooth HID Service

### Overview

A headless Android foreground service that:
1. Registers as a Bluetooth HID keyboard
2. Exposes an HTTP API on localhost for receiving text and reporting status
3. Sends received text as keystrokes to the paired laptop
4. Manages Bluetooth SCO routing for headset mic access

The Kotlin app is stripped down to the minimum: a thin Activity for lifecycle management, plus the BT HID service.

### Kotlin Activity

A single-screen Activity that:
1. Starts the foreground service
2. Shows basic status (service running, BT connection state)
3. Has a button to open the PWA in Chrome (`https://jonathan-a-white.github.io/whisper-hid/`)
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

Optionally, the PWA can include separator settings:
```json
{
  "text": "hello world",
  "append": "\n"
}
```

The `append` field (optional) adds a trailing character after the text. Values: `"\n"` (newline), `" "` (space), `""` (nothing). If omitted, the service uses its default (space).

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

#### `POST /backspace`

Sends backspace keystrokes to the connected laptop.

**Request:**
```json
{
  "count": 5
}
```

**Response:**
```json
{
  "ok": true
}
```

This replaces the `BACKSPACE:N` control message from the SPEC-1 TCP protocol.

#### `POST /restart`

Soft-restarts the Bluetooth HID registration without killing the app. Unregisters and re-registers the HID device, re-entering the state machine at `IDLE` (see Resilience section).

**Response (success):**
```json
{
  "ok": true,
  "message": "HID service restarting. Re-registering Bluetooth HID device."
}
```

#### `GET /status`

Reports service and Bluetooth connection state.

**Response (connected):**
```json
{
  "service": "running",
  "bluetooth": "connected",
  "device": "ThinkPad T480",
  "uptime_seconds": 3842
}
```

**Response (reconnecting):**
```json
{
  "service": "running",
  "bluetooth": "reconnecting",
  "device": "ThinkPad T480",
  "reconnect_attempt": 3,
  "reconnect_max": 10,
  "next_retry_seconds": 8
}
```

**Response (failed):**
```json
{
  "service": "running",
  "bluetooth": "failed",
  "device": "ThinkPad T480",
  "failure_reason": "Auto-reconnect timed out after 10 attempts"
}
```

Bluetooth states: `"connected"`, `"registered"` (waiting for first connection), `"reconnecting"`, `"failed"`.

#### `GET /logs`

Returns recent log entries. Circular buffer, capped at 200 entries.

### Bluetooth HID

Unchanged from SPEC-1:
- Registers via `BluetoothHidDevice` API
- Standard USB HID keyboard descriptor (boot protocol compatible)
- 8-byte report: `[modifier, reserved, key1, key2, key3, key4, key5, key6]`
- Character-to-HID keycode mapping (see SPEC-1 for full table)
- Configurable keystroke delay (default 10ms)

### Bluetooth SCO Management

The Kotlin service manages Bluetooth SCO routing (previously done by `MainActivity.startBluetoothSco()` in SPEC-1). On Android 12+, it uses `AudioManager.setCommunicationDevice()`; on older versions, `AudioManager.startBluetoothSco()`. This ensures the headset mic is routed through the phone when recording is active.

The Whisper server does not need to know about SCO — `termux-microphone-record` with `VOICE_COMMUNICATION` audio source (-s 7) picks up the headset mic once SCO is active.

### HTTP Server Implementation

The service runs a lightweight HTTP server using Android's built-in `com.sun.net.httpserver.HttpServer` (available in Android's JVM). No external dependencies.

### Permissions

Same as SPEC-1:

```xml
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.VIBRATE" />
```

### Port

`localhost:9877` (distinct from the Whisper server on `:9876`).

---

## SPEC-1 Control Messages: What Carries Forward

The current SPEC-1 TCP protocol uses control messages prefixed with `0x01`. Here's what happens to each in SPEC-2:

| SPEC-1 Control Message | SPEC-2 Equivalent | Rationale |
|---|---|---|
| `BACKSPACE:N` | `POST /backspace {"count": N}` | Preserved as a proper endpoint |
| `PAUSE` | Dropped | In SPEC-2, the PWA controls when recording happens. Pause/resume from the server side doesn't make sense |
| `RESUME` | Dropped | Same as PAUSE — PWA controls recording lifecycle |
| `MIC_READY` | Dropped | In SPEC-1, Termux sent this after mic init so the Android app could play a chime. In SPEC-2, the PWA triggers recording and knows when it started — it can play its own haptic/sound feedback without a signal from the server |

---

## Security: API Authentication

### Threat Model

Any app on the phone can hit `localhost:9877` and send arbitrary keystrokes to the paired laptop. This must be prevented.

Browser-based attacks (malicious web pages calling localhost) are a secondary concern but also addressed.

### Shared Secret Token

1. **Token generation**: The Kotlin Activity generates a cryptographically random token (32 bytes, hex-encoded) each time the service starts.

2. **Token delivery**: When the user taps "Open Whisper Keyboard", the Activity opens Chrome with the token in the URL:
   ```
   https://jonathan-a-white.github.io/whisper-hid/?token=a7f2b9c1e4d83f...
   ```

3. **Token storage**: The PWA reads the token from the URL query parameter, stores it in `localStorage`, and strips the token from the URL bar (via `history.replaceState`). Using `localStorage` (not `sessionStorage`) means the token persists across tab closes and homescreen launches.

4. **Token usage**: The PWA sends the token with every request to the Kotlin service:
   ```
   POST /type
   Authorization: Bearer a7f2b9c1e4d83f...
   ```

5. **Token validation**: The Kotlin service rejects any request without a valid `Authorization` header with HTTP 403.

6. **Token lifetime**: The token lives as long as the service is running. Restarting the service generates a new token. The old token in `localStorage` becomes invalid.

### Re-authentication Flow

If the PWA has a stale or missing token (service restarted, `localStorage` cleared, user opened PWA directly from homescreen/bookmark):

1. The PWA detects 403 responses from the Kotlin service
2. Shows a "Not authenticated" state with a "Re-authenticate" button
3. The button opens an Android intent to the Kotlin Activity (via a deep link or intent URL)
4. The Kotlin Activity re-opens the PWA in Chrome with a fresh token in the URL
5. The PWA stores the new token in `localStorage` and resumes normal operation

### CORS and Private Network Access

Since the PWA is served from GitHub Pages (HTTPS) and the API servers run on localhost (HTTP), two layers of browser security must be satisfied:

**1. CORS**: Both the Kotlin service and the Whisper server set headers to restrict browser-based access:

```
Access-Control-Allow-Origin: https://jonathan-a-white.github.io
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
```

**2. Private Network Access**: Chrome requires localhost servers to explicitly opt in to receiving requests from public websites. Both servers must handle `OPTIONS` preflight requests and respond with:

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://jonathan-a-white.github.io
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Allow-Private-Network: true
```

This prevents arbitrary web pages from calling the APIs. Combined with the auth token, both native app and browser-based attacks are mitigated.

### What this does NOT protect against

- An attacker with root access to the phone (can read process memory, intercept localhost traffic)
- A malicious app on the phone that directly calls localhost (not via a browser — CORS doesn't apply). The auth token mitigates this — even a direct caller needs the token
- If the attacker has root, the entire device is compromised regardless. This is an acceptable risk

---

## Resilience and Operability

### BT Connection State Machine

The Kotlin HID service tracks connection state as a well-defined state machine. Every transition is logged via `/logs` and reflected in `/status`.

```
         ┌─────────┐
         │  IDLE    │ ← service started, HID not registered
         └────┬────┘
              │ registerApp() succeeds
              ▼
        ┌────────────┐
        │ REGISTERED  │ ← HID registered, waiting for connection
        └──────┬─────┘
               │ onConnectionStateChanged(CONNECTED)
               ▼
        ┌────────────┐
        │ CONNECTED   │ ← normal operating state
        └──────┬─────┘
               │ onConnectionStateChanged(DISCONNECTED)
               ▼
       ┌───────────────┐
       │ RECONNECTING   │ ← auto-retry with exponential backoff
       └───────┬───────┘
              ╱ ╲
    success  ╱   ╲  after max attempts
            ▼     ▼
    ┌────────────┐  ┌────────┐
    │ CONNECTED   │  │ FAILED  │ ← needs manual intervention
    └────────────┘  └────────┘
                         │ POST /restart
                         ▼
                    ┌─────────┐
                    │  IDLE    │ (re-enters state machine from top)
                    └─────────┘
```

### Auto-Reconnect Behavior

When `onConnectionStateChanged` fires with `DISCONNECTED`:

1. Service enters `RECONNECTING` state
2. Attempts to reconnect with exponential backoff: **2s, 4s, 8s, 16s, 30s**
3. After 5 failures, backs off to **every 30 seconds** for up to 5 minutes
4. After 5 minutes of failed reconnects, enters `FAILED` state and stops retrying
5. If the device reconnects at any point (Android may reconnect autonomously), the `onConnectionStateChanged(CONNECTED)` callback fires and the service returns to `CONNECTED`

The reconnect counter and timing are reported via `/status` so the PWA can show progress.

### Service Recovery: `POST /restart`

When auto-reconnect fails (HID registration stuck, Bluetooth stack in a bad state), the service supports a soft restart:

1. PWA sends `POST /restart` to the Kotlin service
2. Service unregisters the HID device (`unregisterApp()`)
3. Service re-registers (`registerApp()`) — re-enters state machine at `IDLE`
4. Service attempts to reconnect to the last known device

If `POST /restart` also fails, the PWA shows a "Restart App" action that launches an Android intent to force-restart the Kotlin activity.

### PWA Health Monitoring

The PWA monitors both backend services and shows clear, actionable status:

| Service state | What the user sees | Available actions |
|---|---|---|
| Kotlin service unreachable | "HID Service not running" (red) | "Open HID App" (launches Kotlin activity) |
| BT `CONNECTED` | "Connected to ThinkPad T480" (green) | — |
| BT `RECONNECTING` | "Reconnecting... (attempt 3)" (yellow) | — (auto-retry in progress) |
| BT `FAILED` | "Connection failed" (red) | "Restart HID", "View Debug Log" |
| Whisper server unreachable | "Whisper server offline" (red) | "View Debug Log" |
| Whisper server ready | "Whisper ready (base.en)" (green) | — |

The PWA polls `/status` on both services every 3 seconds. If a `/status` call fails (connection refused), the PWA treats the service as unreachable — distinct from "service running but BT disconnected."

### Error Handling Philosophy

- **Transcription errors are acceptable** (lost audio) — if the Whisper server fails to transcribe, the moment has passed. The user can re-record.
- **Text delivery errors are not acceptable** (text must queue) — once text is transcribed, it must eventually reach the laptop. The PWA queues text during BT disconnects and flushes on reconnect.
- **Failed `/type` requests** should be retried (the text is already transcribed and must not be lost)
- **Failed `/transcribe` requests** should NOT be retried (the audio moment has passed)

This matches the current SPEC-1 behavior where `SocketListenerService` buffers text when BT is disconnected.

---

## Startup Sequence

### Auto-Start on Boot

| Component | Auto-start mechanism |
|---|---|
| Kotlin HID service | `BootReceiver` listens for `BOOT_COMPLETED` and `TermuxBoot.BOOT_COMPLETED`. Starts the foreground service if the "auto-start on boot" setting is enabled (same as SPEC-1) |
| Whisper server | Termux:Boot script in `~/.termux/boot/`. Starts the Python Flask server in a tmux session |
| PWA | **Cannot auto-start** — browsers don't support this. The user must manually open the PWA after boot |

**User flow after boot**: The Kotlin service and Whisper server auto-start. The user taps the foreground notification (from the Kotlin service) to open the Activity, then taps "Open Whisper Keyboard" to launch the PWA. This is a minor UX regression from SPEC-1's "everything auto-starts" experience, but unavoidable since web apps can't auto-launch.

---

## Testing

### Strategy

Each component tests itself with the simplest appropriate framework. No shared Gherkin feature files, no Cucumber, no BDD wrappers — these add ceremony without benefit for a solo developer project.

| Component | Framework | What to test |
|---|---|---|
| **Kotlin HID service** | JUnit | State machine transitions, HID keycode mapping, token validation, HTTP API responses. Mock `BluetoothHidDevice` callbacks. Table-driven tests |
| **Whisper server (Python)** | pytest | Flask API endpoints. Send a pre-recorded test WAV, verify JSON responses. Test model loading, error cases, concurrent request serialization |
| **PWA** | Playwright | E2E flows through real Chrome: polling `/status`, reacting to state changes, queuing text, flushing on reconnect. Playwright's built-in test runner |

### CI Integration

- **Kotlin**: `./gradlew test` (unit tests with mocked BT layer, no Android emulator needed)
- **Python**: `pytest scripts/tests/` in a Python job. Uses a pre-recorded test WAV file (no mic needed in CI). Whisper model downloaded and cached
- **PWA**: `npx playwright test` in a Node.js job. Backends mocked for isolated PWA testing

---

## Preserved from SPEC-1

These elements carry forward unchanged or with minimal adaptation:

| Element | Status |
|---|---|
| HID descriptor (boot protocol keyboard) | Identical |
| HidKeyMapper (char → USB HID keycode) | Identical |
| BluetoothHidDevice registration flow | Identical |
| Keystroke delay mechanism (default 10ms) | Identical |
| Foreground service with notification | Identical |
| whisper.cpp binary and model files | Identical |
| `setup-termux.sh` core logic | Adapted (adds Python/Flask install) |
| `update-model.sh` | Identical (add note about server restart) |
| `diagnose-sigill.sh` | Identical |
| Audio routing via VOICE_COMMUNICATION source | Identical (Termux still owns mic) |
| Text buffering during BT disconnect | Moved from SocketListenerService to PWA |
| BootReceiver for auto-start | Identical |
| Append newline/space settings | Moved from Kotlin SharedPreferences to PWA localStorage |
| Pinned items | Moved from SQLite to PWA localStorage |
| Transcript history with search | Moved from SQLite to PWA localStorage |

---

## Repository Structure

```
whisper-hid/
├── specs/
│   ├── SPEC-1-termux-hid.md              # Original spec (Termux + Kotlin two-component)
│   ├── SPEC-2-pwa-service-architecture.md # This spec (PWA + services three-component)
│   └── SPEC-2-REVIEW.md                  # Review notes for SPEC-2
│
├── app/                                   # Android Kotlin app (BT HID service)
│   ├── build.gradle.kts
│   └── src/
│       ├── main/
│       │   ├── AndroidManifest.xml
│       │   └── java/com/whisperbt/keyboard/
│       │       ├── MainActivity.kt        # Thin launcher Activity
│       │       ├── BluetoothHidService.kt # BT HID + HTTP API + SCO management
│       │       ├── HidKeyMapper.kt        # Char → HID keycode mapping
│       │       └── BootReceiver.kt        # Auto-start on boot
│       └── test/
│           └── java/com/whisperbt/keyboard/
│               ├── StateMachineTest.kt    # BT state machine transitions
│               ├── HidKeyMapperTest.kt    # Keycode mapping tests
│               └── ApiTest.kt            # HTTP API response tests
│
├── pwa/                                   # Progressive Web App (React + Vite + TypeScript)
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   ├── public/                            # Static assets (icons, etc.)
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                        # Root component + tab routing
│       ├── index.css                      # Tailwind directives
│       ├── hooks/
│       │   ├── useWhisper.ts             # Whisper server API client (start/stop/transcribe)
│       │   ├── useHidService.ts          # Kotlin HID service API client
│       │   └── useTranscriptStore.ts     # localStorage transcript history + pins
│       ├── components/
│       │   ├── TalkView.tsx              # PTT button, pinned chips, status
│       │   ├── HistoryView.tsx           # Searchable transcript list with pin/delete
│       │   ├── SettingsView.tsx          # Settings panel
│       │   ├── StatusBar.tsx             # BT + Whisper connection status
│       │   ├── EditBuffer.tsx            # Edit-before-send text area
│       │   └── DebugLog.tsx              # Debug log view
│       ├── lib/
│       │   └── api.ts                    # HTTP client helpers + auth token
│       └── types.ts                      # Shared TypeScript types
│
├── scripts/                               # Termux scripts
│   ├── setup-termux.sh                    # One-time environment setup (now includes Python/Flask)
│   ├── whisper-server.py                  # Whisper HTTP API server (Python + Flask)
│   ├── start-whisper-server.sh            # Start Whisper server in tmux
│   ├── stop-whisper-server.sh             # Stop Whisper server
│   ├── update-model.sh                    # Download/swap Whisper models
│   ├── diagnose-sigill.sh                 # CPU/build diagnostic tool
│   └── tests/
│       ├── test_transcribe.py             # pytest: Whisper API tests
│       └── fixtures/
│           └── test-hello.wav             # Pre-recorded test audio (16kHz mono PCM)
│
├── build.gradle.kts
├── settings.gradle.kts
├── CLAUDE.md
├── README.md
│
└── .github/
    └── workflows/
        ├── build-apk.yml                  # Build Android APK (triggers on app/ changes)
        ├── deploy-pwa.yml                 # Build PWA + deploy to GitHub Pages (triggers on pwa/ changes)
        └── test.yml                       # Run tests (Kotlin JUnit, Python pytest, Playwright)
```

### Files removed from SPEC-1

| File | Reason |
|---|---|
| `SocketListenerService.kt` | Replaced by HTTP API in BluetoothHidService |
| `TalkFragment.kt` | UI moved to PWA TalkView |
| `HistoryFragment.kt` | UI moved to PWA HistoryView |
| `SettingsFragment.kt` | UI moved to PWA SettingsView |
| `TranscriptionDatabase.kt` | Replaced by PWA localStorage |
| `TranscriptionEntry.kt` | Replaced by PWA TypeScript types |
| `HistoryAdapter.kt` | UI moved to PWA |
| `PinnedAdapter.kt` | UI moved to PWA |
| `start-stt.sh` | Replaced by whisper-server.py |
| `stop-stt.sh` | Replaced by stop-whisper-server.sh |
| `stt-loop.sh` | Recording/transcription logic moved into whisper-server.py |

### Files added in SPEC-2

| File | Purpose |
|---|---|
| `pwa/` (entire directory) | PWA UI application |
| `scripts/whisper-server.py` | Python + Flask Whisper HTTP server |
| `scripts/start-whisper-server.sh` | Server startup script |
| `scripts/stop-whisper-server.sh` | Server shutdown script |
| `scripts/tests/test_transcribe.py` | pytest tests for Whisper API |
| `.github/workflows/deploy-pwa.yml` | PWA build + GitHub Pages deploy |
| `.github/workflows/test.yml` | Test runner for all components |

---

## Key Differences from SPEC-1

| Concern | SPEC-1 (current) | SPEC-2 (proposed) |
|---------|--------|--------|
| Mic capture | Termux (`termux-microphone-record`) | Termux (`termux-microphone-record`) — unchanged |
| UI | Kotlin Activity with 3 Fragments (Talk, History, Settings) | PWA (HTML/CSS/JS) hosted on GitHub Pages |
| Transcription | whisper.cpp CLI in a bash loop (`stt-loop.sh`) | Whisper HTTP server (Python + Flask) |
| Kotlin app role | UI + socket listener + BT HID | BT HID service + HTTP API only (headless) |
| Communication | Raw TCP socket, newline-delimited | HTTP REST APIs |
| BT disconnect handling | `SocketListenerService` buffers text | PWA queues text, flushes on reconnect |
| Auth/security | None (any app can write to socket) | Shared secret token + CORS + PNA headers |
| Transcript storage | SQLite (`TranscriptionDatabase`) | `localStorage` in PWA |
| Settings storage | Android `SharedPreferences` | `localStorage` in PWA |
| PTT mode | Yes (primary interaction mode) | Yes (primary interaction mode) — preserved |
| Pinned items | Yes (SQLite-backed, chips on Talk tab) | Yes (localStorage-backed, chips on Talk view) — preserved |
| Append newline/space | Yes (SharedPreferences) | Yes (localStorage settings) — preserved |
| Boot auto-start | `BootReceiver` starts both services | `BootReceiver` starts Kotlin + Termux:Boot starts Whisper. PWA requires manual open |
| Audio SCO routing | `MainActivity.startBluetoothSco()` | `BluetoothHidService.setCommunicationDevice()` |
| Control messages | TCP: PAUSE, RESUME, BACKSPACE:N, MIC_READY | HTTP: `POST /backspace` only. Others dropped (see rationale above) |
| Testing | Manual only | JUnit + pytest + Playwright |
| Debug logs | Settings tab in Kotlin app | Debug view in PWA, pulling from `/logs` on both services |

---

## Migration Path

SPEC-2 development happens on a feature branch. The transition is not incremental — all three components deploy together:

1. **Kotlin app**: Refactored in place. Strip UI (remove Fragments, adapters, database), add HTTP server to `BluetoothHidService`, keep `BootReceiver` and `HidKeyMapper`
2. **Whisper server**: New component (`whisper-server.py`) that replaces `start-stt.sh` / `stt-loop.sh`
3. **PWA**: Entirely new (`pwa/` directory)
4. **Deploy all at once**: Merge feature branch to main. CI builds the APK and deploys the PWA to GitHub Pages. User sideloads the new APK and runs `setup-termux.sh` again (which now installs Python + Flask)

SPEC-1 and SPEC-2 **cannot coexist** on the same device during development (port 9876 conflict). Development uses a separate branch and testing device or toggled port configuration.

---

## Development Phases

### Phase 1: Whisper HTTP Server

**Goal**: Replace the bash loop + socket with a Python + Flask HTTP API wrapping whisper.cpp.

Steps:
1. Write `whisper-server.py` with `/transcribe`, `/transcribe/start`, `/transcribe/stop`, `/status`, `/logs` endpoints
2. Add CORS and Private Network Access headers
3. Test with `curl -X POST --data-binary @test.wav http://localhost:9876/transcribe`
4. Test PTT: `curl -X POST http://localhost:9876/transcribe/start`, speak, `curl -X POST http://localhost:9876/transcribe/stop`
5. Write pytest tests

**Success criteria**: Audio submitted via HTTP returns correct transcription. PTT start/stop cycle works.

### Phase 2: PWA Shell

**Goal**: Scaffold the PWA with Vite + React + TypeScript + Tailwind, deploy to GitHub Pages, wire up to Whisper server.

Steps:
1. Scaffold Vite project in `pwa/`
2. Add Tailwind CSS, `vite-plugin-pwa`
3. Configure `vite.config.ts` with PWA plugin and `base: "/whisper-hid/"`
4. Create `deploy-pwa.yml` GitHub Actions workflow
5. Build Talk view with PTT button, History view, Settings view
6. Build `useWhisper` hook — start/stop recording, receive text
7. Build `useTranscriptStore` — localStorage transcript history with pins
8. Build status bar with connection indicators
9. Push to main, verify GitHub Pages deployment, save to homescreen

**Success criteria**: Tap PTT in PWA, speak, see transcribed text. Pinned items work. History searchable.

### Phase 3: Kotlin Service Refactor

**Goal**: Strip the Kotlin app to a headless BT HID service with HTTP API.

Steps:
1. Remove Fragments, adapters, `TranscriptionDatabase`, `SocketListenerService`
2. Add HTTP server to `BluetoothHidService` (using `HttpServer`)
3. Implement `/type`, `/backspace`, `/status`, `/logs`, `/restart` endpoints
4. Implement BT connection state machine (IDLE → REGISTERED → CONNECTED → RECONNECTING → FAILED)
5. Implement auto-reconnect with exponential backoff
6. Move SCO management into `BluetoothHidService`
7. Implement auth token generation and validation
8. Add CORS + Private Network Access headers
9. Add "Open PWA" button that passes token via URL
10. Write JUnit tests

**Success criteria**: `POST /type` sends keystrokes. BT disconnect triggers auto-reconnect visible via `/status`. `POST /restart` recovers from stuck state.

### Phase 4: Integration

**Goal**: Wire all three components together.

Steps:
1. PWA reads auth token from URL, stores in `localStorage`
2. PWA sends transcribed text to Kotlin service via `/type` with append settings
3. PWA polls `/status` and displays BT connection state
4. Implement text queuing when BT is disconnected
5. Implement queue flush on BT reconnect
6. Implement re-authentication flow (detect 403, redirect through Kotlin Activity)
7. Verify pinned items, history, and settings all work end-to-end

**Success criteria**: Speak into phone → text appears on laptop. Disconnect BT → text queues. Reconnect → queued text sent. Close PWA tab → reopen from homescreen → re-authenticate → resume.

### Phase 5: Polish

**Goal**: Edit mode, debug view, startup scripts, Playwright tests.

Steps:
1. Add edit-before-send toggle and EditBuffer component
2. Add debug log view pulling from both `/logs` endpoints
3. Write `start-whisper-server.sh` and Termux:Boot integration
4. Write Playwright E2E tests
5. Verify PWA manifest and service worker (installability, offline shell)
6. Create `test.yml` CI workflow running all test suites

### Phase 6: Hardening

**Goal**: Production readiness.

- Auto-reconnect to Whisper server if Termux restarts
- Battery optimization (reduce polling when backgrounded)
- Edge case error states and user-facing messages
- Verify PNA behavior on current Chrome version

---

## Key Technical References

- **React**: https://react.dev/
- **Vite**: https://vite.dev/
- **Tailwind CSS**: https://tailwindcss.com/
- **vite-plugin-pwa**: https://vite-pwa-org.netlify.app/
- **Web Audio API / AudioWorklet**: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
- **BluetoothHidDevice API**: https://developer.android.com/reference/android/bluetooth/BluetoothHidDevice
- **whisper.cpp**: https://github.com/ggml-org/whisper.cpp
- **Flask**: https://flask.palletsprojects.com/
- **Playwright**: https://playwright.dev/

## Constraints

All constraints from SPEC-1 still apply:
- **No software on laptop**: Laptop sees a standard Bluetooth keyboard
- **On-device processing**: All transcription happens on the phone, no cloud APIs
- **Sideloaded APK**: Built via GitHub Actions, not on Play Store
- **Samsung S24 Ultra**: Primary target device (Snapdragon 8 Gen 3, Android 14+)
- **No external Kotlin dependencies**: Android SDK built-ins only for the Kotlin app

Additional constraints:
- **PWA hosted on GitHub Pages**: Served at `https://jonathan-a-white.github.io/whisper-hid/`, saved to homescreen via Chrome. No local HTTP server for the PWA
- **PWA must work on Android Chrome**: Tested on Chrome for Android, connecting to localhost services via Private Network Access
- **PWA built with Vite + React + TypeScript**: CI builds and deploys to GitHub Pages. Node.js is a dev/CI dependency only — not required on the phone
- **Minimal PWA runtime dependencies**: Only `react` and `react-dom`. Tailwind and Vite are dev-only
- **Python available in Termux**: Used for the Whisper server, installable via `pkg install python` and `pip install flask`
- **Mic capture stays in Termux**: The PWA does not use `getUserMedia()` — Bluetooth SCO limitations make browser-based mic capture unreliable (see Architecture section)
