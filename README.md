# Whisper BT Keyboard

Turn your Samsung Galaxy S24 Ultra into a **speech-to-text Bluetooth keyboard**.
Whisper runs entirely on-device; transcribed text is sent to a paired laptop as
standard Bluetooth keyboard input — no drivers, no software, no admin access
needed on the laptop side.

---

## How it works

```
  ┌─────────────────────────────────┐
  │  Samsung S24 Ultra              │
  │                                 │
  │  Termux: whisper.cpp            │    Bluetooth HID
  │  mic → transcribe → :9876  ───► │  ──────────────────► ThinkPad
  │                                 │    (appears as a
  │  Kotlin App: reads :9876        │     USB keyboard)
  │  → keystrokes via BT HID API ──►│
  └─────────────────────────────────┘
```

**Component 1 — Termux** (`scripts/`): Records microphone audio, runs Whisper,
streams transcription lines over `localhost:9876`.

**Component 2 — Kotlin App** (`app/`): Reads from that socket, converts text to
USB HID keycodes, and sends them to the laptop via `BluetoothHidDevice` API.

---

## Requirements

| Item | Notes |
|------|-------|
| Samsung Galaxy S24 Ultra (or similar) | Android 9+ required |
| [Termux](https://f-droid.org/packages/com.termux/) | Install from **F-Droid only** (Play Store version is broken) |
| [Termux:API](https://f-droid.org/packages/com.termux.api/) | Required for microphone access |
| [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) | Optional — for auto-start on reboot |
| Laptop with Bluetooth | No software installation needed |

---

## Quick start

### Step 1 — Install the APK

1. Push a commit to `main` or download from a tagged GitHub release
2. Go to **Actions → latest run → Artifacts** and download `whisper-bt-keyboard-debug.apk`
3. Transfer the APK to your phone (AirDrop, Google Drive, USB, etc.)
4. Enable **Install from unknown sources** in Android settings
5. Install the APK

### Step 2 — Set up Termux

Open Termux and run:

```bash
# Clone this repository
git clone https://github.com/Jonathan-A-White/whisper-hid.git
cd whisper-hid

# Run one-time setup (builds whisper.cpp, downloads base.en model)
bash scripts/setup-termux.sh
```

This takes ~5–10 minutes (compiling whisper.cpp natively).

### Step 3 — Pair phone with laptop

1. Open the **Whisper BT Keyboard** app on your phone
2. Tap **Bluetooth Settings**
3. On the laptop, open Bluetooth and search for devices
4. Pair "Whisper Keyboard" from the laptop's Bluetooth menu

### Step 4 — Start transcription

In the app, tap **Start Services**. In Termux:

```bash
bash scripts/start-stt.sh --tmux
```

Speak into your headset — text appears on the laptop.

---

## Termux scripts reference

| Script | Purpose |
|--------|---------|
| `setup-termux.sh [model]` | One-time setup; builds whisper.cpp, downloads model |
| `start-stt.sh [options]` | Start the STT loop |
| `stop-stt.sh` | Stop gracefully |
| `update-model.sh <model>` | Download/swap Whisper model |

### `start-stt.sh` options

```
--model <name>   Model name (default: base.en)
--port  <num>    TCP port (default: 9876)
--chunk <sec>    Audio chunk length (default: 5)
--lang  <code>   Language code (default: en)
--tmux           Run in persistent tmux session
--stream         Use stream mode (experimental)
```

---

## Whisper models

| Model | Size | Speed on S24 Ultra | Accuracy |
|-------|------|--------------------|----------|
| `tiny.en` | 75 MB | ~10× real-time | Basic |
| `base.en` | 142 MB | ~5× real-time | Good ← **default** |
| `small.en` | 466 MB | ~2× real-time | Better |
| `distil-small.en` | ~350 MB | ~2–3× real-time | Better (optimized) |
| `medium.en` | 1.5 GB | ~1× real-time | Best English |

Swap models anytime:

```bash
bash scripts/update-model.sh distil-small.en
bash scripts/start-stt.sh --model distil-small.en --tmux
```

---

## App settings

| Setting | Default | Notes |
|---------|---------|-------|
| TCP Port | 9876 | Must match `start-stt.sh --port` |
| Keystroke delay | 10 ms | Increase if keys are dropped |
| Append newline | On | Sends Enter after each segment |
| Append space | Off | Alternative to newline |
| Auto-start on boot | Off | Requires Termux:Boot for Termux side |

---

## Testing

**Socket only** (no speech required):

```bash
# In Termux — sends text directly to the Kotlin app
echo "Hello from Termux" | nc 127.0.0.1 9876
```

**Bluetooth only** (no socket required):
Start services from the app, then test with the socket command above.

---

## Building the APK yourself

```bash
# Requires JDK 17 + Android SDK
./gradlew assembleDebug

# APK location:
# app/build/outputs/apk/debug/whisper-bt-keyboard-debug.apk
```

If `./gradlew` fails (missing wrapper jar), bootstrap it first:
```bash
gradle wrapper --gradle-version 8.4
```

---

## Architecture notes

- **`BluetoothHidDevice` API** (Android 9+, API 28) — used without root. The phone
  registers itself as a Bluetooth HID keyboard using a standard USB HID descriptor.
- **whisper.cpp in Termux** — compiled natively with ARM64 NEON/dotprod flags for
  best performance on Snapdragon 8 Gen 3.
- **Localhost TCP socket** — bridges the two components without any IPC
  complexity. The Termux process writes lines; the Kotlin app reads them.
- **No Play Store** — the APK is sideloaded. It uses a debug keystore; release
  signing can be added later.

---

## License

MIT — see [LICENSE](LICENSE).
