# Whisper Bluetooth Keyboard

## What this is
Android app + Termux scripts that turn a Samsung phone into a speech-to-text
Bluetooth keyboard. Whisper runs locally on the phone, transcribed text is sent
to a paired laptop as Bluetooth HID keyboard input.

## Architecture
- **Component 1 (Termux)**: whisper.cpp captures mic, transcribes, writes text to `localhost:9876`
- **Component 2 (Kotlin app)**: Reads from socket, sends keystrokes via `BluetoothHidDevice` API
- **Communication**: TCP socket on `localhost:9876`, newline-delimited text

```
Termux (whisper.cpp) ──TCP :9876──► Kotlin App ──BT HID──► Laptop keyboard
```

## Repository layout

```
app/                             Android Kotlin app (Component 2)
  src/main/java/com/whisperbt/keyboard/
    BluetoothHidService.kt       Foreground service; registers as BT keyboard, sends keystrokes
    SocketListenerService.kt     Reads localhost:9876, forwards text to BluetoothHidService
    HidKeyMapper.kt              ASCII → USB HID keycode lookup + HID descriptor
    MainActivity.kt              Minimal UI: status, start/stop, settings
    BootReceiver.kt              Auto-start on device boot
  src/main/res/
    layout/activity_main.xml     Single-screen UI
    values/strings.xml
    drawable/ic_notification.xml Mic icon for notification

scripts/                         Termux shell scripts (Component 1)
  setup-termux.sh                One-time install of tools, whisper.cpp build, model download
  start-stt.sh                   Main loop: record → transcribe → send to socket
  stop-stt.sh                    Kill the tmux session / processes
  update-model.sh                Download/swap Whisper GGML models

.github/workflows/build-apk.yml CI: assembleDebug on push to main, upload APK artifact
```

## Key technical decisions
- `BluetoothHidDevice` API (Android 9+, no root needed)
- whisper.cpp built natively in Termux (ARM64, `-march=armv8.2-a+dotprod+fp16`)
- Localhost TCP socket bridges Termux ↔ Android app
- Debug APK built via GitHub Actions, sideloaded — not on Play Store
- No external libraries for Kotlin app (pure Android SDK)

## Build

### Android APK
```bash
./gradlew assembleDebug
# Output: app/build/outputs/apk/debug/whisper-bt-keyboard-debug.apk
```
If `./gradlew` fails (missing wrapper jar), run once:
```bash
gradle wrapper --gradle-version 8.4
```

### Termux setup (run on phone in Termux)
```bash
bash scripts/setup-termux.sh            # builds whisper.cpp, downloads base.en model
bash scripts/start-stt.sh --tmux        # starts STT in persistent tmux session
bash scripts/stop-stt.sh                # stops it
bash scripts/update-model.sh small.en  # swap to a bigger model
```

### CI
GitHub Actions builds a debug APK on every push to `main`. Download from the
**Actions → Artifacts** tab, or install via a tagged release.

## Coding conventions
- Kotlin for the Android app, Bash for Termux scripts
- Minimal dependencies — Android SDK built-ins only for Kotlin
- Shell scripts use Termux shebang: `#!/data/data/com.termux/files/usr/bin/bash`
- POSIX-compatible Bash where practical; bash-specific features (arrays, `[[`) are fine

## Testing
- **BluetoothHidService**: Pair phone with any BT device (laptop, tablet), open a text
  editor, start services, use the notification toggle to enable STT — verify keystrokes arrive.
- **SocketListener**: From Termux: `echo "hello world" | nc 127.0.0.1 9876`
  Text should appear on the paired device.
- **Full pipeline**: `bash scripts/start-stt.sh`, speak, verify text appears on laptop.

## HID protocol quick reference
```
Report format (8 bytes):
  [0] modifier  (0x02 = Left Shift)
  [1] reserved  (0x00)
  [2] keycode   (e.g. 0x04 = 'a', 0x28 = Enter)
  [3..7] additional keys (0x00 for single key)

Key-down: send report with modifier+keycode
Key-up:   send all-zeros report
Inter-key delay: 10ms default (configurable)
```

## Socket protocol
```
Normal text:         "Hello world\n"      → typed as keystrokes
Pause:               "\x01PAUSE\n"
Resume:              "\x01RESUME\n"
Backspace N times:   "\x01BACKSPACE:5\n"
```

## Common issues
| Problem | Fix |
|---------|-----|
| `termux-microphone-record` fails | Grant mic permission in Termux:API; ensure Termux:API is from F-Droid |
| No BT HID option on phone | Ensure Bluetooth is on; `BluetoothHidDevice` requires Android 9+ |
| Keystrokes dropped | Increase keystroke delay in app settings (default 10ms) |
| Whisper outputs only `[BLANK_AUDIO]` | Speak louder; check mic routing; try smaller chunk size |
| App crashes on boot | Grant `RECEIVE_BOOT_COMPLETED`; enable auto-start in app settings first |
