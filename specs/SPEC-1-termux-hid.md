# Whisper Bluetooth Keyboard — Project Specification

## Overview

An on-device speech-to-text system that runs on a Samsung Galaxy S24 Ultra (later S26 Ultra), transcribes speech using Whisper, and sends the transcribed text to a paired laptop as Bluetooth keyboard input. The user cannot install software on their work laptop, so the phone acts as an external Bluetooth keyboard that types what you say.

## Problem

The user commutes to Manhattan and wants hands-free text input to their work laptop (ThinkPad X1 Carbon). They cannot install any software on the work laptop. The solution must appear to the laptop as a standard Bluetooth keyboard — no drivers, no apps, no admin access required on the laptop side.

## Architecture

Two-component system running on the same Android phone:

```
┌─────────────────────────────────────────────────┐
│  Samsung S24 Ultra                              │
│                                                 │
│  ┌───────────────────────┐                      │
│  │  Component 1: Termux  │                      │
│  │  whisper.cpp process  │                      │
│  │  - Captures mic audio │                      │
│  │  - Runs Whisper model │                      │
│  │  - VAD for silence    │                      │
│  │  - Outputs text via   │                      │
│  │    localhost TCP :9876 │                      │
│  └──────────┬────────────┘                      │
│             │ TCP socket                        │
│  ┌──────────▼────────────┐    Bluetooth HID     │
│  │  Component 2: Android │ ──────────────────►  │
│  │  Kotlin App           │    Keyboard profile  │
│  │  - Reads from socket  │                      │
│  │  - Sends keystrokes   │         ┌──────────┐ │
│  │    via BT HID API     │ ──────► │ Laptop   │ │
│  │  - Toggle via notif   │         │ sees a   │ │
│  └───────────────────────┘         │ keyboard │ │
│                                    └──────────┘ │
└─────────────────────────────────────────────────┘
```

### Why two components

- **whisper.cpp in Termux**: Native ARM64 binary, easy model swaps (just replace the .ggml file), no Android SDK complexity for the ML part, battle-tested C++ implementation.
- **Kotlin app for BT HID**: The `BluetoothHidDevice` API requires an Android app context — it cannot be called from Termux. This is a thin app (~500 lines) whose only job is reading text from a socket and sending keystrokes.

### Communication

Localhost TCP socket on port 9876. The Termux side writes newline-delimited text segments. The Kotlin app reads lines and converts each to HID keystrokes.

Protocol:
```
# Termux writes lines to localhost:9876
Hello world\n
This is a test\n

# Special control messages (prefixed with 0x01)
\x01PAUSE\n      # Pause transcription
\x01RESUME\n     # Resume transcription
\x01BACKSPACE:5\n # Send 5 backspace keys
```

---

## Component 1: Whisper Engine (Termux)

### Dependencies

- **Termux** (from F-Droid, NOT Google Play — the Play Store version is outdated and broken)
- **Termux:API** (from F-Droid) — for microphone access via `termux-microphone-record`
- **Termux:Boot** (from F-Droid) — optional, for auto-start on boot
- **whisper.cpp**: https://github.com/ggml-org/whisper.cpp — clone and build natively in Termux
- **tmux** — for persistent sessions that survive screen-off

### Setup Script (`scripts/setup-termux.sh`)

This script should:
1. `pkg update -y && pkg upgrade -y`
2. Install build tools: `pkg install -y clang cmake make git tmux termux-api`
3. Clone whisper.cpp repo
4. Build whisper.cpp with CMake (ARM64 NEON flags enabled)
5. Download the default model: `ggml-base.en.bin` from Hugging Face (whisper.cpp model repo)
6. Create the `models/` directory and place the model there
7. Print success message with instructions

Build flags for whisper.cpp on ARM64 Android:
```bash
cmake -B build \
  -DCMAKE_C_FLAGS="-march=armv8.2-a+dotprod+fp16" \
  -DCMAKE_CXX_FLAGS="-march=armv8.2-a+dotprod+fp16" \
  -DWHISPER_NO_ACCELERATE=ON
cmake --build build --config Release -j$(nproc)
```

### Main Script (`scripts/start-stt.sh`)

This is the core loop. It should:

