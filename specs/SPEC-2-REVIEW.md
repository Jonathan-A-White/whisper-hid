# SPEC-2 Review: Gaps, Rough Edges, and Recommendations

## Overall Assessment

SPEC-2 is a well-thought-out evolution. The separation of concerns is real and justified, the resilience design is significantly better than SPEC-1, and the API contracts are clear. But there are gaps, some lost functionality, organizational issues, and a few places where the design introduces complexity that could be simplified.

---

## 1. The "Why Three Components" Argument Needs Strengthening

The Motivation section says SPEC-1 "tightly couples concerns" but the argument is soft. The current codebase already has separate classes for each concern (BluetoothHidService, SocketListenerService, HidKeyMapper, etc.), a full three-tab UI with history/search/pin, and text buffering when BT disconnects. Someone reading SPEC-2 fresh might think SPEC-1 can't do these things — but it already does.

**What to actually say**: The three-component split isn't primarily about separation of concerns within the code — it's about **separation of deployment and development velocity**:

1. **PWA for UI**: Web tech iterates faster than Android XML layouts. Hot reload via Vite vs. rebuild+sideload APK. The UI can be updated by pushing to GitHub Pages — no APK reinstall, no device in hand. This is the killer feature.
2. **Whisper server as a stateless API**: Decouples the transcription engine from mic ownership and from the Kotlin app lifecycle. Today, if the bash script dies mid-transcription, the socket listener in Kotlin doesn't know why. With an HTTP API, the PWA gets a proper error response. It also makes it trivial to swap whisper.cpp for a different engine (or even a remote API) without touching anything else.
3. **Headless Kotlin HID service**: The BT HID API _requires_ an Android app. But by stripping it to a headless service with an HTTP API, the Kotlin app becomes a stable, rarely-changed piece of infrastructure. No UI churn, no Fragment lifecycle bugs, no reason to redeploy it unless the BT stack changes.

The spec should lead with the **deployment/iteration argument**, not the coupling argument. The coupling story is secondary — the real win is being able to update the UI without touching the APK.

---

## 2. Features Being Lost from SPEC-1 Implementation

The "Files removed" table says `SocketListenerService.kt` and `BootReceiver.kt` go away. But the spec doesn't account for several features the current implementation provides:

### 2a. Push-to-Talk (PTT) Mode — Not Addressed

The current system has a complete PTT implementation:
- `stt-loop.sh` supports START/STOP commands from the client
- `SocketListenerService.kt` sends `pttStart()`/`pttStop()` over the socket
- `TalkFragment.kt` has a big PTT button with haptic feedback, scale animation, and a tone on MIC_READY
- The Termux side does background transcription during PTT so the user can press again immediately

SPEC-2 describes mic capture via AudioWorklet with "5-second chunks" (continuous mode only). PTT isn't mentioned at all. This is a significant regression — PTT is the primary interaction mode in the current app (the socket service defaults to `pttMode = true`).

**Recommendation**: Add a PTT section to the PWA spec. The PWA button triggers `mediaRecorder.start()` / `mediaRecorder.stop()`, and the resulting audio blob is sent to POST /transcribe. This is actually simpler in the PWA model than the current Termux model (no socket commands, no background process coordination).

### 2b. Control Messages (PAUSE/RESUME/BACKSPACE:N) — Partially Lost

The current SocketListenerService handles PAUSE, RESUME, BACKSPACE:N, and MIC_READY control messages. SPEC-2's `/type` endpoint only handles text. There's no equivalent to BACKSPACE or PAUSE/RESUME.

- **BACKSPACE**: Should this be a `POST /type` with `{"backspace": 5}`? Or a separate endpoint `POST /backspace`? The spec needs to decide.
- **PAUSE/RESUME**: In the PWA model, the PWA controls when audio is captured, so PAUSE/RESUME from the server side doesn't make sense. This is fine to drop — but should be called out explicitly.
- **MIC_READY**: In the current system, this signal comes from Termux after the mic is initialized, so the Android app can play a chime. In SPEC-2, the PWA owns the mic, so it knows when it's ready. No equivalent needed — but again, worth calling out.

### 2c. Auto-Start on Boot — Not Addressed

