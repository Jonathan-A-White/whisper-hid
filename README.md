# Whisper Bluetooth Keyboard

Turn your Android phone into a speech-to-text Bluetooth keyboard. Whisper runs locally on the phone, transcribes your speech, and sends the text to a paired laptop as standard Bluetooth keyboard input. No software installation required on the laptop.

## How It Works

```
┌─────────────────────────────────────────────────┐
│  Android Phone                                  │
│                                                 │
│  ┌───────────────────────┐                      │
│  │  Termux               │                      │
│  │  whisper.cpp process  │                      │
│  │  - Captures mic audio │                      │
│  │  - Runs Whisper model │                      │
│  │  - Outputs text via   │                      │
│  │    localhost TCP :9876 │                      │
│  └──────────┬────────────┘                      │
│             │ TCP socket                        │
│  ┌──────────▼────────────┐    Bluetooth HID     │
│  │  Kotlin App           │ ──────────────────►  │
│  │  - Reads from socket  │    Keyboard profile  │
│  │  - Sends keystrokes   │                      │
│  │    via BT HID API     │         ┌──────────┐ │
│  └───────────────────────┘  ────►  │ Laptop   │ │
│                                    │ sees a   │ │
│                                    │ keyboard │ │
│                                    └──────────┘ │
└─────────────────────────────────────────────────┘
```

Two components running on the same phone:

1. **Termux (whisper.cpp)** — Captures mic audio, runs Whisper speech-to-text, writes transcribed text to a localhost TCP socket
2. **Android App (Kotlin)** — Reads text from the socket and sends it as Bluetooth HID keyboard keystrokes to the paired laptop

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

1. Open the **Whisper Keyboard** app
2. Tap **Pair / Discoverable** to make the phone visible
3. On your laptop, go to Bluetooth settings and pair with "Whisper Keyboard"
4. Tap **Start** in the app

### 4. Start Transcription

In Termux:

```bash
cd ~/whisper-stt
./start-stt.sh
```

Speak into your microphone — text will appear on your laptop as keyboard input.

### 5. Stop

```bash
./stop-stt.sh
```

Or tap **Stop** in the Android app.

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

## App Settings

- **Keystroke delay (ms)** — Delay between keystrokes to prevent dropped keys (default: 10ms)
- **Socket port** — TCP port for Termux communication (default: 9876)
- **Add newline after segment** — Adds Enter after each transcription chunk
- **Add space between segments** — Adds a space between consecutive chunks (default: on)

## Project Structure

```
whisper-hid/
├── app/                          # Android Kotlin app
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/whisperbt/keyboard/
│       │   ├── MainActivity.kt
│       │   ├── BluetoothHidService.kt
│       │   ├── SocketListenerService.kt
│       │   ├── HidKeyMapper.kt
│       │   └── BootReceiver.kt
│       └── res/
├── scripts/                      # Termux scripts
│   ├── setup-termux.sh
│   ├── start-stt.sh
│   ├── stop-stt.sh
│   └── update-model.sh
├── .github/workflows/
│   └── build-apk.yml            # CI: build APK on push
├── build.gradle.kts
├── settings.gradle.kts
└── SPEC-1.md                    # Full project specification
```

## CI/CD

The GitHub Actions workflow builds a debug APK on every push to `main`. Download it from the Actions tab artifacts. Tagged releases (e.g., `v1.0`) automatically create GitHub Releases with the APK attached.

## License

See [LICENSE](LICENSE).
