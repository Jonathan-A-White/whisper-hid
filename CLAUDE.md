# Whisper Bluetooth Keyboard

## What this is
Three-component system that turns a Samsung phone into a speech-to-text
Bluetooth keyboard. A PWA provides the UI, a Python+Flask server in Termux
handles mic capture and Whisper transcription, and a headless Kotlin service
sends keystrokes via Bluetooth HID.

## Architecture (SPEC-2)
- Component 1 (PWA): UI + orchestration, hosted on GitHub Pages, saved to homescreen
- Component 2 (Termux): Python+Flask Whisper HTTP server on localhost:9876, owns mic capture
- Component 3 (Kotlin app): Headless BT HID service with HTTP API on localhost:9877
- Communication: HTTP REST APIs between all three components

## Key technical decisions
- BluetoothHidDevice API (Android 9+) — no root needed
- whisper.cpp built natively in Termux (ARM64 NEON)
- HTTP APIs replace the old TCP socket protocol
- PWA hosted on GitHub Pages — UI updates without APK reinstall
- Mic capture stays in Termux (browser can't reliably access BT headset mic)
- Auth token generated per service session, passed via URL from Kotlin app to PWA

## Bluetooth HID typing: post-connect settle delay
A BT HID **host** (the laptop/PC receiving keystrokes) silently drops input
reports for a short window right after the link reaches `STATE_CONNECTED` — it
is still re-enumerating and setting up its input pipe. `hid.sendReport()`
returns success at the link layer during this window, so the leading keystrokes
*look* sent but never reach the host, and the message arrives truncated at the
front (e.g. only "...what has been taught" of a longer sentence). Re-sending the
same text seconds later works because the link is warm.

The same thing happens on a link that stayed CONNECTED but sat **idle**: hosts
power down the HID input path a few seconds after the last report (BT
sniff/sub-rating, selective suspend, macOS/Windows keyboard sleep), and the
first reports in only wake it — they're consumed, not typed. At 2 reports/char
and 10ms delay a ~1s wake-up eats the first 25–50 characters, and the gap
between one dictation and the next is always long enough to trigger it. This
was the residual front-truncation seen after the settle delay alone shipped.

`BluetoothHidService` guards against both with one mechanism: `linkWarmup()`
(pure, unit-tested in `LinkWarmupTest`) decides how long to warm the link —
the remainder of `CONNECT_SETTLE_MS` (1.5s) after `connectedAtMs`, or
`IDLE_WAKE_MS` (1s) when `lastReportAtMs` is older than `IDLE_WAKE_AFTER_MS`
(5s), or `LONG_IDLE_WAKE_MS` (2.5s) past `LONG_IDLE_AFTER_MS` (60s) and when
`lastReportAtMs` is unset — and `waitForLinkReady()` spends that window pumping
all-keys-up reports every 100ms (a no-op when delivered, so losing them costs
nothing, but they wake the host and keep it awake). It runs inside the
single-threaded keystroke executor, so it never blocks the HTTP handler (which
already returned 200), honours `/stop` mid-wait, and is a no-op for warm-link
sends — a queue of back-to-back sends pays it once. **Don't remove or shorten
these waits** to shave latency; without them the first dictation after any
reconnect or pause loses its opening words. Look for "Warming up HID link for
Nms before typing (reason)" in HID `/logs` — it names which case fired.

How deep the host's sleep is scales with how long it was left alone, so the
wake does too. A 10s gap between dictations is a doze; a link untouched for a
minute or more (the user went off to copy something) is in full selective
suspend, and 1s of pulses was not enough for it — a large clipboard paste
after exactly that pause arrived with its first ~250 characters mangled
(dropped letters in bursts, Shifts that never landed), then clean once the
host had properly woken.

## Bluetooth HID typing: throughput and reliability for large text
`HidKeyMapper.buildReports()` emits an explicit key-down + release pair per
character (2 reports/char). A merged stream (key-up folded into the next
key-down, ~1 report/char, like a fast typist overlapping keys) was tried to
double throughput and **REVERTED after field testing**: on a real host it
produced bursts of dropped characters and dropped Shifts ("i'd") on every
send, at every keystroke delay tried (0–20ms) — while the pair stream at the
same report rate has always been clean on the same host. The stack/host path
silently loses occasional reports (`sendReport()` still returns true, same
class of problem as the post-connect settle window above), and a merged
stream has zero redundancy: every lost report corrupts text. The pair stream
degrades gracefully — a lost release is healed by the next key-down
(implicit release), so one lost report costs at most one character. Don't
re-merge key-ups to shave latency.

**What limits typing speed is the RECEIVING APPLICATION, not the link.**
Above some rate the app stops keeping up and characters go missing. This is
invisible from the phone — `sendReport()` returns true and the send log
says "0 slow sends", because nothing is congested on *this* side; the
reports leave and the app never processes them. Same laptop, same Bluetooth
link, same 500-character paste, three runs:

| app | delay | rate | result |
|-----|-------|------|--------|
| vim (paste mode) | 10ms | 91.8 reports/s | byte-identical to the source (972 chars verified) |
| vim (paste mode) | 5ms | 174 reports/s | byte-identical (1160 chars verified) |
| vim (paste mode) | 3ms | 268 reports/s | byte-identical (1293 chars verified) |
| vim (paste mode) | 2ms | 376 reports/s | **FAILS** — a 54-char block gone at offset 697 |
| vim (paste mode) | 1ms | ~650 reports/s | catastrophic — see below |
| Notepad | 40ms | 24.0 reports/s | byte-identical (693 chars verified) |
| Notepad | 20ms | 47.7 reports/s | perfect for 196 characters, then ~7% of the rest corrupted |

**The two failures have different shapes, and the shape tells you which
one you are looking at.** Just over an app's limit (Notepad at 47.7/s) you
lose scattered single characters and the odd short run — 1 to 14 characters
at a time. Far over it (vim at ~650/s) whole *phrases* vanish in contiguous
blocks: three sampled gaps were 94, 73 and 85 characters, e.g.
`**Read this first.** The other three skills (...) all read and write`
arriving as `**Read thiall read and write`. That is an input queue
overflowing and discarding a batch, not occasional report loss. So don't
chase `keystrokeDelayMs` toward 0 for speed: `sendReport()` itself costs
only ~0.6ms, so delay 0 would push ~1600 reports/s and shred the text.

A terminal absorbs nearly **4x** the rate that corrupts Windows 11 Notepad,
which spell-checks and re-formats on every keystroke. So don't tune this
against one app and call it the link's ceiling — an earlier pass through
this investigation concluded "the host drops above ~25 reports/s" and
defaulted the delay to 40ms, which was Notepad's limit mistaken for the
system's. Two other readings were wrong along the way and are recorded here
so they aren't re-derived: damage that starts part-way into a paste is the
app's input handling falling behind, **not** the host still waking up (that
is the separate `linkWarmup()` problem, and it shows up at the *front*), and
it is not a Bluetooth sniff interval either.

