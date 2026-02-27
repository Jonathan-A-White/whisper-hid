package com.whisperbt.keyboard

import android.bluetooth.BluetoothAdapter
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment

class SettingsFragment : Fragment() {

    private lateinit var delayInput: EditText
    private lateinit var portInput: EditText
    private lateinit var newlineCheckbox: CheckBox
    private lateinit var spaceCheckbox: CheckBox
    private lateinit var autoStartCheckbox: CheckBox
    private lateinit var pairButton: Button
    private lateinit var copyLogsButton: Button
    private lateinit var clearLogsButton: Button
    private lateinit var logText: TextView
    private lateinit var logScroll: ScrollView

    private val mainActivity get() = activity as? MainActivity

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View? {
        return inflater.inflate(R.layout.fragment_settings, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        delayInput = view.findViewById(R.id.delayInput)
        portInput = view.findViewById(R.id.portInput)
        newlineCheckbox = view.findViewById(R.id.newlineCheckbox)
        spaceCheckbox = view.findViewById(R.id.spaceCheckbox)
        autoStartCheckbox = view.findViewById(R.id.autoStartCheckbox)
        pairButton = view.findViewById(R.id.pairButton)
        copyLogsButton = view.findViewById(R.id.copyLogsButton)
        clearLogsButton = view.findViewById(R.id.clearLogsButton)
        logText = view.findViewById(R.id.logText)
        logScroll = view.findViewById(R.id.logScroll)

        loadPreferences()

        pairButton.setOnClickListener { openBluetoothSettings() }

        copyLogsButton.setOnClickListener {
            val clipboard =
                requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(
                ClipData.newPlainText("Whisper Keyboard Logs", logText.text)
            )
            Toast.makeText(requireContext(), R.string.logs_copied, Toast.LENGTH_SHORT).show()
        }

        clearLogsButton.setOnClickListener {
            mainActivity?.clearLogs()
            logText.text = ""
        }
    }

    override fun onResume() {
        super.onResume()
        if (!isHidden) refreshLogs()
    }

    override fun onPause() {
        savePreferences()
        super.onPause()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) refreshLogs()
        else savePreferences()
    }

    fun refreshLogs() {
        if (!isAdded) return
        logText.text = mainActivity?.getLogText() ?: ""
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    fun appendLog(message: String) {
        if (!isAdded) return
        logText.append("$message\n")
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    private fun loadPreferences() {
        val prefs = mainActivity?.getPrefs() ?: return
        delayInput.setText(prefs.getInt(MainActivity.KEY_DELAY, 10).toString())
        portInput.setText(prefs.getInt(MainActivity.KEY_PORT, 9876).toString())
        newlineCheckbox.isChecked = prefs.getBoolean(MainActivity.KEY_NEWLINE, false)
        spaceCheckbox.isChecked = prefs.getBoolean(MainActivity.KEY_SPACE, true)
        autoStartCheckbox.isChecked = prefs.getBoolean(MainActivity.KEY_AUTO_START, false)
    }

    private fun savePreferences() {
        val prefs = mainActivity?.getPrefs() ?: return
        prefs.edit().apply {
            putInt(MainActivity.KEY_DELAY, delayInput.text.toString().toIntOrNull() ?: 10)
            putInt(MainActivity.KEY_PORT, portInput.text.toString().toIntOrNull() ?: 9876)
            putBoolean(MainActivity.KEY_NEWLINE, newlineCheckbox.isChecked)
            putBoolean(MainActivity.KEY_SPACE, spaceCheckbox.isChecked)
            putBoolean(MainActivity.KEY_AUTO_START, autoStartCheckbox.isChecked)
            apply()
        }
        mainActivity?.applySettings()
    }

    private fun openBluetoothSettings() {
        val intent = Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).apply {
            putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 120)
        }
        try {
            startActivity(intent)
        } catch (_: SecurityException) {
            startActivity(Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS))
        }
    }
}
