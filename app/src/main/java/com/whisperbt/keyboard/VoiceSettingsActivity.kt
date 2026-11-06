package com.whisperbt.keyboard

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat

/**
 * Whisper voice settings: opened by the keyboard's gear key and by the gear in
 * Android's input method picker (method.xml's settingsActivity).
 */
class VoiceSettingsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_voice_settings)
        val settings = VoiceKeyboardSettings.from(this)
        findViewById<SwitchCompat>(R.id.autoEnterSwitch).apply {
            isChecked = settings.autoEnter
            setOnCheckedChangeListener { _, checked -> settings.autoEnter = checked }
        }
    }
}