So `keystrokeDelayMs` defaults to 10ms (`DEFAULT_SETTINGS.keystrokeDelay`
matches), which suits the targets this project is for — Claude Code and
Codex in a terminal. **Raising the default to be safe for a heavyweight
editor would cost every terminal user 4x their typing speed for nothing.**
That is what the slider is for; the Settings hint names the measurements.
At ~2.1 reports/char, 10ms is ~44 characters/s and 40ms is ~11.

**The terminal's ceiling is bracketed to 268-376 reports/s**, found by
bisecting: 3ms (268/s) clean over 1293 characters, 2ms (376/s) failed
within 700. **5ms (174/s) is the recommended fast setting** — it is 2.2x
below the nearest failing rate and still doubles the default's throughput
(83 characters/s). 3ms is probably genuinely under the threshold (its clean
run lasted ~2700 reports, well past the ~1470 at which 2ms broke) but sits
only 29% below a rate that silently eats 54 characters, which is not much
margin for a busier machine or a different app.

10ms stays the default because a default protects whoever never touches
the slider: 4x margin, and this failure is silent and destructive. Nothing
in the log distinguishes a good send from one that dropped half a sentence.

Three things learned the hard way while measuring this:

- **Block size scales with how far over you are.** 376 reports/s lost one
  54-character block; ~650/s lost blocks of 73-94. Near the threshold the
  loss is small and contiguous, so it hides inside a long paste.
- **Faster settings buy less wall-clock time per character.** The 3ms run
  is 1293 characters but only 7.7 seconds — *shorter* than the 5ms run's
  13.3s. Bisecting downward on a fixed-length paste makes each test weaker
  than the last. Paste more, not the same.
- **Diff, don't eyeball.** Every "clean" result above was compared
  character-by-character against the source. The 2ms failure is one missing
  clause in the middle of a paragraph — it reads as perfectly fluent text
  and no reader would catch it.

**A modifier gets a report of its own before the key it modifies.** Shift
going down in the same report as the key it shifts is a coin flip: the host
decides in what order to turn one report into input events, and one that
presses the key before applying the new modifier byte types the *unshifted*
character. A field paste came out as `"To Read—Or Not to Read the Code?"` →
`'to readOr notead THE Code?"` — capitals arriving lowercase, `<` as `,`
(Shift+comma losing its Shift), `## Role` as `## role`. So a shifted character
is three reports (modifier alone, modifier+keycode, all-up); unshifted
characters stay at two and are byte-identical to what shipped before. If the
host ignores the modifier-only report it just sees modifier+keycode together,
i.e. the old behaviour — so this is never worse, only sometimes better.

**Modifier state NEVER carries across a character.** The release after every
character goes all the way to zero, even mid-run of capitals. Holding Shift
across a run — what a human does, and 2.1 reports/char instead of ~2.5 — was
tried and **REVERTED after field testing**. It makes the Shift a piece of
state living in the *stream*, and this link loses reports, so one lost
modifier report poisons everything up to the next case change instead of one
character. A paste came back as `(SHARED DATA CONTRACT) ## ATTRIBUTION THIS
SUITE DERIVES FROM **KIERAN KLAASSEN<` — ~100 characters capitalised off one
lost report, the trailing `,` typed as `<` — and elsewhere `(<https://` as
`9,https;//` and `2026**` as `202688` (a lost shift-*down*, every shifted
character in the run wrong). Dumping the stream shows why: the held-Shift
version emits `mod=02 key=00` immediately followed by `mod=00 key=00`, two
consecutive keycode-free reports, and that second one is the *only* thing
clearing Shift for the next hundred characters. This is the same trap the
merged stream fell into above, reached from the other side: **state has no
redundancy on a lossy link.** Resetting per character caps the blast radius of
any single lost report at one character. Don't hold modifiers across
characters to shave reports.

Note the asymmetry when tuning: a change that adds reports costs throughput,
but a change that adds *state* costs correctness non-linearly. Prefer more
reports over fewer, self-contained over stateful.

**Characters a US keyboard has no key for get an ASCII stand-in, not the
floor.** `HidKeyMapper.asciiFallback()` maps em/en dashes, curly quotes,
ellipses, exotic spaces, arrows and accented Latin letters to typeable ASCII
(`—` → `--`, `…` → `...`, `café` → `cafe`); expansion runs before `map()`, so
`map()` still answers only for single keystrokes. They used to be dropped
silently mid-word — "a program — most of it" arrived as "a program  most of
it" — and they are not rare: the cleanup LLM emits typographic punctuation as
a matter of course. Every fallback must itself expand to mapped characters
(there is a test for that). Genuinely un-transliterable input (CJK, emoji)
still types nothing.

**Keystrokes run at raised thread priority** (`hid-keystrokes`,
`THREAD_PRIORITY_URGENT_DISPLAY`). Between a key-down and its release the host
has that key held, and a thread descheduled past the host's typematic delay
(~0.5s) gets auto-repeat: a field send typed "so it is written" as
"sssssssssssso it is written". The phone is also running Parakeet and a
llama-server, so default priority is not safe here.

