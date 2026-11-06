package com.whisperbt.keyboard

/** The Termux server's /transcribe calls, behind an interface so the controller can be tested with a fake. */
interface VoiceTranscriber {
    sealed class Outcome {
        /** Success; [text] is the transcript for stop, empty for start. */
        data class Ok(val text: String) : Outcome()
        /** Nothing answered on the server's port. */
        object Unreachable : Outcome()
        /** The server answered with an error; [message] is fit to show. */
        data class Failed(val message: String) : Outcome()
    }

    /** POST /transcribe/start. Blocks. */
    fun start(): Outcome

    /** POST /transcribe/stop. Blocks until the text is ready. */
    fun stop(): Outcome
}

/** What the controller drives: the keyboard view and the focused text field. */
interface VoiceKeyboardUi {
    fun render(state: VoiceKeyboardController.State, status: String)
    fun commitText(text: String)

    /** Press the Enter key in the focused field (see [EnterKey]). */
    fun pressEnter()
}

/** Where [EnterKey] sends its result: the focused field's InputConnection. */
interface EnterTarget {
    /** A down and an up of [keyCode]. */
    fun sendKey(keyCode: Int)
    fun performAction(action: Int)
}

/**
 * The Enter key. Termux reads keys, not editor actions, so a field with no IME
 * action (TYPE_NULL, or an action of none/unspecified, or one that asks for no
 * enter action) gets KEYCODE_ENTER; a field whose EditorInfo asks for an action
 * (Messages: Send) gets performEditorAction.
 */
object EnterKey {
    private const val KEYCODE_ENTER = 66 // KeyEvent.KEYCODE_ENTER
    private const val IME_MASK_ACTION = 0xff
    private const val IME_FLAG_NO_ENTER_ACTION = 0x40000000

    /** The IME action to perform for these [inputType]/[imeOptions], or null for a plain Enter key. */
    fun actionFor(inputType: Int, imeOptions: Int): Int? {
        if (inputType == 0) return null
        if (imeOptions and IME_FLAG_NO_ENTER_ACTION != 0) return null
        val action = imeOptions and IME_MASK_ACTION
        // 0 = IME_ACTION_UNSPECIFIED, 1 = IME_ACTION_NONE
        return if (action <= 1) null else action
    }

    fun press(target: EnterTarget, inputType: Int, imeOptions: Int) {
        val action = actionFor(inputType, imeOptions)
        if (action == null) target.sendKey(KEYCODE_ENTER) else target.performAction(action)
    }
}

/**
 * The voice keyboard's state machine, free of Android types so it can be unit
 * tested: idle -> recording -> transcribing -> idle, and each error back to
 * idle. Taps are ignored while a call is in flight. The transcriber's calls
 * block, so they run through [runAsync]; [ui] is called from whichever thread
 * that is, and the service posts to main.
 */
class VoiceKeyboardController(
    private val transcriber: VoiceTranscriber,
    private val ui: VoiceKeyboardUi,
    /** Auto Enter, read at each commit so the settings switch takes effect at once. */
    private val autoEnter: () -> Boolean = { false },
    private val runAsync: (() -> Unit) -> Unit
) {
    enum class State { IDLE, STARTING, RECORDING, TRANSCRIBING }

    companion object {
        const val STATUS_IDLE = "Tap the mic to dictate"
        const val STATUS_LISTENING = "Listening"
        const val STATUS_TRANSCRIBING = "Transcribing"
        const val STATUS_SERVER_DOWN = "Whisper server is not running: start it in Termux"
        const val STATUS_NO_SPEECH = "No speech heard"
    }

    private val lock = Any()
    private var current = State.IDLE

    val state: State get() = synchronized(lock) { current }

    fun onMicTap() {
        when (state) {
            State.IDLE -> begin()
            State.RECORDING -> finish()
            State.STARTING, State.TRANSCRIBING -> Unit
        }
    }

    private fun begin() {
        if (!moveTo(State.IDLE, State.STARTING)) return
        runAsync {
            when (val r = transcriber.start()) {
                is VoiceTranscriber.Outcome.Ok -> settle(State.RECORDING, STATUS_LISTENING)
                else -> settle(State.IDLE, errorText(r))
            }
        }
    }

    private fun finish() {
        if (!moveTo(State.RECORDING, State.TRANSCRIBING)) return
        ui.render(State.TRANSCRIBING, STATUS_TRANSCRIBING)
        runAsync {
            when (val r = transcriber.stop()) {
                is VoiceTranscriber.Outcome.Ok -> {
                    val text = r.text.trim()
                    if (text.isEmpty()) {
                        settle(State.IDLE, STATUS_NO_SPEECH)
                    } else {
                        if (autoEnter()) {
                            ui.commitText(text)
                            ui.pressEnter()
                        } else {
                            ui.commitText("$text ")
                        }
                        settle(State.IDLE, STATUS_IDLE)
                    }
                }
                else -> settle(State.IDLE, errorText(r))
            }
        }
    }

    private fun errorText(r: VoiceTranscriber.Outcome): String = when (r) {
        is VoiceTranscriber.Outcome.Unreachable -> STATUS_SERVER_DOWN
        is VoiceTranscriber.Outcome.Failed -> r.message
        is VoiceTranscriber.Outcome.Ok -> STATUS_IDLE
    }

    private fun moveTo(from: State, to: State): Boolean = synchronized(lock) {
        if (current != from) false else { current = to; true }
    }

    private fun settle(to: State, status: String) {
        synchronized(lock) { current = to }
        ui.render(to, status)
    }
}
