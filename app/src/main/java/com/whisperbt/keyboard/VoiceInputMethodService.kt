package com.whisperbt.keyboard

import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.TextView
import java.util.concurrent.Executors

/**
 * "Whisper voice": a small input method with one big mic button. Tap to start
 * the Termux server recording, tap again to stop and type the transcript into
 * the focused field. The state machine is [VoiceKeyboardController]; this
 * class only wires it to the views and the InputConnection.
 */
class VoiceInputMethodService : InputMethodService() {

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()

    private var statusView: TextView? = null
    private var micButton: Button? = null

    private val ui = object : VoiceKeyboardUi {
        override fun render(state: VoiceKeyboardController.State, status: String) {
            main.post { renderOnMain(state, status) }
        }

        override fun commitText(text: String) {
            main.post { currentInputConnection?.commitText(text, 1) }
        }
    }

    private val controller = VoiceKeyboardController(HttpVoiceTranscriber(), ui) { work ->
        worker.execute(work)
    }

    override fun onCreateInputView(): View {
        val view = layoutInflater.inflate(R.layout.voice_keyboard, null)
        statusView = view.findViewById(R.id.voiceStatus)
        micButton = view.findViewById<Button>(R.id.voiceMic).also {
            it.setOnClickListener { controller.onMicTap() }
        }
        view.findViewById<Button>(R.id.voiceBackspace).setOnClickListener { backspace() }
        view.findViewById<Button>(R.id.voiceSwitch).setOnClickListener { switchKeyboard() }
        renderOnMain(controller.state, VoiceKeyboardController.STATUS_IDLE)
        return view
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    private fun renderOnMain(state: VoiceKeyboardController.State, status: String) {
        statusView?.text = status
        micButton?.apply {
            text = when (state) {
                VoiceKeyboardController.State.RECORDING -> "⏹"
                VoiceKeyboardController.State.TRANSCRIBING,
                VoiceKeyboardController.State.STARTING -> "…"
                VoiceKeyboardController.State.IDLE -> "🎤"
            }
            setBackgroundResource(
                if (state == VoiceKeyboardController.State.RECORDING) R.drawable.voice_mic_recording
                else R.drawable.voice_mic_idle
            )
        }
    }

    private fun backspace() {
        val ic = currentInputConnection ?: return
        if (ic.getSelectedText(0).isNullOrEmpty()) {
            sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL)
        } else {
            ic.commitText("", 1)
        }
    }

    private fun switchKeyboard() {
        if (!switchToPreviousInputMethod()) {
            (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).showInputMethodPicker()
        }
    }
}
