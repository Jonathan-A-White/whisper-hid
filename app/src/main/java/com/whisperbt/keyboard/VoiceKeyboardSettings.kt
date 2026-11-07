package com.whisperbt.keyboard

import android.content.Context
import android.content.Intent

/** The preferences [VoiceKeyboardSettings] needs, so tests can use a fake. */
interface SettingsStore {
    fun contains(key: String): Boolean
    fun getBoolean(key: String, default: Boolean): Boolean
    fun putBoolean(key: String, value: Boolean)
    fun getString(key: String, default: String?): String?
    fun putString(key: String, value: String)
}

/** What the keyboard presses after each dictation. */
enum class AfterDictation(val wire: String) {
    /** Nothing. */
    OFF("off"),
    /** A new line: the Enter key (Termux). */
    ENTER("enter"),
    /** The field's own send action, else Enter (Postern, Google Voice, chat boxes). */
    SEND("send"),
    /** Picked by the app and the field: see [AutoEnter.decide]. */
    AUTO("auto");

    companion object {
        fun fromWire(s: String?): AfterDictation? = values().firstOrNull { it.wire == s }
    }
}

/**
 * Whisper voice's settings, shared by the keyboard (reads) and the settings
 * screen (writes) through this class only: one preferences file.
 */
class VoiceKeyboardSettings(private val store: SettingsStore) {
    companion object {
        const val PREFS_NAME = "voice_keyboard"
        /** 1.0.18's on/off switch; read only to migrate it. */
        const val KEY_AUTO_ENTER = "auto_enter"
        const val KEY_MODE = "after_dictation"
        const val KEY_APP_MODES = "app_modes"

        fun from(context: Context): VoiceKeyboardSettings {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return VoiceKeyboardSettings(object : SettingsStore {
                override fun contains(key: String) = prefs.contains(key)
                override fun getBoolean(key: String, default: Boolean) = prefs.getBoolean(key, default)
                override fun putBoolean(key: String, value: Boolean) {
                    prefs.edit().putBoolean(key, value).apply()
                }
                override fun getString(key: String, default: String?) = prefs.getString(key, default)
                override fun putString(key: String, value: String) {
                    prefs.edit().putString(key, value).apply()
                }
            })
        }
    }

    /**
     * The mode for apps with no entry of their own. Auto until chosen; a phone
     * that had 1.0.18's switch set keeps it (On is Auto, Off stays Off).
     */
    var mode: AfterDictation
        get() = AfterDictation.fromWire(store.getString(KEY_MODE, null))
            ?: if (store.contains(KEY_AUTO_ENTER)) {
                if (store.getBoolean(KEY_AUTO_ENTER, false)) AfterDictation.AUTO else AfterDictation.OFF
            } else AfterDictation.AUTO
        set(value) = store.putString(KEY_MODE, value.wire)

    /** Package name to mode, for the apps whose mode was changed while in them. */
    fun appModes(): Map<String, AfterDictation> {
        val out = linkedMapOf<String, AfterDictation>()
        for (line in (store.getString(KEY_APP_MODES, null) ?: "").lineSequence()) {
            val i = line.indexOf('=')
            if (i <= 0) continue
            val m = AfterDictation.fromWire(line.substring(i + 1)) ?: continue
            out[line.substring(0, i)] = m
        }
        return out
    }

    /** Remember [mode] for [pkg]; null forgets the app, so it follows [mode] again. */
    fun setAppMode(pkg: String, mode: AfterDictation?) {
        val all = appModes().toMutableMap()
        if (mode == null) all.remove(pkg) else all[pkg] = mode
        store.putString(KEY_APP_MODES, all.entries.joinToString("\n") { "${it.key}=${it.value.wire}" })
    }

    /** The one decision of what to press after a dictation in [field]. */
    fun pressFor(field: FieldInfo): EnterPress = AutoEnter.decide(mode, field, appModes())
}

/** The gear key. An IME has no task of its own, so the Activity must start as a new task. */
object VoiceSettingsLauncher {
    const val FLAGS = Intent.FLAG_ACTIVITY_NEW_TASK

    fun open(start: (flags: Int) -> Unit) = start(FLAGS)
}
