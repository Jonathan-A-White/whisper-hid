# Whisper Bluetooth Keyboard

Turn your Android phone into a speech-to-text Bluetooth keyboard. Whisper runs locally on the phone, transcribes your speech, and sends the text to a paired laptop as standard Bluetooth keyboard input. No software installation required on the laptop.

## How It Works

```
┌──────────────────────────────────────────────────────┐
│  Android Phone                                       │
│                                                      │
│  ┌─────────────────┐  HTTP :9876  ┌───────────────┐  │
│  │  Termux          │◄────────────│  PWA           │  │
│  │  whisper-server  │             │  (Browser)     │  │
│  │  - Captures mic  │────────────►│  - UI          │  │
│  │  - Runs Whisper  │  JSON text  │  - Orchestrates│  │
│  └─────────────────┘              └───────┬───────┘  │
│                                           │          │
│  ┌─────────────────┐  HTTP :9877          │          │
│  │  Kotlin App      │◄───────────────────┘           │
│  │  BT HID service  │                               │
│  │  - Sends keys    │         Bluetooth HID          │
│  │    via BT HID    │ ──────────────────────►        │
│  └─────────────────┘                      ┌────────┐ │
│                                           │ Laptop │ │
│                                           │ sees a │ │
│                                           │keyboard│ │
│                                           └────────┘ │
└──────────────────────────────────────────────────────┘
```

Three components running on the same phone:

1. **PWA (Browser)** — UI and orchestration, hosted on GitHub Pages, saved to homescreen
2. **Termux (whisper-server.py)** — Python+Flask HTTP server on localhost:9876, captures mic audio and runs speech-to-text (Parakeet or Whisper)
3. **Kotlin App (BT HID)** — Headless Bluetooth HID service with HTTP API on localhost:9877, sends keystrokes to the paired laptop

## Requirements

- Android phone with Android 9+ (tested on Samsung S24 Ultra)
- [Termux](https://f-droid.org/en/packages/com.termux/) from F-Droid (NOT Google Play)
- [Termux:API](https://f-droid.org/en/packages/com.termux.api/) from F-Droid
- Any Bluetooth-capable laptop

## Quick Start (new phone)

### 1. Install Termux and Termux:API

Install [Termux](https://f-droid.org/en/packages/com.termux/) and
[Termux:API](https://f-droid.org/en/packages/com.termux.api/) from F-Droid
(NOT Google Play), then grant Termux:API microphone permission
(Android Settings > Apps > Termux:API > Permissions).

### 2. Run the bootstrap command

Open Termux and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/Jonathan-A-White/whisper-hid/main/scripts/bootstrap.sh | bash
```

This clones the repo, installs dependencies, builds whisper.cpp, downloads
the default model, fetches the latest APK from GitHub Releases (opening the
Android installer for you), and starts the Whisper server. It's idempotent —
safe to re-run if anything fails partway.

### 3. Follow the guided setup in the PWA

Open the PWA at <https://jonathan-a-white.github.io/whisper-hid/>. On a new
phone it shows a **setup wizard** that detects each component as it comes
online and walks you through the remaining manual steps with copyable
commands:

1. Install the **Whisper Keyboard** app (installer opened by the bootstrap)
2. Tap **"Open Whisper Keyboard"** in the app to authenticate the PWA
3. On your laptop, pair Bluetooth with **"Whisper Keyboard"**
4. Run the built-in microphone test

The wizard is also available later from **Settings > Setup guide**.

Then speak into your microphone — text appears on your laptop as keyboard input.

### Manual setup (alternative)

```bash
# In Termux:
git clone https://github.com/Jonathan-A-White/whisper-hid
cd whisper-hid
bash scripts/setup-termux.sh    # installs deps, builds whisper.cpp, downloads model

# Start/stop the server:
cd ~/whisper-stt
./start-whisper-server.sh
./stop-whisper-server.sh
```

Build the APK yourself with `./gradlew assembleDebug`
(output: `app/build/outputs/apk/debug/app-debug.apk`), or download it from the
[`latest-apk` release](../../releases/tag/latest-apk) (updated by CI on every
push to main).

## Speech Models

Two transcription engines are supported:

- **Parakeet** (NVIDIA Parakeet TDT 0.6B, recommended) — runs in-process via
  onnxruntime. Faster *and* more accurate than every whisper option below.
  Installed automatically by `setup-termux.sh`; the server prefers it at
  startup whenever it's present.
- **whisper.cpp** — the original engine, used as the automatic fallback
  when Parakeet isn't installed (or if it ever fails).

Swap models for different speed/accuracy trade-offs:

```bash
./scripts/update-model.sh <model-name>
```

| Model | Size | Speed (S24 Ultra) | Accuracy |
|-------|------|-------------------|----------|
| `parakeet` | ~640 MB | ~10x real-time | Best (comparable to whisper large-v3) |
| `tiny.en` | 75 MB | ~10x real-time | Basic |
| `base.en` | 142 MB | ~5x real-time | Good |
| `small.en` | 466 MB | ~2x real-time | Better |
| `distil-small.en` | ~350 MB | ~2-3x real-time | Better (optimized) |

Default whisper model is `base.en`. The active model can also be switched
from the PWA: **Settings > Speech model**.

### Adding Parakeet to an existing install

Phones set up before Parakeet support need three commands in Termux:

```bash
pkg install python-numpy python-onnxruntime   # prebuilt — pip can't build these on Android
~/whisper-hid/scripts/update-model.sh parakeet # ~480 MB download
cd ~/whisper-stt && ./stop-whisper-server.sh && ~/whisper-hid/scripts/start-whisper-server.sh
```

Verify with `curl http://localhost:9876/status` — it should report
`"engine": "parakeet"`, and the PWA's top bar will show the active model.

## Project Structure

```
whisper-hid/
├── app/                          # Android Kotlin app (BT HID service)
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       └── java/com/whisperbt/keyboard/
├── pwa/                          # PWA (React + TypeScript)
│   ├── src/
│   └── vite.config.ts
├── scripts/                      # Termux scripts
│   ├── bootstrap.sh              # One-command new-phone setup (curl | bash)
│   ├── setup-termux.sh
│   ├── whisper-server.py
│   ├── parakeet_onnx.py          # Parakeet inference on onnxruntime + numpy
│   ├── start-whisper-server.sh
│   ├── stop-whisper-server.sh
│   └── update-model.sh
├── .github/workflows/
│   ├── build-apk.yml            # CI: build APK on push
│   └── deploy-pwa.yml           # CI: deploy PWA to GitHub Pages
├── build.gradle.kts
└── settings.gradle.kts
```

## CI/CD

The GitHub Actions workflow builds a debug APK on every push to `main`. Download it from the Actions tab artifacts. Tagged releases (e.g., `v1.0`) automatically create GitHub Releases with the APK attached.

## License

See [LICENSE](LICENSE).
