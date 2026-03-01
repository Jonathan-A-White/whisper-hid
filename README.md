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
2. **Termux (whisper-server.py)** — Python+Flask HTTP server on localhost:9876, captures mic audio and runs Whisper speech-to-text
3. **Kotlin App (BT HID)** — Headless Bluetooth HID service with HTTP API on localhost:9877, sends keystrokes to the paired laptop

## Requirements

- Android phone with Android 9+ (tested on Samsung S24 Ultra)
- [Termux](https://f-droid.org/en/packages/com.termux/) from F-Droid (NOT Google Play)
- [Termux:API](https://f-droid.org/en/packages/com.termux.api/) from F-Droid
- Any Bluetooth-capable laptop

## Quick Start

### 1. Install the Android App

Download the latest APK from [GitHub Actions](../../actions) artifacts and sideload it on your phone.

Or build it yourself:

```bash
./gradlew assembleDebug
# APK at: app/build/outputs/apk/debug/app-debug.apk
```

### 2. Set Up Termux

Install Termux and Termux:API from F-Droid, then run:

```bash
# Copy scripts to phone or clone this repo in Termux
git clone <this-repo-url>
cd whisper-hid

# Run one-time setup (installs deps, builds whisper.cpp, downloads model)
bash scripts/setup-termux.sh
```

### 3. Pair and Connect

1. Open the **Whisper Keyboard** app — it runs as a headless service
2. On your laptop, go to Bluetooth settings and pair with "Whisper Keyboard"

### 4. Start Transcription

In Termux:

```bash
cd ~/whisper-stt
./start-whisper-server.sh
```

Then open the PWA in your phone's browser. Speak into your microphone — text will appear on your laptop as keyboard input.

### 5. Stop

```bash
./stop-whisper-server.sh
```

## Whisper Models

Swap models for different speed/accuracy trade-offs:

```bash
./scripts/update-model.sh <model-name>
```

| Model | Size | Speed (S24 Ultra) | Accuracy |
|-------|------|-------------------|----------|
| `tiny.en` | 75 MB | ~10x real-time | Basic |
| `base.en` | 142 MB | ~5x real-time | Good |
| `small.en` | 466 MB | ~2x real-time | Better |
| `distil-small.en` | ~350 MB | ~2-3x real-time | Better (optimized) |

Default model is `base.en`.

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
│   ├── setup-termux.sh
│   ├── whisper-server.py
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
