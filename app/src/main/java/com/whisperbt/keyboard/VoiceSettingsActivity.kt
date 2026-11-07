package com.whisperbt.keyboard

import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.widget.RadioGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Whisper voice settings: opened by the keyboard's gear key and by the gear in
 * Android's input method picker (method.xml's settingsActivity). Opened from
 * the gear it carries the app being typed into ([EXTRA_APP_PACKAGE]), and a
 * mode chosen for that app is remembered for it.
 */
class VoiceSettingsActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_APP_PACKAGE = "app_package"
    }

    private lateinit var settings: VoiceKeyboardSettings
    private var appPackage: String? = null
    private var binding = false

    private val globalIds = mapOf(
        R.id.modeAuto to AfterDictation.AUTO, R.id.modeOff to AfterDictation.OFF,
        R.id.modeEnter to AfterDictation.ENTER, R.id.modeSend to AfterDictation.SEND
    )
    private val appIds = mapOf(
        R.id.appModeAuto to AfterDictation.AUTO, R.id.appModeOff to AfterDictation.OFF,
        R.id.appModeEnter to AfterDictation.ENTER, R.id.appModeSend to AfterDictation.SEND
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_voice_settings)
        settings = VoiceKeyboardSettings.from(this)
        appPackage = intent?.getStringExtra(EXTRA_APP_PACKAGE)

        findViewById<RadioGroup>(R.id.modeGroup).setOnCheckedChangeListener { _, id ->
            if (!binding) globalIds[id]?.let { settings.mode = it }
        }
        findViewById<RadioGroup>(R.id.appModeGroup).setOnCheckedChangeListener { _, id ->
            val pkg = appPackage
            if (!binding && pkg != null && id != View.NO_ID) {
                settings.setAppMode(pkg, appIds[id]) // "Same as above" is not in appIds: forgets the app
                bindList()
            }
        }
        bind()
    }

    private fun label(pkg: String): String = try {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    } catch (_: PackageManager.NameNotFoundException) {
        pkg
    }

    private fun modeName(m: AfterDictation): String = getString(
        when (m) {
            AfterDictation.AUTO -> R.string.voice_mode_auto
            AfterDictation.OFF -> R.string.voice_mode_off
            AfterDictation.ENTER -> R.string.voice_mode_enter
            AfterDictation.SEND -> R.string.voice_mode_send
        }
    )

    private fun bind() {
        binding = true
        globalIds.entries.first { it.value == settings.mode }.key.let {
            findViewById<RadioGroup>(R.id.modeGroup).check(it)
        }
        val pkg = appPackage
        findViewById<View>(R.id.appModeSection).visibility = if (pkg == null) View.GONE else View.VISIBLE
        if (pkg != null) {
            findViewById<TextView>(R.id.appModeTitle).text = getString(R.string.voice_app_mode_title, label(pkg))
            val own = settings.appModes()[pkg]
            findViewById<RadioGroup>(R.id.appModeGroup)
                .check(appIds.entries.firstOrNull { it.value == own }?.key ?: R.id.appModeDefault)
        }
        binding = false
        bindList()
    }

    /** The apps with their own mode; tapping one forgets it. */
    private fun bindList() {
        val list = findViewById<android.widget.LinearLayout>(R.id.appModeList)
        list.removeAllViews()
        val modes = settings.appModes()
        findViewById<View>(R.id.appModeEmpty).visibility = if (modes.isEmpty()) View.VISIBLE else View.GONE
        for ((pkg, mode) in modes) {
            list.addView(TextView(this).apply {
                text = "${label(pkg)}: ${modeName(mode)}  ✕"
                textSize = 16f
                minHeight = (48 * resources.displayMetrics.density).toInt()
                gravity = android.view.Gravity.CENTER_VERTICAL
                setTextColor(getColor(R.color.on_surface))
                setOnClickListener {
                    settings.setAppMode(pkg, null)
                    bind()
                }
            })
        }
    }
}