`keystrokeDelayMs` is the pause after each report (skipped entirely at 0),
default 10ms — see the per-application ceiling above. The PWA's Keystroke delay
setting is sent as `delay_ms` in each `/type` request body and sticks until
the next override; `/status` reports it as `keystroke_delay_ms`, and the
server caps it at 100ms. At 0 delay the stack can *also* refuse to queue a
report under congestion — `sendReportReliably()` retries with a short
backoff — but that is a different failure from the host-side drops, and the
log line tells them apart.

Every send logs "Typed N chars as M reports in Tms (delay=Dms, K slow
sends)" to `/logs`. Reading it: `M/N` should be ~2.1 (more if the text is
shift-heavy); `T/M` is the achieved per-report interval and should be about
`delay_ms + 1`, since `sendReport()` itself costs ~1ms. **`K` non-zero means
the phone's stack is congested; `K` zero with corrupted text means the
receiving app is dropping and the delay is too low for that app.** So far
only the latter has been seen in the field.

**Stuck-key hazard**: if the *final* release of a send is lost (a dropped
report, an abort mid-stream), there is no later key-down to heal it and the
host's typematic auto-repeat types that key forever — the classic symptom
is endless trailing spaces (the appended " " is the last key of every
dictation). Three guards, all load-bearing:
1. If a report can't be sent after retries, the rest of the text is
   ABORTED (never skip-and-continue — a skipped release = stuck key).
2. Every send task releases all keys in a `finally` (`releaseAllKeys()`,
   larger retry budget) no matter how it exits.