`BootReceiver.kt` auto-starts both services on phone boot. SPEC-2 marks it as removed but doesn't discuss how the three components start on boot. The Kotlin service can still use a boot receiver. The Whisper server needs a Termux:Boot script. The PWA... can't auto-start (browsers don't support this). The user must manually open the PWA after boot.

**Recommendation**: Add a "Startup" section. The Kotlin service and Whisper server can auto-start via BootReceiver and Termux:Boot respectively. The user taps the "Open PWA" button in the Kotlin app's notification after boot. This is a minor UX regression from the current "everything auto-starts" experience.

### 2d. Audio SCO Routing — SHOWSTOPPER RISK (Researched)

`MainActivity.kt` calls `AudioManager.startBluetoothSco()` to route the headset mic through the phone. In SPEC-2, the PWA uses `getUserMedia()` which goes through the browser's audio stack.

**Research findings**: This is a real problem, not a hypothetical one.

Chrome on Android **does not automatically activate Bluetooth SCO** when `getUserMedia()` requests microphone access. Bluetooth audio has two modes: **A2DP** (high-quality music playback, no mic) and **SCO/HFP** (lower-quality bidirectional audio with mic). Devices default to A2DP. To use the headset mic, the SCO link must be explicitly established via native Android APIs.

The APIs that activate SCO are:
- `AudioManager.startBluetoothSco()` (deprecated since Android 12)
- `AudioManager.setCommunicationDevice(AudioDeviceInfo)` (Android 12+, the replacement)

**Neither of these is available to web apps.** Chrome's `getUserMedia()` has no way to trigger SCO connection establishment. When a web app calls `getUserMedia({ audio: true })` with a BT headset connected, Chrome typically returns audio from the **phone's built-in microphone**, not the headset mic. There is a Chromium issue tracking this: [Issue 40222537 — "Android 12+: Chrome ignores connected bluetooth..."](https://issues.chromium.org/issues/40222537).

The `enumerateDevices()` API may list the BT headset as an audio input, and you can pass its `deviceId` to `getUserMedia()`, but this doesn't reliably work because the SCO transport layer isn't activated — the device is "visible" but the audio path isn't open. Additionally, `enumerateDevices()` on Android Chrome often returns only a single `audioinput` entry regardless of how many mics are connected — the BT mic may not even appear as a selectable option ([Chromium Issue 370332086](https://issues.chromium.org/issues/370332086), [react-native-webrtc Issue 1116](https://github.com/react-native-webrtc/react-native-webrtc/issues/1116)).

**Additional problem: SCO audio quality.** Even when SCO is active, the audio is limited to **8kHz mono** (per the HFP Bluetooth profile). Whisper expects **16kHz** input. The current SPEC-1 system uses `termux-microphone-record` with source type `VOICE_COMMUNICATION` (audio source 7), which may negotiate higher sample rates depending on the headset's codec support, and then ffmpeg upsamples to 16kHz WAV. With SCO via `getUserMedia()`, the browser gets 8kHz audio and would need to upsample. This will degrade transcription accuracy compared to the native path. This is a Bluetooth protocol limitation, not a software bug — HFP (Hands-Free Profile) trades audio quality for bidirectional mic+speaker ([Daily.co: Why Bluetooth audio quality suffers in video calls](https://www.daily.co/blog/why-bluetooth-audio-quality-suffers-in-video-calls/)).

**Impact on SPEC-2**: Two problems: (1) the PWA can't reliably access the BT headset mic at all without native help, and (2) even if it could, SCO audio is 8kHz which hurts Whisper accuracy. This undermines a core use case (commuter with BT headset).

**Possible solutions** (pick one):

1. **Kotlin service manages SCO** (recommended): The Kotlin HID service already runs as a foreground service. Add `setCommunicationDevice()` / `startBluetoothSco()` calls there. The PWA calls a new endpoint (e.g., `POST /sco?enable=true`) to tell the Kotlin service to activate SCO before starting mic capture. Once SCO is active system-wide, `getUserMedia()` should pick up the headset mic. This keeps the PWA as the mic owner but delegates the SCO plumbing to the native service that's already running.

2. **Use a WebView instead of Chrome**: If the Kotlin app hosts the PWA in a `WebView` instead of opening it in Chrome, the native app can call `setCommunicationDevice()` before the WebView's `getUserMedia()` fires, and can override `onPermissionRequest` to grant mic access. This loses the "deploy PWA via GitHub Pages" advantage but guarantees mic routing works.

3. **Keep mic capture in Termux** (hybrid): Don't move mic capture to the PWA. Keep the current Termux mic capture (via `termux-microphone-record`, which uses native APIs and respects SCO). The PWA becomes a UI-only layer — it sends a "start recording" command to the Whisper server, which captures audio and returns text. This is a smaller departure from SPEC-1 but still gets the PWA UI benefits.

**Recommendation**: Given the 8kHz quality issue, **Option 3 is now the stronger choice**. Keeping mic capture in Termux means the native `termux-microphone-record` handles SCO activation and can potentially get higher-quality audio than the browser's SCO path. The PWA still gets all the UI benefits — it just doesn't own the mic. If you want to try Option 1 first, add a Phase 2 spike to verify both (a) that `getUserMedia()` picks up the BT headset mic after `setCommunicationDevice()`, and (b) that the 8kHz SCO audio produces acceptable Whisper transcription quality on the S24 Ultra.

**Sources**:
- [Google Oboe Wiki: Bluetooth Audio](https://github.com/google/oboe/wiki/TechNote_BluetoothAudio) — SCO vs A2DP, setCommunicationDevice API
- [Chromium Issue 40222537](https://issues.chromium.org/issues/40222537) — Android 12+ Chrome ignoring BT devices
- [Chromium Issue 370332086](https://issues.chromium.org/issues/370332086) — getUserMedia ignores deviceId constraints
- [WebRTC Issue 739 / 42232497](https://bugs.chromium.org/p/webrtc/issues/detail?id=739) — Bluetooth mic not working with getUserMedia
- [webrtc/samples Issue 1338](https://github.com/webrtc/samples/issues/1338) — BT headset mic fails or behaves inconsistently on Android
- [Daily.co: Why Bluetooth audio quality suffers](https://www.daily.co/blog/why-bluetooth-audio-quality-suffers-in-video-calls/) — HFP 8kHz limitation
- [Mozilla Bug 1091417](https://bugzilla.mozilla.org/show_bug.cgi?id=1091417) — Investigate Bluetooth SCO API for WebRTC
- [Chromium code review 1231623004](https://groups.google.com/a/chromium.org/g/chromium-reviews/c/5OarCwcMf-Q) — Chrome's internal AudioManagerAndroid.java and SCO handling

### 2e. Pinned Items / Quick Resend — Not Addressed

The current app has pinned transcription items that appear as horizontal chips on the Talk screen. Tapping a pinned item resends it immediately. This is useful for frequently-typed phrases. SPEC-2's PWA has a transcript list with tap-to-edit-and-resend, but no pinning concept.

**Recommendation**: Either add pinning to the PWA spec or consciously drop it (and say why). Pinning is genuinely useful — e.g., pinning "Let me share my screen" or common phrases.

### 2f. Append Newline/Space Settings — Not Addressed

The current app has per-transcription-segment settings: append a newline or a space after each segment. These are essential for usability — without them, consecutive transcriptions get jammed together. SPEC-2 doesn't mention these settings.

**Recommendation**: Add to the PWA's Settings section. The PWA should append configurable separator text before sending to `/type`, or the `/type` API should support an option like `{"text": "hello", "append": "\n"}`.

---

## 3. Gaps and Underspecified Areas

### 3a. Whisper Server Implementation: Bash vs. Python vs. C

The spec suggests three options (Python Flask, Bash+socat, C/C++) and says Python is "probably the pragmatic choice." This should be a decision, not a suggestion. The current Termux scripts are pure Bash — introducing Python adds a dependency (`pkg install python`, plus `pip install flask`). Python in Termux is large (~100MB installed).

**Recommendation**: Commit to Python+Flask. The overhead is justified because:
- An HTTP server in Bash is fragile and hard to maintain
- C/C++ linked against whisper.cpp is more work than needed for a localhost API
- Python+Flask is ~30 lines for the /transcribe endpoint
- But add `python` and `flask` to setup-termux.sh's dependency list and call out the disk space cost

### 3b. Whisper Server: Model Loading Lifecycle

The current `start-stt.sh` validates the model exists at startup. The SPEC-2 Whisper server's `/status` endpoint reports the loaded model, but there's no discussion of:
- When is the model loaded? At server startup? On first `/transcribe` request?
- What if the model file is missing? Does `/transcribe` return an error, or does the server refuse to start?
- Can the model be swapped at runtime (hot-reload), or does the server need to restart?

**Recommendation**: Load the model at server startup. If missing, the server starts but `/status` reports `"status": "error"` and `/transcribe` returns 503. Model swap requires server restart (keep it simple). Update `update-model.sh` to note that the server must be restarted after swapping models.

### 3c. PWA-to-Localhost: Private Network Access is Experimental

The spec relies on Chrome's Private Network Access (PNA) for the PWA (HTTPS, GitHub Pages) to call localhost (HTTP). This is critical infrastructure for the whole design. But PNA is still in active development in Chrome — the `Access-Control-Allow-Private-Network` header behavior has changed across Chrome versions and there's no guarantee it'll remain stable.

**Recommendation**: Add a fallback plan. If PNA breaks or tightens in a future Chrome release:
- Option A: Host the PWA on localhost too (via a simple Termux HTTP server). This eliminates the mixed-context problem but loses the "update by pushing to GitHub" advantage.
- Option B: Use a Chrome extension as a bridge (but this requires sideloading, which may not be possible on all devices).

At minimum, document the Chrome version requirements and add a "known risks" section.

### 3d. Token Delivery via URL Query Parameter

Passing the auth token as `?token=abc123` in the URL means:
- It appears in the browser address bar (even if briefly, before `history.replaceState` strips it)
- It may be logged in Chrome's history, autocomplete suggestions, or referrer headers
- If the user manually types the PWA URL instead of using the "Open" button, they won't have a token

The spec acknowledges `history.replaceState` cleanup. But the real gap is: **what happens when the user opens the PWA directly** (from homescreen, from a bookmark, from Chrome history) without going through the Kotlin app? The token is in `sessionStorage`, which is gone after closing the tab.

**Recommendation**: Add a "re-authentication" flow. If the PWA has no token in `sessionStorage`, it should:
1. Show a "Not authenticated" state
2. Provide a "Get token from HID app" button that opens an Android intent to the Kotlin Activity
3. The Kotlin Activity then re-opens the PWA with a fresh token

Alternatively, consider a more persistent token mechanism — e.g., store a hashed token in `localStorage` (not `sessionStorage`), regenerated only when the Kotlin service restarts. The current "dies with the tab" design means the user must go through the Kotlin app every time the browser tab is closed.

### 3e. Concurrent `/transcribe` Requests

What happens if the PWA sends a new audio chunk while a previous `/transcribe` request is still processing? Whisper inference takes 0.5-3 seconds depending on the model. With 5-second chunks, requests can overlap.

**Recommendation**: The spec should say whether the Whisper server handles concurrent requests (queued? rejected? parallel?). The simplest approach: serialize requests in the server (one at a time, FIFO queue). If a request arrives while another is processing, it waits. Document this behavior.

### 3f. Audio Format: AudioWorklet PCM Details

The spec says AudioWorklet outputs "16kHz 16-bit mono PCM directly." But `getUserMedia` typically gives 44.1kHz or 48kHz float32. The AudioWorklet would need to downsample to 16kHz and convert to int16 — this is non-trivial in JavaScript. The spec doesn't discuss downsampling.

**Recommendation**: Either:
- Use MediaRecorder (WebM/Opus) and let the Whisper server transcode with FFmpeg (simpler, already described as the fallback)
- Or spec out the AudioWorklet resampling: use an OfflineAudioContext or a polyfill for resampling, then convert float32 to int16 PCM. Consider using a library like `audiobuffer-to-wav` or doing it manually (it's ~20 lines).

Given the complexity, I'd recommend **starting with MediaRecorder** and only switching to AudioWorklet if latency is a problem.

---

## 4. Organizational / Structural Issues

### 4a. Duplicated Content

The spec repeats the BT disconnection UI mockups nearly identically in two places:
- Once under "Component 1: PWA > UI > Bluetooth disconnection"
- Again under "Resilience and Operability > PWA Disconnection UI"

Same mockups, same text. This will inevitably drift. Pick one location and reference it from the other.

### 4b. Spec Should Reference What It Preserves from SPEC-1

SPEC-2 says "Bluetooth HID: Unchanged from SPEC-1" and "All constraints from SPEC-1 still apply." But it doesn't say which SPEC-1 elements are being preserved. A reader needs to read both specs to understand the full picture.

**Recommendation**: Add a short "Preserved from SPEC-1" section that explicitly lists what carries forward:
- HID descriptor (identical)
- HidKeyMapper (identical)
- BluetoothHidDevice registration flow (identical)
- Keystroke delay mechanism (identical)
- Foreground service with notification (identical)
- whisper.cpp binary and model files (identical)
- setup-termux.sh core logic (adapted, not rewritten)

### 4c. The Difference Table Is Incomplete

The "Key differences from SPEC-1" table is useful but missing rows:
- PTT mode (SPEC-1: yes, SPEC-2: unspecified)
- Boot auto-start (SPEC-1: yes, SPEC-2: unspecified)
- Audio routing/SCO (SPEC-1: managed by Kotlin, SPEC-2: unspecified)
- Append newline/space settings (SPEC-1: yes, SPEC-2: unspecified)
- Pinned items (SPEC-1: yes, SPEC-2: no)
- SQLite database (SPEC-1: yes, SPEC-2: IndexedDB)

### 4d. Repository Structure: Missing diagnose-sigill.sh and stt-loop.sh

The SPEC-2 repo structure lists scripts/ but doesn't include `diagnose-sigill.sh` (a genuinely useful diagnostic tool that exists today) or an equivalent. Also `stt-loop.sh` goes away but is not mentioned in the "files removed" list.

---

## 5. Potential Design Simplifications

### 5a. Do You Really Need IndexedDB?

The spec introduces IndexedDB (via `idb`) for transcript history and settings in the PWA. But the PWA also polls `/logs` from both backend services and can store transcripts there. Is the PWA the system of record for transcription history, or is it the Kotlin service / Whisper server?

If the PWA is the single source of truth for history (which makes sense since it's the orchestrator), IndexedDB is fine. But `localStorage` would be simpler for settings (just JSON.stringify a settings object) and the transcript list could be in-memory (React state) with localStorage backup for persistence across refreshes. IndexedDB is overkill unless you need:
- Thousands of transcript entries
- Full-text search across history
- Large blob storage

For a speech-to-text keyboard, you're unlikely to need any of those. Consider `localStorage` for both settings and recent history (last ~500 entries), and drop the `idb` dependency entirely.

### 5b. WebSocket vs. Polling for Status

The spec says the PWA "polls the Kotlin service's `/status` endpoint (every 2-3 seconds) or holds an open WebSocket." This is a design decision, not an option to leave open. Polling every 3 seconds is simple and perfectly adequate for BT connection state (which changes infrequently). A WebSocket adds complexity on both sides for negligible latency improvement.

**Recommendation**: Commit to polling. Drop the WebSocket mention. 3-second polling is fine — BT reconnections take seconds anyway, so 3s of status lag is invisible. This also avoids needing a WebSocket server in the Kotlin app (com.sun.net.httpserver doesn't support WebSocket).

### 5c. `/logs` Endpoint: Is It Worth It?

Both services expose `/logs`. The PWA has a DebugLog component that aggregates them. But:
- Log data is unbounded — what's the retention policy?
- Who reads debug logs on a phone screen?
- This is dev tooling masquerading as a feature

**Recommendation**: Keep `/logs` but deprioritize it. Move the debug log section later in the spec (after the core flow). Cap the log buffer at 200 entries (circular buffer). Don't invest in a fancy DebugLog component — a `<pre>` tag with the raw JSON is fine for debugging.

### 5d. BDD Testing Strategy: Overengineered for the Project Size

The spec proposes three different BDD frameworks (Cucumber-JVM, behave, cucumber-js+Playwright) with shared Gherkin feature files in a top-level `features/` directory, plus CI integration with Android emulators.

For a personal-use project with three components totaling maybe 2000 lines of code, this is a lot of test infrastructure. Cucumber-JVM in particular requires an Android emulator in CI, which is slow and flaky.

**Recommendation**: Simplify:
- **Kotlin**: Regular JUnit tests that mock the BT layer. No Cucumber. The state machine is small enough that table-driven JUnit tests are clearer than Gherkin steps.
- **Python Whisper server**: pytest with a test WAV fixture. `pytest` is simpler than `behave` and already available in Termux.
- **PWA**: Playwright E2E tests (no cucumber-js wrapper). Playwright's own test runner is excellent.
- Drop the shared `features/` directory. Each component tests itself.

The BDD/Gherkin approach adds a layer of indirection (feature files -> step definitions -> actual test code) that makes sense for teams with non-technical stakeholders reading specs, but for a solo developer it's ceremony without benefit.

---

## 6. Consistency Issues

### 6a. Port Numbers

- SPEC-2 says Whisper server is on `:9876` and Kotlin HID is on `:9877`
- SPEC-1 uses `:9876` for the raw TCP socket
- The current code uses `:9876` for TCP (configurable via env/preferences)

The port reuse (`:9876` was TCP, now HTTP) is fine since SPEC-2 replaces SPEC-1. But the spec should call this out explicitly: "Port 9876 is reused — the TCP socket protocol from SPEC-1 is replaced by the HTTP API."

### 6b. React 19 Specificity

The spec calls out "React 19" specifically. React 19 was released in late 2024. Pinning to a specific major version in a spec is fine, but the spec doesn't use any React 19-specific features (Server Components, Actions, etc.). Just "React" would be more future-proof, or note specifically why React 19 matters.

### 6c. Tailwind CSS 4 Specificity

Same issue — "Tailwind CSS 4" is called out but the spec doesn't use any v4-specific features. Tailwind 4 has a different config format (`@theme` in CSS vs. `tailwind.config.ts`). The repo structure still shows `tailwind.config.ts`, which is the Tailwind v3 pattern. If you're going to specify v4, update the repo structure to match v4 conventions (no config file, directives in CSS).

---

## 7. Missing Sections

### 7a. Migration Path

How do you get from the current SPEC-1 implementation to SPEC-2? The spec has development phases but doesn't address migration:
- Can SPEC-1 and SPEC-2 coexist during development? (Port conflict on 9876)
- Does the Kotlin app need to support both modes during transition?
- What's the cutover plan?

**Recommendation**: Add a brief migration note. The simplest approach: SPEC-2 development happens on a feature branch. The Kotlin app is refactored in place (strip UI, add HTTP server). The Whisper server is a new component that replaces start-stt.sh. The PWA is entirely new. Deploy all at once.

### 7b. Error Handling Philosophy

The spec defines error responses for each endpoint but doesn't discuss the overall error handling philosophy:
- Should the PWA retry failed `/transcribe` requests? (Probably not — the audio moment has passed)
- Should the PWA retry failed `/type` requests? (Yes — the text is already transcribed)
- What happens if the Whisper server returns an error for every request? (Model corrupted? Disk full?)

**Recommendation**: Add a brief error handling section. Key principle: **transcription errors are acceptable (lost audio), but text delivery errors are not (text must queue)**. This matches the current spec's queuing behavior for BT disconnect, but should be stated as a design principle.

### 7c. Data Flow Diagram

The architecture diagram shows the components and ports. What's missing is a **sequence diagram** for the normal operation flow and the failure flows. The text description under "Communication flow" is good but a sequence diagram would make the timing relationships clearer, especially for:
- What happens when /transcribe is slow and audio chunks pile up
- The exact BT reconnect sequence with queue flush
- The auth token handshake flow

---

## Summary of Recommendations

| Priority | Recommendation |
|----------|---------------|
| **High** | Add PTT mode to PWA spec (currently the primary interaction mode) |
| **High** | Resolve BT SCO mic routing: getUserMedia can't activate SCO, and SCO is only 8kHz (Whisper wants 16kHz). Consider keeping mic in Termux (Option 3) or spike Option 1 with real hardware first |
| **High** | Strengthen the "why three components" with deployment/iteration argument |
| **High** | Address token re-authentication when PWA is opened without going through Kotlin app |
| **Medium** | Add append-newline/space settings to PWA |
| **Medium** | Commit to Python+Flask for Whisper server (not a menu of options) |
| **Medium** | Commit to polling (drop WebSocket mention) |
| **Medium** | Deduplicate BT disconnection UI mockups |
| **Medium** | Add "Preserved from SPEC-1" section |
| **Medium** | Simplify testing: JUnit + pytest + Playwright (drop Cucumber/BDD) |
| **Medium** | Specify concurrent /transcribe behavior |
| **Medium** | Add migration path section |
| **Low** | Consider localStorage instead of IndexedDB |
| **Low** | Add boot/startup sequence documentation |
| **Low** | Add error handling philosophy section |
| **Low** | Fix Tailwind CSS 4 inconsistency with repo structure |
| **Low** | Add pinned items to PWA or explicitly drop with rationale |
| **Low** | Deprioritize /logs — move later, cap buffer size |
| **Low** | Document PNA risk and fallback plan |
