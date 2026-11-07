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

    /** Do [press] in the focused field (see [EnterKey.perform]); never called with [EnterPress.None]. */
    fun pressEnter(press: EnterPress)
}

/** Where [EnterKey] sends its result: the focused field's InputConnection. */
interface EnterTarget {
    /** A down and an up of [keyCode]. */
    fun sendKey(keyCode: Int)
    fun performAction(action: Int)
}

/** What the focused field is: enough to decide what to press after a dictation. */
data class FieldInfo(val packageName: String?, val inputType: Int, val imeOptions: Int)

/** What to press after a dictation: nothing, the Enter key, or the field's own editor action. */
sealed class EnterPress {
    object None : EnterPress()
    /** KEYCODE_ENTER, down and up. */
    object Key : EnterPress()
    data class Action(val action: Int) : EnterPress()
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

    /** The Enter key on the keyboard itself, pressed by the user. */
    fun press(target: EnterTarget, inputType: Int, imeOptions: Int) {
        val action = actionFor(inputType, imeOptions)
        perform(target, if (action == null) EnterPress.Key else EnterPress.Action(action))
    }

    fun perform(target: EnterTarget, press: EnterPress) {
        when (press) {
            is EnterPress.None -> Unit
            is EnterPress.Key -> target.sendKey(KEYCODE_ENTER)
            is EnterPress.Action -> target.performAction(press.action)
        }
    }
}

/**
 * The one function that decides what the keyboard presses on its own after a
 * dictation: [decide]. Everything that auto-presses goes through it.
 */
object AutoEnter {
    private const val IME_MASK_ACTION = 0xff
    private const val ACTION_GO = 2
    private const val ACTION_SEND = 4
    private const val ACTION_DONE = 6

    private fun declaredAction(field: FieldInfo): Int = field.imeOptions and IME_MASK_ACTION

    /** Termux (and its add-ons), or any field with no input type, which only reads keys. */
    fun isTerminal(field: FieldInfo): Boolean {
        val pkg = field.packageName
        return field.inputType == 0 || pkg == "com.termux" || (pkg != null && pkg.startsWith("com.termux."))
    }

    /**
     * The field's own send. A multi-line EditText also sets IME_FLAG_NO_ENTER_ACTION
     * (its Enter key is a new line), but the action it declares is still what
     * the app wants for "send", so that flag is deliberately not consulted.
     */
    private fun sendAction(field: FieldInfo, accepted: Set<Int>): EnterPress.Action? {
        if (field.inputType == 0) return null
        val action = declaredAction(field)
        return if (action in accepted) EnterPress.Action(action) else null
    }

    fun decide(mode: AfterDictation, field: FieldInfo, overrides: Map<String, AfterDictation>): EnterPress {
        val effective = field.packageName?.let { overrides[it] } ?: mode
        return when (effective) {
            AfterDictation.OFF -> EnterPress.None
            AfterDictation.ENTER -> EnterPress.Key
            AfterDictation.SEND -> sendAction(field, setOf(ACTION_SEND, ACTION_GO, ACTION_DONE)) ?: EnterPress.Key
            AfterDictation.AUTO -> when {
                isTerminal(field) -> EnterPress.Key
                else -> sendAction(field, setOf(ACTION_SEND, ACTION_GO)) ?: EnterPress.None
            }
        }
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
    /** What to press after a dictation, decided at each commit so a mode or app change takes effect at once. */
    private val afterDictation: () -> EnterPress = { EnterPress.None },
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
                        val press = afterDictation()
                        if (press is EnterPress.None) {
                            ui.commitText("$text ")
                        } else {
                            ui.commitText(text)
                            ui.pressEnter(press)
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