1. Start a TCP server listening on `localhost:9876` (use `socat` or a small C helper)
2. Record audio from the microphone in 16kHz WAV format using `termux-microphone-record`
3. Segment audio into chunks (configurable, default 5 seconds with 0.5s overlap)
4. Run each chunk through whisper.cpp `main` binary with flags:
   - `--model models/ggml-base.en.bin`
   - `--language en`
   - `--no-timestamps`
   - `--print-special false`
   - `--no-context` (avoid hallucinating from prior context)
5. Apply basic VAD: skip segments where whisper outputs only silence tokens like `[BLANK_AUDIO]`, `(silence)`, or empty strings
6. Write non-empty transcription results to the TCP socket as newline-delimited text
7. Handle graceful shutdown on SIGTERM/SIGINT

**Important audio details:**
- `termux-microphone-record` outputs to a file; use a FIFO or tmp file rotation approach
- Whisper expects 16kHz mono PCM/WAV — ensure format conversion if needed (`ffmpeg` or `sox` available in Termux)
- The S24 Ultra's Snapdragon 8 Gen 3 can run `base.en` comfortably faster than real-time; `distil-small.en` is also an option for better accuracy at similar speed

### Model Swap Script (`scripts/update-model.sh`)

Takes a model name as argument, downloads from Hugging Face, places in `models/`:
```bash
./scripts/update-model.sh distil-small.en
# Downloads ggml-distil-small.en.bin to models/
```

Supported models to document:
| Model | Size | Speed on S24 Ultra | Accuracy |
|-------|------|-------------------|----------|
| tiny.en | 75 MB | ~10x real-time | Basic |
| base.en | 142 MB | ~5x real-time | Good |
| small.en | 466 MB | ~2x real-time | Better |
| distil-small.en | ~350 MB | ~2-3x real-time | Better (optimized) |

### Stream Mode Alternative

whisper.cpp supports a `stream` binary for real-time streaming transcription. This may be preferable to the chunked approach above. If `stream` works well with Termux audio capture, prefer it:

```bash
./build/bin/stream \
  --model models/ggml-base.en.bin \
  --language en \
  --step 3000 \       # process every 3 seconds
  --length 8000 \     # 8-second audio window
  --keep 1000 \       # keep 1 second of context
  --vad-thold 0.6 \   # VAD threshold
  --no-timestamps
```

The stream binary reads from the default audio device. Getting this to work in Termux may require `pulseaudio` or piping audio in. Worth attempting first, fall back to the chunked approach if it doesn't cooperate.

---

## Component 2: Bluetooth HID App (Kotlin)

### Minimum SDK & Permissions

- **minSdk**: 28 (Android 9 — required for `BluetoothHidDevice` API)
- **targetSdk**: 34

**Permissions** (AndroidManifest.xml):
```xml
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
<uses-permission android:name="android.permission.INTERNET" />  <!-- localhost only -->
```

### BluetoothHidService.kt

A foreground service that:

1. **Registers as a Bluetooth HID device** using `BluetoothHidDevice` API:
   - Device type: Keyboard
   - HID descriptor: Standard USB HID keyboard descriptor (boot protocol compatible)
   - Subclass: `0x40` (keyboard)
   - The HID descriptor must define an 8-byte report: [modifier, reserved, key1, key2, key3, key4, key5, key6]

2. **Accepts connections** from the laptop via `BluetoothHidDevice.Callback`:
   - `onAppStatusChanged()` — registration success/failure
   - `onConnectionStateChanged()` — track connected host device
   - `onGetReport()` / `onSetReport()` — respond to host HID requests

3. **Sends keystrokes** via `BluetoothHidDevice.sendReport(device, reportId, report)`:
   - Convert each character to its USB HID keycode + modifier
   - Send key-down report, then key-up report (all zeros) for each character
   - Handle shift for uppercase and symbols
   - Support common special keys: Enter, Tab, Backspace, Space
   - Add a small delay between keystrokes (configurable, default 10ms) to prevent dropped keys

4. **Provides a persistent notification** with:
   - Connection status (disconnected / connected to [device name])
   - Toggle button: Start/Stop listening for transcription text
   - Current mode indicator

### Character-to-HID Mapping

Include a complete mapping from ASCII characters to USB HID keycodes. Key reference:
- `a-z`: keycodes 0x04–0x1D (no modifier)
- `A-Z`: keycodes 0x04–0x1D + Left Shift modifier (0x02)
- `1-9`: keycodes 0x1E–0x26
- `0`: keycode 0x27
- Space: 0x2C
- Enter: 0x28
- Tab: 0x2B
- Backspace: 0x2A
- Common punctuation: period (0x37), comma (0x36), slash (0x38), etc.
- Shifted symbols: `!@#$%^&*()` etc. with shift modifier

