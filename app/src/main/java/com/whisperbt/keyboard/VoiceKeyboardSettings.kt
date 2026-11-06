package com.whisperbt.keyboard

import android.content.Context
import android.content.Intent

/** The one boolean store [VoiceKeyboardSettings] needs, so tests can use a fake. */
interface BooleanStore {
    fun getBoolean(key: String, default: Boolean): Boolean
    fun putBoolean(key: String, value: Boolean)
}

/**
 * Whisper voice's settings, shared by the keyboard (reads) and the settings
 * screen (writes) through this class only: one preferences file, one key.
 */
class VoiceKeyboardSettings(private val store: BooleanStore) {
    companion object {
        const val PREFS_NAME = "voice_keyboard"
        const val KEY_AUTO_ENTER = "auto_enter"

        fun from(context: Context): VoiceKeyboardSettings {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return VoiceKeyboardSettings(object : BooleanStore {
                override fun getBoolean(key: String, default: Boolean) = prefs.getBoolean(key, default)
                override fun putBoolean(key: String, value: Boolean) {
                    prefs.edit().putBoolean(key, value).apply()
                }
            })
        }
    }

    /** Press Enter after each committed dictation. Off until switched on. */
    var autoEnter: Boolean
        get() = store.getBoolean(KEY_AUTO_ENTER, false)
        set(value) = store.putBoolean(KEY_AUTO_ENTER, value)
}

/** The gear key. An IME has no task of its own, so the Activity must start as a new task. */
object VoiceSettingsLauncher {
    const val FLAGS = Intent.FLAG_ACTIVITY_NEW_TASK

    fun open(start: (flags: Int) -> Unit) = start(FLAGS)
}
