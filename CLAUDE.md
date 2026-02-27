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
- Localhost TCP socket bridges Termux <-> Android app
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