### SocketListenerService.kt

A service (or part of BluetoothHidService) that:

1. Connects to `localhost:9876` via TCP
2. Reads newline-delimited text
3. Parses control messages (0x01 prefix)
4. For text lines: queues them and sends to BluetoothHidService for keystroke output
5. Implements reconnection logic (Termux process may restart)
6. Buffers text if BT is temporarily disconnected

### MainActivity.kt

Minimal UI:
- **Connection status**: Shows paired device, connection state
- **Pairing button**: Opens Bluetooth settings or initiates discoverable mode
- **Start/Stop toggle**: Starts/stops the foreground services
- **Status log**: Scrolling text view showing recent transcriptions and events
- **Settings**:
  - Keystroke delay (ms)
  - Socket port (default 9876)
  - Auto-start on boot (registers with Termux:Boot)
  - Add newline after each transcription segment (on/off)
  - Add space between segments (on/off)

### Build Configuration

**build.gradle.kts (app)**:
- Kotlin 1.9+
- No external dependencies required — all APIs are in the Android SDK
- Build produces a single APK (no AAB, since we're sideloading)

**Signing**:
- Use a debug keystore for development
- The GitHub Actions workflow should build a debug APK (release signing can be added later)

---

## GitHub Actions Workflow

File: `.github/workflows/build-apk.yml`

Triggers on push to `main`. Steps:
1. Checkout code
2. Set up JDK 17
3. Set up Android SDK (API 34, build-tools)
4. Run `./gradlew assembleDebug`
5. Upload APK as artifact
6. Optionally create a GitHub Release with the APK attached (on tag push)

The user will download the APK from GitHub Actions artifacts on their phone and sideload it.

---

## Repository Structure

```
whisper-bt-keyboard/
├── SPEC.md                          # This file
├── README.md                        # User-facing setup guide
├── CLAUDE.md                        # Context file for Claude Code sessions
│
├── app/                             # Android Kotlin app (Component 2)
│   ├── build.gradle.kts
│   ├── src/
│   │   └── main/
│   │       ├── AndroidManifest.xml
│   │       ├── java/com/whisperbt/keyboard/
│   │       │   ├── MainActivity.kt
│   │       │   ├── BluetoothHidService.kt
│   │       │   ├── SocketListenerService.kt
│   │       │   ├── HidKeyMapper.kt          # Char → HID keycode mapping
│   │       │   └── BootReceiver.kt          # Auto-start on boot
│   │       └── res/
│   │           ├── layout/activity_main.xml
│   │           ├── values/strings.xml
│   │           └── drawable/ic_notification.xml
│   └── proguard-rules.pro
│
├── build.gradle.kts                 # Root build file
├── settings.gradle.kts
├── gradle.properties
├── gradle/
│   └── wrapper/
│       ├── gradle-wrapper.jar
│       └── gradle-wrapper.properties
│
├── scripts/                         # Termux scripts (Component 1)
│   ├── setup-termux.sh             # One-time Termux environment setup
│   ├── start-stt.sh                # Main STT loop
│   ├── stop-stt.sh                 # Graceful shutdown
│   └── update-model.sh            # Download/swap Whisper models
│
└── .github/
    └── workflows/
        └── build-apk.yml           # CI: build APK on push
```

---

## CLAUDE.md Content

The repo should include a `CLAUDE.md` file with this content for Claude Code context:

```markdown
# Whisper Bluetooth Keyboard

## What this is
Android app + Termux scripts that turn a Samsung phone into a speech-to-text
Bluetooth keyboard. Whisper runs locally on the phone, transcribed text is sent
to a paired laptop as Bluetooth HID keyboard input.

## Architecture
- Component 1 (Termux): whisper.cpp captures mic, transcribes, writes text to localhost:9876
- Component 2 (Kotlin app): Reads from socket, sends keystrokes via BluetoothHidDevice API
- Communication: TCP socket on localhost:9876, newline-delimited text

## Key technical decisions
- BluetoothHidDevice API (Android 9+) — no root needed
- whisper.cpp built natively in Termux (ARM64 NEON)
- Localhost TCP socket bridges Termux ↔ Android app
- Debug APK built via GitHub Actions, sideloaded

## Build
- Android app: `./gradlew assembleDebug` (output: app/build/outputs/apk/debug/)
- Termux scripts: Copy to phone, run setup-termux.sh once
- CI builds APK on push to main

## Coding conventions
- Kotlin for Android app, Bash for Termux scripts
- Minimal dependencies — prefer Android SDK built-ins
- No external libraries for the Kotlin app
- Shell scripts should be POSIX-compatible where possible but can use bash features

## Testing
- BluetoothHidService: Test by pairing with any Bluetooth-capable device, open a text editor, verify keystrokes arrive
- SocketListener: Test with `echo "hello world" | nc localhost 9876` from Termux
- Full pipeline: Run start-stt.sh in Termux, speak, verify text appears on paired device
```

---

## Development Phases

### Phase 1: Proof of Concept (Priority: HIGH)

**Goal**: Verify whisper.cpp runs in Termux and produces transcription from mic input.

Steps:
1. Install Termux + Termux:API from F-Droid
2. Run `setup-termux.sh`
3. Manually test: record 5 seconds of audio, transcribe with whisper.cpp
4. Verify output quality with `base.en` model

**Success criteria**: Spoken English sentence is accurately transcribed in under 3 seconds on S24 Ultra.

### Phase 2: Bluetooth HID App (Priority: HIGH)

**Goal**: Kotlin app that registers as BT keyboard and can send hardcoded text.

Steps:
1. Create Android project scaffold
2. Implement `BluetoothHidService` with HID keyboard descriptor
3. Test pairing with laptop
4. Send hardcoded "Hello World" as keystrokes
5. Verify text appears in any text field on the laptop

**Success criteria**: Phone pairs with laptop as "Whisper Keyboard", typing "Hello World" into Notepad/any text field.

### Phase 3: Socket Bridge (Priority: HIGH)

**Goal**: Connect the two components via localhost TCP.

Steps:
1. Add TCP server to `start-stt.sh` (via `socat` or ncat)
2. Implement `SocketListenerService` in the Kotlin app
3. Test: `echo "test" | nc localhost 9876` → appears as keystrokes on laptop
4. Wire up full pipeline: speak → Whisper → socket → BT HID → laptop

**Success criteria**: Spoken words appear as typed text on the laptop within 5 seconds.

### Phase 4: Polish (Priority: MEDIUM)

- Notification toggle (start/stop)
- Auto-reconnect on socket drop
- Keystroke delay tuning
- Add space or newline between transcription segments
- Termux:Boot auto-start
- Error handling and logging

### Phase 5: Optimization (Priority: LOW)

- Try `distil-small.en` model for better accuracy
- Experiment with whisper.cpp `stream` mode
- Tune VAD thresholds to avoid transcribing silence/noise
- Battery optimization (partial wake locks, audio focus management)
- Try Qualcomm AI Hub optimized Whisper if available for whisper.cpp

---

## Key Technical References

- **BluetoothHidDevice API**: https://developer.android.com/reference/android/bluetooth/BluetoothHidDevice
- **USB HID keyboard descriptor**: USB HID Usage Tables spec, section 10 (Keyboard/Keypad Page 0x07)
- **whisper.cpp**: https://github.com/ggml-org/whisper.cpp
- **whisper.cpp models**: https://huggingface.co/ggerganov/whisper.cpp/tree/main
- **Termux**: https://termux.dev
- **Termux:API**: https://wiki.termux.com/wiki/Termux:API

## Constraints

- **No software on laptop**: The laptop must see a standard Bluetooth keyboard. No custom drivers, no apps, no admin access.
- **On-device processing**: All transcription happens on the phone. No cloud APIs.
- **Sideloaded APK**: The app is not on the Play Store. It's built via GitHub Actions and sideloaded.
- **Samsung S24 Ultra**: Primary target device. Snapdragon 8 Gen 3 with Hexagon NPU. Android 14+.
- **Audio input**: USB headset via USB-C adapter, or Bluetooth multipoint headset with mic routed to phone.

## Modes of Operation

### STT Mode (Active)
- Headset mic → phone captures audio → Whisper transcribes → text sent as BT keystrokes to laptop
- Indicated by persistent notification
- Toggle on/off via notification button

### Bypass Mode (Inactive)
- STT is paused
- Headset can connect directly to laptop for Teams/Zoom calls
- Phone is still paired as BT keyboard but not sending keystrokes
- No audio processing happening

The app does NOT need to pass audio through. It only needs to release its mic claim so the headset can be used normally with the laptop.
