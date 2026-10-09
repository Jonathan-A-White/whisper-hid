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

This clones the repo, installs dependencies, installs the Parakeet
model, fetches the latest APK from GitHub Releases (opening the
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
bash scripts/setup-termux.sh    # installs deps, Parakeet and the cleanup LLM

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

One command does the whole phone — pull, reinstall the Python packages
(`scripts/requirements.txt`), restart the server on the new code, install the
newest APK, and clear out old downloads:

```bash
~/whisper-hid/scripts/update-all.sh
```

Flags for doing less: `--no-pull`, `--no-server`, `--no-apk`, `--no-clean`
(keep old APKs and CI artifact folders), `--no-open` (stage the APK without
launching the installer).

The pieces also run standalone:

```bash
cd ~/whisper-hid
git pull                            # Termux scripts + server
./scripts/update-apk.sh             # newest APK, opens the Android installer
./scripts/stop-whisper-server.sh && ./scripts/start-whisper-server.sh
```

`update-apk.sh` fetches the rolling `latest-apk` build and opens the
installer. It also sets `allow-external-apps = true` in
`~/.termux/termux.properties` (without it Termux's content provider refuses
to hand the APK to Android's installer) and stages a copy in
`~/storage/downloads`, so if the installer still won't launch you can tap
the APK in the Files app under Downloads. If an app chooser appears, pick
**Package installer**, not Termux.

Debug APKs are signed with a keystore checked into the repo, so updates
install over the previous version without an uninstall — but an APK built
*before* that keystore landed has a different signature, and going from one
of those to a current build fails with "App not installed" until you
uninstall the old app first.

The PWA updates itself — CI deploys it to GitHub Pages on every push to main.

### Troubleshooting

- **"Whisper server offline" after a `pkg upgrade`**: the upgrade can replace
  Python and drop its pip packages. `start-whisper-server.sh` now says which
  module is missing; fix it with
  `pip install -r ~/whisper-hid/scripts/requirements.txt` (numpy and
  onnxruntime come from `pkg install python-numpy python-onnxruntime`, never
  pip), then run `update-all.sh` or `start-whisper-server.sh` again.

## Speech Models

One engine: **Parakeet TDT 0.6B v2** (NVIDIA, int8) — runs in-process on the
phone via onnxruntime, ~10x real-time, accuracy comparable to whisper
large-v3. `setup-termux.sh` installs it; the server will not transcribe
without it, and says to run `./scripts/update-model.sh parakeet` if the model
is missing. **Settings > Speech model** just shows it.

Considered and removed (2026-10): whisper.cpp (ggml tiny.en to large-v3-turbo) and Nemotron Speech Streaming 0.6B (live partial text, but much slower than Parakeet on the phone). Parakeet was the best.

`STT_ENGINE` accepts `auto` or `parakeet` (the same thing); any other value
is logged as an error and treated as `auto`. A phone set up before this change
can reclaim space by deleting the old engines' leftovers under
`~/whisper-stt`: the `models/*.bin` files, the engine's source-and-build
directory (the one next to `llama.cpp`) and any `models/sherpa-onnx-nemotron-*`
directory.

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
  Termux system-wide, but only while a dictation runs: the headset's call
  link opens when you start recording and closes when the text is back, so
  music, video and voice from other apps play normally on the headset the
  rest of the time. Settings > *Keep the headset link warm* holds the link
  whenever the headset is connected instead (first word a moment sooner, but
  a headset with a mic then plays no other audio). *Zoom mode* releases the
  link entirely so a laptop sharing the same multipoint headset can use it
  for a call.
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
│   ├── requirements.txt          # pip packages the server needs (flask)
│   ├── start-whisper-server.sh
│   ├── stop-whisper-server.sh
│   ├── update-model.sh
│   ├── update-all.sh             # Update the whole phone: pull, pip, server, APK
│   ├── update-apk.sh             # Install the newest APK from GitHub Releases
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

## Credits

> "If I have seen further it is by standing on the shoulders of Giants."
> — Isaac Newton, in a letter to Robert Hooke, 1675

Whisper Keyboard only works because of the people and projects below, so each one is named here with what we use it for, its licence and anything we changed. The same list is on the **About** screen (Settings > Credits), from `pwa/src/lib/credits.ts`; a test fails when a dependency is missing from it.

A source added or removed changes its credit in the same commit, and the test says so: it fails on a dependency with no credit, on a credit for a package that is no longer a dependency, and on a bundled font or data file no credit names.

### Ideas and tools we build with

- [Beads](https://github.com/steveyegge/beads): Steve Yegge's issue tracker for AI agents. This project is built through a software factory that tracks every story as a bead. Licence: [MIT](https://github.com/steveyegge/beads/blob/main/LICENSE). Changes: None. We use the tool and its idea as published.
- [Gas Town](https://github.com/steveyegge/gastown): Steve Yegge's multi-agent workspace manager. The factory's roles (a mayor who plans, builders who work one story each) borrow its ideas. Licence: [MIT](https://github.com/steveyegge/gastown/blob/main/LICENSE). Changes: Ideas only; none of its code is included here.
- [Claude Code](https://www.anthropic.com/claude-code): Anthropic's coding agent. Much of this code was written with it, and the keyboard is built to dictate into it. Licence: [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms). Changes: None.

### This screen (the PWA)

- [React and React DOM](https://react.dev): The user interface library this app is written in. Licence: [MIT](https://github.com/facebook/react/blob/main/LICENSE). Changes: None.
- [Vite](https://vite.dev): Builds and bundles the PWA. Licence: [MIT](https://github.com/vitejs/vite/blob/main/LICENSE). Changes: None.
- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react): Lets Vite compile the React code. Licence: [MIT](https://github.com/vitejs/vite-plugin-react/blob/main/LICENSE). Changes: None.
- [vite-plugin-pwa and Workbox](https://github.com/vite-pwa/vite-plugin-pwa): Makes the PWA installable and offline-capable, and generates its service worker with Google's Workbox. Licence: [MIT (vite-plugin-pwa), Apache-2.0 (Workbox)](https://github.com/vite-pwa/vite-plugin-pwa/blob/main/LICENSE). Changes: None.
- [Tailwind CSS](https://tailwindcss.com): The styling of every screen. Licence: [MIT](https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE). Changes: None.
- [PostCSS](https://postcss.org): Runs Tailwind when the PWA is built. Licence: [MIT](https://github.com/postcss/postcss/blob/main/LICENSE). Changes: None.
- [Autoprefixer](https://github.com/postcss/autoprefixer): Adds browser prefixes to the CSS at build time. Licence: [MIT](https://github.com/postcss/autoprefixer/blob/main/LICENSE). Changes: None.
- [TypeScript](https://www.typescriptlang.org): The language the PWA is written in. Licence: [Apache-2.0](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt). Changes: None.
- [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped): The type definitions for React (@types/react, @types/react-dom). Licence: [MIT](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE). Changes: None.
- [Vitest](https://vitest.dev): Runs the PWA's tests. Licence: [MIT](https://github.com/vitest-dev/vitest/blob/main/LICENSE). Changes: None.

### The Android app

- [Android Open Source Project](https://source.android.com): The Android platform, including the BluetoothHidDevice API that lets the phone act as a Bluetooth keyboard, and the Android Gradle Plugin that builds the app. Licence: [Apache-2.0](https://source.android.com/docs/setup/about/licenses). Changes: None.
- [AndroidX Core KTX](https://developer.android.com/jetpack/androidx/releases/core): Kotlin extensions for the Android framework, used by the Bluetooth service. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Changes: None.
- [AndroidX AppCompat](https://developer.android.com/jetpack/androidx/releases/appcompat): Backwards-compatible activities and themes for the app's launcher screen. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Changes: None.
- [Material Components for Android](https://github.com/material-components/material-components-android): Material Design widgets for the app's launcher screen. Licence: [Apache-2.0](https://github.com/material-components/material-components-android/blob/master/LICENSE). Changes: None.
- [Kotlin](https://kotlinlang.org): The language the Android app is written in. Licence: [Apache-2.0](https://github.com/JetBrains/kotlin/blob/master/license/LICENSE.txt). Changes: None.
- [Gradle](https://gradle.org): Builds the Android app and runs its tests. Licence: [Apache-2.0](https://github.com/gradle/gradle/blob/master/LICENSE). Changes: None.
- [JUnit 4](https://junit.org/junit4/): Tests the Android app (key mapping, link warm-up, crash records). Licence: [EPL-1.0](https://www.eclipse.org/legal/epl-v10.html). Changes: None.

### The Termux server

- [Flask](https://flask.palletsprojects.com): The web framework of the Whisper server on the phone. Licence: [BSD-3-Clause](https://github.com/pallets/flask/blob/main/LICENSE.txt). Changes: None.
- [NumPy](https://numpy.org): Audio feature extraction and decoding maths for Parakeet. Licence: [BSD-3-Clause](https://github.com/numpy/numpy/blob/main/LICENSE.txt). Changes: None. Installed from Termux's packages, not pip.
- [ONNX Runtime](https://onnxruntime.ai): Runs the Parakeet model on the phone's processor. Licence: [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE). Changes: None. Installed from Termux's packages, not pip.
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): Where it can be installed (laptops, CI) it is the speech decoder. On the phone our own port of its Parakeet reference script is used instead, and its release page hosts the model download. Licence: [Apache-2.0](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE). Changes: scripts/parakeet_onnx.py is a port of its Parakeet reference script to plain NumPy and ONNX Runtime, checked to give byte-identical transcripts.
- [kaldi-native-fbank](https://github.com/csukuangfj/kaldi-native-fbank): The filterbank feature settings the Parakeet model was exported with, which our port reproduces exactly. Licence: [Apache-2.0](https://github.com/csukuangfj/kaldi-native-fbank/blob/master/LICENSE). Changes: Settings matched in Python; none of its code is included.
- [librosa](https://librosa.org): The mel scale (Slaney) the Parakeet features are built on. Licence: [ISC](https://github.com/librosa/librosa/blob/main/LICENSE.md). Changes: The formula is re-implemented; none of its code is included.

### Speech and language models

- [NVIDIA Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2): The speech-to-text model that turns your voice into text, entirely on the phone. Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: We use the int8-quantised ONNX export published by sherpa-onnx, not NVIDIA's original NeMo checkpoint.
- [OpenAI Whisper](https://github.com/openai/whisper): The speech model this keyboard was first built on, and the source of its name. Parakeet replaced it in October 2026. Licence: [MIT](https://github.com/openai/whisper/blob/main/LICENSE). Changes: None; no longer included.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp): Ran Whisper on the phone until Parakeet replaced it in October 2026. Licence: [MIT](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE). Changes: None; no longer included.
- [llama.cpp](https://github.com/ggml-org/llama.cpp): Runs the small language model that tidies up what you said (filler words, punctuation, styles, voice edits), on the phone. Licence: [MIT](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE). Changes: Built from source in Termux with -DGGML_NATIVE=OFF; no code changes.
- [Qwen3](https://huggingface.co/Qwen/Qwen3-1.7B): Alibaba's Qwen3 1.7B (the default) and 4B models do the cleanup rewrite. Licence: [Apache-2.0](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE). Changes: Used as the 4-bit (Q4_K_M) GGUF files converted by Unsloth, with a prompt of our own.
- [Qwen3.5](https://huggingface.co/Qwen/Qwen3.5-2B): Alibaba's Qwen3.5 2B and 0.8B models, offered as faster options for the cleanup rewrite. Licence: [Apache-2.0](https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE). Changes: Used as the 4-bit (Q4_K_M) GGUF files converted by Unsloth, with a prompt of our own.
- [Unsloth](https://huggingface.co/unsloth): Publishes the GGUF conversions of the Qwen models that the phone downloads. Licence: [Apache-2.0 (the model files carry the Qwen licence)](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF). Changes: None.

### On the phone

- [Termux](https://termux.dev): The Linux environment on the phone where the Whisper server and the language model run. Licence: [GPL-3.0](https://github.com/termux/termux-app/blob/master/LICENSE.md). Changes: None.
- [Termux:API](https://github.com/termux/termux-api): Gives the server access to the microphone. Licence: [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html). Changes: None. The server calls its MicRecorder service directly when a non-default audio source is chosen.
- [FFmpeg](https://ffmpeg.org): Converts and slices the recording before it is transcribed. Licence: [LGPL-2.1+ / GPL-2.0+ (depends on the build)](https://ffmpeg.org/legal.html). Changes: None. Installed from Termux's packages.

### Services

- [GitHub](https://github.com): Hosts the source, builds the Android app and this PWA, and serves both (GitHub Pages and Releases). Licence: [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service). Changes: None.
- [Hugging Face](https://huggingface.co): Where the phone downloads the cleanup language models. Licence: [Hugging Face Terms of Service](https://huggingface.co/terms-of-service). Changes: None.

## License

See [LICENSE](LICENSE).