3. `POST /stop` (auth) is the kill switch: bumps `typeGeneration` so the
   running send and everything queued behind it bail, then forces a
   release. The PWA "⏹ Stop typing" button on the Talk screen calls it and
   also aborts the client-side 500-char chunk loop in `hidType()` (later
   chunks are separate `/type` requests the service hasn't seen yet).
   `/status` exposes `"typing": bool` (any send running or queued).

Field note: hosts do NOT reliably release held keys when the BT device
disconnects — an observed runaway kept typing spaces after Bluetooth was
turned off and only stopped on reboot (tapping the stuck key on the host's
physical keyboard also clears it). So the release must be *delivered over
the live link* — that's why `/stop` matters and why a BT disconnect bumps
`typeGeneration` (can't release over a dead link; and queued sends must not
blast stale text at whatever has focus after reconnect).

## Target app mode (Claude Code / Codex / plain text)

Dictation lands in one of a few very different places, and the difference is
not cosmetic: **a `\n` typed as Enter submits in a CLI composer**, so a
multi-line send (a `prompt`-style cleanup with bullets, a pasted clipboard)
arrives as several half-finished prompts. Each target has its own
newline-without-submit key, so the target has to be known before typing:

| target   | line break typed as | why |
|----------|--------------------|-----|
| `plain`  | real Enter (and the PWA flattens pasted line breaks) | normal text fields have no soft newline |
| `claude` | `\` then Enter | Claude Code's documented escape |
| `codex`  | **Ctrl+J** | Codex CLI's newline binding. It also binds Shift+Enter, but most terminals can't distinguish it from Enter and submit instead — Ctrl+J is the terminal-independent one. Claude Code's `\` escape in Codex types a literal backslash *and* submits, which is the bug this replaced |

- **One mechanism, all sends**: the PWA passes `newline_mode`
  (`enter`/`ctrl_j`/`backslash_enter`) in every `/type` body;
  `HidKeyMapper.buildReports()` expands a `\n` into that target's keystrokes
  (still key-down + all-up pairs — a soft newline is 1-2 pairs, never a
  merged stream). It applies to dictation, cleanup output, the edit buffer,
  pinned items and the clipboard alike — not just the clipboard, since the
  `prompt` cleanup style emits bullet lines. Omitted/unknown = plain Enter,
  so an older PWA against a new APK behaves exactly as before.
- **The final Enter stays hard**: "Newline after end of recording" is a
  deliberate submit, so `sendNewline()` always sends `newline_mode: "enter"`.
- **…and it waits 250ms first, or it isn't a submit at all.** A CLI composer
  groups keystrokes arriving in a burst into a *paste* and reads an Enter
  close behind them as part of it — a newline, not a submit. Codex CLI is
  explicit about it (`paste_burst.rs`: 3 chars at ≤8ms intervals starts a
  burst, `PASTE_ENTER_SUPPRESS_WINDOW` = 120ms after it ends), and dictation
  types at a few ms per character, so the Enter always landed inside that
  window: line breaks looked right and the prompt just sat there unsent.
  Claude Code's TUI submits on an Enter after a paste regardless, which is why
  only Codex showed it. `sendNewline()` therefore sends `pre_delay_ms`
  (`SUBMIT_SETTLE_MS`, 250ms) and `BluetoothHidService.sendString()` sleeps it
  inside the keystroke executor before the first report — *after* the queued
  text has finished typing, which is the only place the gap can be measured
  (`/type` returns 200 as soon as the send is queued). It is a quiet pause: no
  reports at all, because reports are what keep the burst alive. `/stop` still
  cuts it short, an older APK ignores the field, and the wait is unconditional
  — 250ms is imperceptible at the end of a dictation, and guessing which
  composers do burst detection is not worth the correctness risk.
- **Stored server-side** (`PUT /target`, persisted in
  `scripts/target-settings.json`, gitignored) rather than in PWA settings —
  the server needs the same value, and one copy can't drift. `GET /target`
  returns the active target plus the catalog (unauthenticated);
  `/status` adds `"target"` and `"target_newline_mode"`. Env `TARGET_MODE`
  sets the startup default (`plain`).
- **The mode is not just newlines** — it also:
  - names the assistant in the `prompt` cleanup style. That style's `system`
    and `label` carry `{assistant}`/`{short}` placeholders resolved per
    target (`_resolve_target_text()`), so Codex mode stops the LLM writing
    prompts addressed to Claude Code. Any new style that names an assistant
    must use the placeholders, not a hardcoded name.
  - leads the cleanup glossary with that assistant's vocabulary
    (`TARGET_PROFILES[...]["terms"]`), which is where a context-dependent
    mishearing like "codecs" → "Codex" gets fixed.
  - layers a few built-in whole-word corrections under the user's dictionary
    (`_effective_corrections()`): only unambiguous multi-word forms
    ("cloud code" → "Claude Code", "code x" → "Codex"). Deliberately not
    bare words — "codecs" can be genuine, so that call is the glossary's.
    A user entry for the same phrase wins and drops the built-in.
- **PWA**: `TargetModeToggle` pill on the Talk screen ("⌨️ Typing to X",
  tap to cycle) backed by `useTargetMode`; Settings shows the active target
  and points at the pill. A phone that had the old "Claude Code newlines
  (clipboard)" checkbox on is migrated once to target `claude`.
- Tests: `pytest scripts/tests/test_target.py`, `./gradlew test`
  (`HidKeyMapperTest` newline-mode cases)

## Bluetooth headset mic
Termux records from Android's *default* input, so using a Bluetooth headset's
mic requires system-wide SCO routing, handled by the Kotlin HID service
(`BluetoothHidService`, "Headset mic (SCO) routing" section):
- Uses the deprecated `startBluetoothSco()`/`setBluetoothScoOn()` APIs
  **deliberately** — `setCommunicationDevice()` (the Android 12+ replacement)
  only routes the calling app's own audio, and the recording happens in a
  different app (Termux). Don't "modernize" this without testing cross-app.
- An `AudioDeviceCallback` watches for BT SCO input devices, so routing
  engages/disengages automatically as headsets connect/disconnect.
- SCO startup is retried (it commonly fails right after profile connect);
  `setBluetoothScoOn(true)` is applied once `ACTION_SCO_AUDIO_STATE_UPDATED`
  reports connected.
- State exposed in HID `/status` as `"headset_mic": {available, active, device}`;
  the PWA StatusBar shows a 🎧 dot (green = headset mic in use).
- While SCO is active, phone audio plays through the headset at call quality
  (16 kHz mono) — acceptable for a dedicated dictation device.
- Some devices (observed on Samsung/OneUI) silently tear down the SCO link
  every ~15-30s. Two mechanisms combat this:
  1. Holds `AUDIOFOCUS_GAIN` (voice communication usage) while the headset
     mic is wanted.
  2. **The decisive fix**: plays a continuous inaudible silence stream
     (`startScoKeepAlive()`, an `AudioTrack` with `USAGE_VOICE_COMMUNICATION`)
     over the SCO channel. Audio focus alone was NOT enough — the audio HAL
     reaps the link when no *active stream in this app* uses it, and Termux's
     mic reads are in a separate process the policy can't attribute to the
     link. The silent output stream keeps the link "in use"; since SCO is one
     bidirectional connection, keeping the output warm keeps the mic path up.
     It's output-only, so it doesn't contend with Termux's mic capture.
  If periodic SCO drops reappear (🎧 dot flashing yellow/green, audio blip on
  the headset), check `/logs` for "SCO keep-alive stream started" (should
  appear once per headset connect) and "Audio focus request denied" entries.

### Mic audio source (when SCO routing isn't enough)
System-wide SCO routing assumes Android honours it for `AudioSource.MIC`,
which is what `termux-microphone-record` always records from. On devices
where it doesn't, the HID service reports the headset mic active (🎧 green)
while Termux still captures the built-in mic — the giveaway is a `wideband`
verdict in the mic test while wearing a headset.

`runtime_settings["mic_audio_source"]` picks the Android `AudioSource`
explicitly: `mic` (default, unchanged behaviour), `voice_communication`
(pins capture to the call-audio/SCO path), `voice_recognition`, `camcorder`.
- The wrapper script has no flag for it, so a non-default source is recorded
  by calling the `termux-api` binary the wrapper itself calls
  (`$PREFIX/libexec/termux-api MicRecorder`), which reads a `source` int
  extra. Two arguments differ from the wrapper's and are load-bearing:
  **`-a record`** (the intent action — without it `MicRecorderService`
  dispatches to its unknown-command handler and nothing records) and
  **`limit` in milliseconds** (the wrapper multiplies its `-l` seconds by
  1000; the service clamps a positive limit under 1000ms up). Bitrate is bps
  here, so AMR-WB takes `23850` directly rather than the wrapper's `-b 23850`
  (which becomes 23,850,000).
- Stopping is unchanged (`termux-microphone-record -q`) — it reaches the same
  service either way.
- Default `mic` keeps the exact field-tested wrapper command; only a
  deliberate switch changes the recording path. Missing binary ⇒ the wrapper
  is used anyway (never a failed recording), `PUT /settings` returns 409, and
  `/status` reports `"mic_audio_source_selectable": false` so the PWA hides
  the control.
- Env `MIC_AUDIO_SOURCE` sets the startup default; `/settings` (PWA Settings
  > Mic audio source) flips it at runtime; `/debug/test-pipeline` echoes the
  active source next to `rec_cmd` so a mic test says which one it used.
- Tests: `pytest scripts/tests/test_mic_source.py`

### Zoom mode (release headset mic to another device)
A headset has a single call-audio (SCO) channel. Because the HID service
holds it continuously (keep-alive stream + auto-retry), a laptop sharing the
same multipoint headset can never open its own channel — Zoom on the laptop
gets no headset mic. "Zoom mode" releases the link without stopping anything:
- `PUT /headset-mic {"enabled": false}` (auth required) calls `disableSco()`
  and suppresses the auto-re-enable paths (the `headsetMicEnabled` flag
  guards `enableSco()`); `enabled: true` reclaims the link. `GET /headset-mic`
  returns the state unauthenticated; `/status` `headset_mic` includes
  `"enabled"`.
- The flag persists in SharedPreferences so a service restart mid-call
  doesn't snatch the headset back from the laptop.
- While released, BT HID typing still works and dictation falls back to the
  phone's built-in mic.
- PWA: `ZoomModeToggle` pill on the Talk screen (`hid.setHeadsetMic` in
  `useHidService`); the StatusBar 🎧 dot turns gray while released.

## Build
- Android app: `./gradlew assembleDebug` (output: app/build/outputs/apk/debug/)
- Debug APKs are signed with the checked-in `app/debug.keystore` (standard
  android/androiddebugkey credentials) so CI and local builds all share one
  signature and updates install over the previous APK. Don't delete or
  regenerate it — that forces users to uninstall/reinstall.
- PWA: `cd pwa && npm install && npm run build` (output: pwa/dist/)
- Termux scripts: Copy to phone, run setup-termux.sh once
- CI builds APK on push to main, deploys PWA to GitHub Pages on push to main

## Coding conventions
- Kotlin for Android app, Bash for Termux scripts, Python for Whisper server
- TypeScript + React + Tailwind for PWA
- Minimal dependencies — prefer Android SDK built-ins for Kotlin
- No external Kotlin libraries (uses com.sun.net.httpserver for HTTP)
- Shell scripts should be POSIX-compatible where possible but can use bash features

## Testing
- Kotlin: `./gradlew test` — JUnit tests for HidKeyMapper and state machine
- Python: `pytest scripts/tests/` — Whisper server API tests
- PWA: Playwright E2E tests (future)
- Full pipeline: Start Whisper server in Termux, open PWA, speak, verify text on laptop

## Whisper server debugging

The Whisper server (scripts/whisper-server.py) wraps whisper.cpp via subprocess.
Most "no speech detected" bugs are NOT mic problems — check the full pipeline:

### Diagnostic endpoints
- `GET /logs` — circular buffer of recent events with timestamps
- `POST /debug/test-pipeline` — records 3s of audio and returns diagnostics
  for every pipeline stage (recording, transcode, audio energy, whisper output).
  Includes `mic_bandwidth` (`estimate_bandwidth()`, pure-Python FFT — no numpy
  dependency): verdict `narrowband` means the audio has no content above
  ~4 kHz. With a Bluetooth headset mic that's the SCO link on CVSD instead of
  mSBC — a major transcription quality hit no server-side processing can
  recover (try re-pairing / headset firmware update). The Setup Wizard mic
  test surfaces this verdict.

### Pipeline stages (each can fail independently)
1. **Mic capture**: `termux-microphone-record` → raw AAC/AMR file
   - Check: file size > 100B in logs ("Recording finished: ... size=NB")
   - Failure mode: 0-byte file = Termux:API not installed or mic permission denied
2. **Transcode**: `ffmpeg` converts to 16kHz mono WAV
   - Check: WAV size should be ~(duration × 32000) bytes
   - Failure mode: small WAV (<1000B) = corrupt input or wrong codec
3. **Whisper inference**: whisper-cli processes WAV → text
   - Check: processing time should be proportional to audio length (seconds, not milliseconds)
   - Failure mode: **if whisper finishes in <100ms for multi-second audio, it didn't
     process the file** — it printed help text and exited. This means a CLI flag is wrong.

### whisper.cpp CLI flag compatibility
**Critical**: whisper.cpp CLI flags change between versions. The server uses dynamic
flag detection — probing `whisper-cli --help` output before building the command.
When adding new whisper flags:
- Boolean flags (--no-timestamps, --no-gpu) take NO argument — never pass "true"/"false"
- Always check `--help` output before assuming a flag exists
- See `_detect_whisper_flags()` in whisper-server.py

### Parakeet engine
The server supports a second transcription engine: NVIDIA Parakeet TDT 0.6B v2
(int8), run in-process. It is both faster (~10x real-time on phone-class CPUs
vs ~2x for whisper base.en) and more accurate (WER comparable to whisper
large-v3). When the model directory and a backend are present, the server
prefers Parakeet automatically at startup.

Two interchangeable backends (tried in this order by `load_parakeet()`):
1. **sherpa-onnx** Python package — C++ decode loop, used where pip wheels
   exist (laptops/CI). NOT pip-installable in Termux: pip tries to compile
   numpy/ninja against Android's libc and fails (missing `spawn.h` etc.).
2. **parakeet_onnx.py** (bundled, `scripts/parakeet_onnx.py`) — pure
   numpy + onnxruntime port of the upstream reference implementation
   (fbank features + TDT greedy decode). On Termux install prebuilt
   binaries with `pkg install python-numpy python-onnxruntime` — never pip.
   Verified to produce byte-identical transcripts to the upstream
   sherpa-onnx reference script on real audio.

- **Engine selection**: `STT_ENGINE` env var — `auto` (default, prefers
  parakeet), `whisper` (force whisper.cpp), `parakeet`
- **Model files**: `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/`
  (encoder/decoder/joiner .int8.onnx + tokens.txt, ~630 MB on disk)
- **Install**: `./update-model.sh parakeet` downloads the model;
  setup-termux.sh installs backend + model automatically (non-fatally)
- **Switching**: `PUT /model {"model": "parakeet-tdt-0.6b-v2"}` — also listed
  in `GET /models` and the PWA model dropdown like any whisper model
- **Status**: `GET /status` includes `"engine": "parakeet" | "whisper"` and
  `"engine_backend"` ("sherpa-onnx", "onnxruntime", or "whisper.cpp")
- **Fallback**: any Parakeet failure falls back to whisper.cpp per-request;
  switching engines frees the inactive engine's RAM (parakeet ~700 MB loaded)
- **Threads**: `PARAKEET_THREADS` env var (default 4)
- **fbank gotchas** (parakeet_onnx.py must match kaldi-native-fbank exactly):
  hann window is PERIODIC (2π/N, not 2π/(N-1)); std normalization is
  UNBIASED (ddof=1, matching torch.std); librosa/Slaney mel scale
- Tests: `pytest scripts/tests/test_parakeet.py` (fake sherpa_onnx /
  parakeet_onnx modules injected into sys.modules — no model download
  needed; fbank golden values verified against kaldi-native-fbank)

### Chunked (streaming) transcription
Long dictations normally pay the whole transcription cost as one wait after
tapping Stop. When the recording file is decodable *while still being written*,
the server instead transcribes silence-delimited chunks in the background
during the recording, so Stop only costs the final uncommitted tail (~1s
instead of ~duration/10 with Parakeet).

- **Format matters**: ADTS AAC, raw AMR-WB, and Ogg Opus decode mid-write;
  MP4-family containers do not (moov atom is written at stop). Some devices
  (observed on Samsung) wrap BOTH aac and amr_wb in MP4 containers. This is
  probed at startup (`detect_chunked_support()`): if the detected format
  fails the probe, the server tries AMR-WB, then Opus (`-e opus` → Ogg
  container, streamable pages), and switches recording to whichever passes.
- **How it works**: `ChunkedSession` snapshots the growing file every 2s
  (copy first — ffmpeg racing the encoder is unreliable), decodes it, finds
  silence boundaries via per-frame levels (`find_commit_boundary()`, adaptive
  threshold), and transcribes new complete chunks. Only pauses ≥1.2s split
  (`CHUNK_SILENCE_SEC`): each chunk is transcribed as an independent
  utterance the engine sentence-cases and punctuates, so splitting at short
  mid-sentence thinking pauses litters the joined text with spurious
  capitals/periods ("I wonder how quickly It'll take"). Don't lower this to
  commit chunks sooner without weighing that cost. Silent-only spans (thinking
  pauses) advance the committed pointer without an engine call. A chunk only
  counts as speech if above-threshold frames accumulate to ≥0.25s
  (`CHUNK_MIN_SPEECH_SEC`, not necessarily consecutive) OR any frame is ≥3×
  threshold (`CHUNK_LOUD_FACTOR` — keeps short sharp words) — a lone
  breath/noise blip no longer triggers a ~200ms engine call that returns
  empty text. A skipped chunk is never transcribed later, so when tuning,
  err toward "speech": a false positive costs one brief engine call, a
  false negative loses words.
- **Post-processing runs ONCE on the joined text** at stop — chunks are
  transcribed raw (`run_transcription(..., postprocess=False)`) so word
  corrections and symbol phrases spanning a chunk boundary still match.
  Don't "fix" this by post-processing per chunk.
- **Failure = fallback, never breakage**: any poller error, a probe failure,
  or an unjoinable thread degrades to the plain stop-time transcription of
  the full file. The committed prefix is still used when valid.
- **Config**: `STT_CHUNKED` env var — `auto` (default) or `off`.
- **Status**: `GET /status` includes `"chunked": bool`; `/transcribe/stop`
  responses include `"chunked": true` and `"chunks": N` when it was used.
  Look for "Chunked: committed X-Ys" lines in `/logs`.
- Tests: `pytest scripts/tests/test_chunked.py` (boundary detection on
  synthetic levels, WAV slicing, poller with mocked decode/engine, join+
  postprocess assembly).

### Persistent whisper-server mode
The server can use a long-running `whisper-server` process (from whisper.cpp) that
loads the model once and serves inference requests via HTTP on port 9878. This
eliminates the ~1-3s model load overhead on every transcription.

- **Binary**: built with `-DWHISPER_BUILD_SERVER=ON` in setup-termux.sh
- **Startup**: launched automatically if the binary exists; falls back to
  subprocess mode (whisper-cli per request) if not
- **Model switching**: `PUT /model` restarts the whisper-server with the new model
- **Status**: `GET /status` includes `"whisper_server_mode": true/false`
- **Benchmarks**: still use one-shot subprocess mode (tests multiple models)
- **Config**: `WHISPER_SERVER_PORT` env var (default 9878)

### Common "no speech" causes (ranked by likelihood)
1. Wrong whisper CLI flags → whisper prints help and exits instantly (check timing)
2. Audio file not flushed → add sleep after `termux-microphone-record -q` (currently 2s)
3. AAC codec mismatch → server auto-detects AAC vs AMR-WB at startup
4. Actual silence → check audio_analysis step in /debug/test-pipeline (max_amplitude < 100)

## New-phone setup flow

Two pieces make setup on a fresh phone (with Termux installed) nearly automatic:

- `scripts/bootstrap.sh` — run via `curl ... | bash` inside Termux. Clones the
  repo, runs setup-termux.sh, downloads the latest APK from the rolling
  `latest-apk` GitHub Release (updated by CI on every push to main, see
  build-apk.yml) and opens the Android installer, then starts the Whisper
  server. Idempotent. Commands that might read stdin use `< /dev/null` so they
  don't swallow the piped script.
- `scripts/update-apk.sh` — the APK half of bootstrap.sh on its own, for an
  already-set-up phone: downloads the `latest-apk` release and opens the
  installer. bootstrap.sh calls it rather than duplicating the logic. It
  stays in the repo checkout (`~/whisper-hid/scripts/`) rather than being
  copied to `$INSTALL_DIR` like the server scripts, since it updates the
  app, not the server.
- `scripts/update-all.sh` — the routine "I merged things, update my phone"
  path: `git pull`, restart the Whisper server (which re-copies the server
  scripts), then `update-apk.sh`. Prints each component's `/status` version
  at the end. `--no-pull/--no-server/--no-apk/--no-clean/--no-open` narrow it.

### Getting an APK onto the phone is fiddly — three things bite
1. **`allow-external-apps`**: `termux-open` hands the file to Android's
   package installer through `TermuxContentProvider`, which refuses to serve
   other apps unless `allow-external-apps = true` is in
   `~/.termux/termux.properties` (then `termux-reload-settings`). Without it
   you get a red "TermuxContentProvider requires ..." dialog and no
   installer. `update-apk.sh` sets it idempotently.
2. **The share can bounce back into Termux**: if an app chooser appears and
   Termux is picked, you get "The following file does not exist:
   $HOME/bin/termux-file-editor" — that's Termux receiving its own share.
   So `update-apk.sh` stages a copy in `~/storage/downloads` (Android's
   `/sdcard/Download`, same folder the Files app calls **Download** — the
   plural is just Termux's symlink name) and opens *that* path, which goes
   through Android's own file provider instead.
   - Shell-written files don't trigger the media scanner, so the Files app
     won't list the APK until `termux-media-scan` runs on it.
   - `termux-setup-storage` prompts for confirmation when `~/storage`
     already exists, which would block a non-interactive run — so it is only
     invoked when `~/storage` is absent.
3. **Signature mismatch**: APKs built before `app/debug.keystore` was checked
   in were signed with a per-runner ephemeral debug key, so installing a
   current build over one of those fails with "App not installed" until the
   old app is uninstalled. Uninstalling also clears the service's
   SharedPreferences (Zoom mode resets to enabled) and may require re-pairing
   Bluetooth, since the HID SDP record goes with the app.
- PWA Setup Wizard (`pwa/src/components/SetupWizard.tsx`) — shown automatically
  when the PWA has no auth token (i.e., new phone), and reachable from
  Settings > Setup guide. Polls both `/status` endpoints (unauthenticated) to
  auto-detect progress: Whisper server up → steps 1-2 done, HID service up →
  step 3, token present → step 4, bluetooth "connected" → step 5. Includes a
  mic test using `POST /debug/test-pipeline`.

If the bootstrap URL, APK release tag, or PWA URL changes, update both
bootstrap.sh and the constants at the top of SetupWizard.tsx.

## Word corrections (auto-correct dictionary)

Whisper often misrecognizes proper nouns (e.g., "quad" instead of "Claude").
A post-transcription word correction system fixes these automatically.

### How it works
- `scripts/word-corrections.json` stores a `{"wrong": "correct"}` dictionary
- After Whisper returns text, `apply_corrections()` does case-insensitive
  whole-word replacement using `\b` regex boundaries
- Implemented in whisper-server.py — applied automatically after each transcription

### API endpoints
- `GET /corrections` — returns the current dictionary
- `PUT /corrections` — replaces the entire dictionary (body = JSON object)
- `POST /corrections/suggest` — the cleanup LLM scans recent transcripts
  (in-memory `recent_transcripts` deque, never persisted) for likely
  mishearings and returns advisory `{"wrong", "right"}` pairs. Nothing is
  saved until the user accepts one (the PWA then PUTs as usual). 503 when
  the LLM is down; a malformed LLM reply yields `[]`, never an error
  (`_parse_suggestions()`).
- Tests: `pytest scripts/tests/test_corrections.py` and
  `scripts/tests/test_llm_features.py` (suggestions)

### Context-aware corrections (glossary injection)
The regex pass can't fix contextual mishearings ("cloud" vs "Claude" depends
on the sentence). So the corrections dictionary's *values* — the vocabulary
the user actually means — are injected into the cleanup LLM's system prompt
as a glossary (`_glossary_terms()`, capped at 40 terms). While cleanup is
enabled, the LLM fixes these in context; the regex pass still runs after it
as the deterministic backstop. Appended at the END of the system prompt so
the static prefix stays byte-identical across glossary edits.

### PWA UI
- `WordCorrections` component in `pwa/src/components/WordCorrections.tsx`
- Shown in Settings view — lets users add/remove correction entries, plus a
  "✨ Suggest corrections" button that surfaces LLM suggestions with
  one-tap accept
- Calls `getCorrections()` / `putCorrections()` / `suggestCorrections()`
  from `pwa/src/lib/api.ts`

### CORS gotcha
The CORS `Access-Control-Allow-Methods` header in `cors_headers()` must
include every HTTP method used by the PWA. When the corrections PUT endpoint
was added, the CORS header had to be updated to include PUT — otherwise
browsers block the preflight request silently. If adding new HTTP methods
to any endpoint, update `cors_headers()` in whisper-server.py.

## Symbol replacements (spoken words → symbols)

For dictating to Claude Code and other CLIs: spoken phrases are replaced by
symbols, e.g. "forward slash help" → "/help", "foo dash bar" → "foo-bar".

### How it works
- `scripts/symbol-replacements.json` stores `{"enabled": bool, "entries": [...]}`;
  each entry is `{"phrase", "symbol", "spacing"}`
- `spacing` controls which adjacent spaces the symbol absorbs: `both`
  (foo-bar), `left` (key: value), `right` ("(x"), `none` (plain word swap)
- `apply_symbols()` in whisper-server.py runs in `_postprocess_text()` AFTER
  word corrections (so corrections can fix misheard phrases first). Matching
  is case-insensitive, whole-phrase (`\b` boundaries), longest phrase first.
- Only applied while `enabled` is true ("symbol mode") — words like "dash"
  occur in normal prose, so the mode is toggled per dictation context.
- A default starter set (`DEFAULT_SYMBOLS`) is materialized into the JSON
  file on first run, so users can edit/delete built-in entries individually.
  The file is gitignored (per-device, user-owned).

### API endpoints
- `GET /symbols` — current config
- `PUT /symbols` — partial merge: `enabled` and/or `entries` (lets the PWA
  toggle flip `enabled` without resending the entry list)
- `POST /symbols/reset` — restore default entries (keeps `enabled`)
- `GET /status` includes `"symbol_mode": bool`
- Tests: `pytest scripts/tests/test_symbols.py`

### PWA UI
- `SymbolReplacements` component in Settings — entry list with per-entry
  spacing dropdown, add form, restore-defaults button, enable toggle
- `SymbolModeToggle` pill on the Talk screen for quick on/off switching

## Speech cleanup (local LLM post-processing)

A small local LLM (Qwen3-1.7B Q4_K_M by default) rewrites the final
transcript: filler words (um/uh) and false starts removed, spoken
self-corrections resolved ("meet at 3 no wait 4pm" → "meet at 4pm"),
punctuation/capitalization/sentence breaks fixed. Runs on the phone next to
Parakeet — no network. The same resident llama-server also powers cleanup
*styles*, voice editing (`POST /edit`), correction suggestions
(`POST /corrections/suggest`), and glossary-aware corrections.

### How it works
- A resident `llama-server` (built from llama.cpp, same Termux build story as
  whisper.cpp) runs on localhost:9879, launched at whisper-server startup and
  mirroring the persistent whisper-server lifecycle. The model stays loaded
  (~1.3 GB RAM for the 1.7B) so flipping the toggle never pays a load wait.
- `apply_cleanup()` is called from `_postprocess_text()` BEFORE word
  corrections and symbols, so corrections/symbol phrases still match the
  cleaned text. In chunked mode this means it runs ONCE on the joined full
  text — never per chunk (false starts and self-corrections span chunk
  boundaries). Don't move it into the chunk loop.
- **Skipped while symbol mode is on** — CLI dictation wants verbatim text and
  the LLM would mangle "/help" or "foo-bar" back into prose.
- **Failure = fallback, never breakage**: server not ready, request error, or
  a degenerate response (empty / outside the style's length-ratio window,
  `_cleanup_result_ok()`) all deliver the raw transcript. Look for
  "Cleanup [style] applied"/"rejected"/"Cleanup failed" in `/logs`.
- Prompting: per-style system prompt + few-shot pairs pin down the rewrite;
  `/no_think` disables Qwen3 thinking mode and any `<think>` block is
  stripped from the reply. llama-server KV-caches the shared prompt prefix
  across requests (per style — switching styles re-pays prompt processing
  once). `max_tokens` is capped relative to input length so a runaway
  generation can't stall Stop.
- **Latency**: adds roughly 3–7s after Stop for typical dictations (scales
  with length, ~2x that on the 4B model) — that's the accepted tradeoff;
  the toggle is the escape hatch.

### Cleanup styles (rewrite flavors)
`CLEANUP_STYLES` defines one active rewrite flavor at a time
(`cleanup_settings["style"]`): `standard` (plain cleanup), `prompt`
(restructure dictation into a Claude Code prompt — bullets, identifiers kept
verbatim), `commit` (git commit message), `slack` (tidy chat message),
`email` (polished prose), `bug` (concise bug report). Each style declares
its own sanity ratio window (a commit summary legitimately compresses a
ramble far below the standard 0.35 floor — don't share one window). The PWA
exposes a style `<select>` next to the `CleanupToggle` pill on the Talk
screen. Styles are still skipped in symbol mode.

### Cleanup models (1.7B vs 4B)
`CLEANUP_MODEL_CATALOG` in whisper-server.py knows `qwen3-1.7b` (default,
~1.1 GB file) and `qwen3-4b` (~2.4 GB file, needs ~3 GB free RAM, roughly 2x
slower, noticeably smarter rewrites/edits). `PUT /cleanup {"model": name}`
persists the selection and restarts the llama-server with that GGUF;
`"available"` stays false until the new model finishes loading (the PWA
`CleanupSettings` section in Settings polls until it comes back). A missing
file returns 404 with the `./update-model.sh cleanup-4b` hint. `CLEANUP_MODEL`
(env) still overrides the *default* file; a persisted runtime selection wins
when its file is on disk (`active_cleanup_model_file()`).

### Voice editing (`POST /edit`)
Body `{"text", "command"}` — the LLM applies a spoken instruction ("replace
Mike with Sarah", "delete the last sentence", "make it more formal") to the
pending text and returns `{"text": edited}`. Used by the PWA edit-before-send
buffer (`EditBuffer`): with "Edit before send" enabled and the LLM up, an
"🎙 Edit by voice" button records an instruction via the normal
`/transcribe/start`+`stop` flow and applies it to the buffer. Any error or a
degenerate reply (empty, or >4x growth) returns 5xx and the caller keeps its
original text — the endpoint never partially applies an edit.

### Config / API
- `GET /cleanup` → `{"enabled", "available", "model", "models", "style",
  "styles"}`; `PUT /cleanup` merges any of `{"enabled": bool, "style": str,
  "model": str}` — persisted in `scripts/cleanup-settings.json`
  (gitignored, per-device)
- `/status` includes `"cleanup_mode"` (toggle), `"cleanup_available"`
  (llama-server up with model loaded), and `"cleanup_style"`
- Env: `STT_CLEANUP` (`auto`/`off` — whether the llama-server is started at
  all), `CLEANUP_SERVER_PORT` (9879), `CLEANUP_MODEL` (GGUF filename),
  `CLEANUP_THREADS` (4), `CLEANUP_TIMEOUT_SEC` (45)
- Install: setup-termux.sh builds llama.cpp (`-DGGML_NATIVE=OFF`,
  `-DLLAMA_CURL=OFF`, non-fatal) and downloads the 1.7B model;
  `./update-model.sh cleanup` re-downloads it, `./update-model.sh cleanup-4b`
  adds the 4B. Model file names are duplicated in whisper-server.py
  (`CLEANUP_MODEL_CATALOG`), setup-termux.sh, and update-model.sh — keep all
  three in sync.
- PWA: `CleanupToggle` pill + style picker on the Talk screen (hidden when
  unavailable, except while enabled so it can still be turned off);
  `CleanupSettings` model selector in Settings; voice edit in `EditBuffer`
- Tests: `pytest scripts/tests/test_cleanup.py` (cleanup, styles, models)
  and `scripts/tests/test_llm_features.py` (/edit, suggestions) — fake
  request helpers, no llama-server or model needed

## Component versioning
All three components expose version info, displayed together in PWA Settings.
Versions use the format `1.0.<commit-count>+<short-hash>` and are auto-generated
at build time from git — no manual bumps needed. Both generators run
`git rev-list --count HEAD`, which returns 1 on `actions/checkout`'s default
shallow clone, so **the CI workflows that ship a version must keep
`fetch-depth: 0`** — without it every CI build reports `1.0.1`.

### PWA
- Generated in `pwa/vite.config.ts` via Vite `define` → `__APP_VERSION__`
- Type declaration in `pwa/src/vite-env.d.ts`
- Auto-bumps when CI deploys (triggered by `pwa/**` changes on main)

### Kotlin app (HID service)
- Generated in `app/build.gradle.kts` via `gitVersionName()` → `BuildConfig.APP_VERSION`
- Exposed in `/status` response as `"version"` field
- Auto-bumps when CI builds APK (triggered by `app/**` changes on main)

### Whisper server (Termux)
- `SERVER_VERSION` constant at top of `scripts/whisper-server.py`
- Exposed in `/status` response as `"version"` field
- Manually maintained — bump when making changes to the server script
  (not built by CI, just copied to the phone)

## PWA UI conventions
- The PWA runs on a phone screen — all layouts must work on narrow viewports
  (~360px wide) without horizontal scrolling
- Form inputs should stack vertically on mobile rather than sit in a single row
- Action buttons (Add, Save, etc.) should be full-width or visually prominent,
  never hidden off-screen to the right
