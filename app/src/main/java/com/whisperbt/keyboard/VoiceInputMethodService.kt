package com.whisperbt.keyboard

import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
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

    // The HID service, once bound (never started from here): it owns the
    // headset's call link, which is open only while a dictation runs.
    @Volatile private var hidService: BluetoothHidService? = null
    private val hidConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            hidService = (service as BluetoothHidService.LocalBinder).getService()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            hidService = null
        }
    }

    // Called on the worker thread: open() blocks until the headset mic is routed.
    private val headsetLink = object : DictationLink {
        override fun open() { hidService?.beginDictationLink() }
        override fun close() { hidService?.endDictationLink() }
    }

    // Guarded: this runs in the HID service's process, and an exception
    // escaping the worker thread would end the service with it.
    private val guardedWorker = GuardedExecutor(worker, "Voice keyboard call") { what, e ->
        Log.e("WhisperVoiceIme", "$what failed", e)
    }

    private val controller = VoiceKeyboardController(
        DictationLinkTranscriber(HttpVoiceTranscriber(), headsetLink), ui
    ) { work -> guardedWorker.execute(work) }

    override fun onCreate() {
        super.onCreate()
        bindService(Intent(this, BluetoothHidService::class.java), hidConnection, 0)
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
        try { unbindService(hidConnection) } catch (_: IllegalArgumentException) {}
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
