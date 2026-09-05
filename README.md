# Whisper Bluetooth Keyboard

Turn your Android phone into a speech-to-text Bluetooth keyboard. Speech recognition runs locally on the phone (Parakeet or Whisper — no network), and the text is sent to a paired laptop as standard Bluetooth keyboard input. No software installation required on the laptop.

## How It Works

```
┌──────────────────────────────────────────────────────┐
│  Android Phone                                       │
│                                                      │
│  ┌─────────────────┐  HTTP :9876  ┌───────────────┐  │
│  │  Termux          │◄────────────│  PWA           │  │
│  │  whisper-server  │             │  (Browser)     │  │
│  │  - Captures mic  │────────────►│  - UI          │  │
│  │  - Transcribes   │  JSON text  │  - Orchestrates│  │
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

## Updating

```bash
cd ~/whisper-hid
git pull                            # Termux scripts + server
./scripts/update-apk.sh             # newest APK, opens the Android installer
cd ~/whisper-stt && ./stop-whisper-server.sh && ~/whisper-hid/scripts/start-whisper-server.sh
```

`update-apk.sh` fetches the rolling `latest-apk` build and opens the
installer; debug APKs are signed with a keystore checked into the repo, so
updates install over the previous version without an uninstall. The PWA
updates itself — CI deploys it to GitHub Pages on every push to main.

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

## Dictation features

All of these run on the phone and are toggled from the PWA:

- **Speech cleanup** — a small local LLM (Qwen3) removes filler words and
  false starts, resolves spoken self-corrections, and fixes punctuation.
  Pick a *style* (plain, Claude Code prompt, commit message, Slack, email,
  bug report) next to the toggle on the Talk screen.
- **Symbol mode** — spoken phrases become symbols ("forward slash help" →
  `/help`, "foo dash bar" → `foo-bar`) for dictating to CLIs. Cleanup is
  skipped while it's on, so the text stays verbatim.
- **Word corrections** — a dictionary that fixes misrecognized proper nouns
  after every transcription; its terms are also fed to the cleanup LLM so it
  can fix them in context. "✨ Suggest corrections" mines recent transcripts
  for likely mishearings.
- **Voice editing** — with "Edit before send" on, speak an instruction
  ("replace Mike with Sarah") to edit the pending text before it's typed.
- **Streaming transcription** — long dictations are transcribed in the
  background at silence boundaries while you speak, so tapping Stop costs
  about a second instead of the whole recording.
- **Bluetooth headset mic** — the Android app routes the headset's mic to
  Termux system-wide and holds the link open; *Zoom mode* releases it so a
  laptop sharing the same multipoint headset can use it for a call.
- **Stop typing** — a kill switch on the Talk screen that halts an in-flight
  send and releases any held key.

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
│   ├── update-model.sh
│   ├── update-apk.sh             # Install the newest APK from GitHub Releases
│   ├── diagnose-sigill.sh
│   └── tests/                    # pytest suite for the server
├── .github/workflows/
│   ├── build-apk.yml            # CI: build APK on push
│   ├── deploy-pwa.yml           # CI: deploy PWA to GitHub Pages
│   ├── test-python.yml          # CI: pytest scripts/tests/
│   └── test-kotlin.yml          # CI: ./gradlew test
├── build.gradle.kts
└── settings.gradle.kts
```

## CI/CD

Every push to `main` builds a debug APK and republishes it as the rolling
[`latest-apk` release](../../releases/tag/latest-apk), which
`scripts/bootstrap.sh` and `scripts/update-apk.sh` download. Tagged releases
(e.g. `v1.0`) also create a GitHub Release with the APK attached, and the
build is available from the Actions tab artifacts. Pushes touching `pwa/`
deploy the PWA to GitHub Pages. Python and Kotlin tests run on every push and
pull request.

## License

See [LICENSE](LICENSE).
