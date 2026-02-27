package com.whisperbt.keyboard

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    companion object {
        private const val PERM_REQUEST_CODE = 1001
        private const val PREFS_NAME = "whisper_keyboard_prefs"
        private const val KEY_DELAY = "keystroke_delay"
        private const val KEY_PORT = "socket_port"
        private const val KEY_NEWLINE = "append_newline"
        private const val KEY_SPACE = "append_space"
    }

    private lateinit var prefs: SharedPreferences
    private lateinit var statusText: TextView
    private lateinit var logText: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var toggleButton: Button
    private lateinit var pairButton: Button
    private lateinit var delayInput: EditText
    private lateinit var portInput: EditText
    private lateinit var newlineCheckbox: CheckBox
    private lateinit var spaceCheckbox: CheckBox

    private var hidService: BluetoothHidService? = null
    private var socketService: SocketListenerService? = null
    private var hidBound = false
    private var socketBound = false
    private var servicesRunning = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)

        statusText = findViewById(R.id.statusText)
        logText = findViewById(R.id.logText)
        logScroll = findViewById(R.id.logScroll)
        toggleButton = findViewById(R.id.toggleButton)
        pairButton = findViewById(R.id.pairButton)
        delayInput = findViewById(R.id.delayInput)
        portInput = findViewById(R.id.portInput)
        newlineCheckbox = findViewById(R.id.newlineCheckbox)
        spaceCheckbox = findViewById(R.id.spaceCheckbox)

        // Load saved preferences
        delayInput.setText(prefs.getInt(KEY_DELAY, 10).toString())
        portInput.setText(prefs.getInt(KEY_PORT, 9876).toString())
        newlineCheckbox.isChecked = prefs.getBoolean(KEY_NEWLINE, false)
        spaceCheckbox.isChecked = prefs.getBoolean(KEY_SPACE, true)

        toggleButton.setOnClickListener { toggleServices() }
        pairButton.setOnClickListener { openBluetoothSettings() }

        requestPermissions()
    }

    override fun onStart() {
        super.onStart()
        if (servicesRunning) {
            bindServices()
        }
    }

    override fun onStop() {
        unbindServices()
        savePreferences()
        super.onStop()
    }

    private fun requestPermissions() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.BLUETOOTH_SCAN)
            }
        }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERM_REQUEST_CODE)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERM_REQUEST_CODE) {
            val denied = grantResults.any { it != PackageManager.PERMISSION_GRANTED }
            if (denied) {
                Toast.makeText(this, "Bluetooth permissions are required", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun toggleServices() {
        if (servicesRunning) {
            stopServices()
        } else {
            startServices()
        }
    }

    private fun startServices() {
        savePreferences()

        // Start BluetoothHidService as foreground service
        val hidIntent = Intent(this, BluetoothHidService::class.java)
        ContextCompat.startForegroundService(this, hidIntent)

        // Start SocketListenerService
        val socketIntent = Intent(this, SocketListenerService::class.java)
        startService(socketIntent)

        bindServices()
        servicesRunning = true
        toggleButton.text = getString(R.string.stop)
        appendLog("Services started")
    }

    private fun stopServices() {
        socketService?.stop()
        unbindServices()

        stopService(Intent(this, SocketListenerService::class.java))
        stopService(Intent(this, BluetoothHidService::class.java))

        servicesRunning = false
        toggleButton.text = getString(R.string.start)
        statusText.text = getString(R.string.status_stopped)
        appendLog("Services stopped")
    }

    private fun bindServices() {
        // Bind HID service
        val hidIntent = Intent(this, BluetoothHidService::class.java)
        bindService(hidIntent, hidConnection, Context.BIND_AUTO_CREATE)

        // Bind Socket service
        val socketIntent = Intent(this, SocketListenerService::class.java)
        bindService(socketIntent, socketConnection, Context.BIND_AUTO_CREATE)
    }

    private fun unbindServices() {
        if (hidBound) {
            hidService?.connectionCallback = null
            unbindService(hidConnection)
            hidBound = false
        }
        if (socketBound) {
            socketService?.transcriptionCallback = null
            unbindService(socketConnection)
            socketBound = false
        }
    }

    private val hidConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            hidService = (service as BluetoothHidService.LocalBinder).getService()
            hidBound = true

            hidService?.keystrokeDelayMs = delayInput.text.toString().toLongOrNull() ?: 10L

            hidService?.connectionCallback = object : BluetoothHidService.ConnectionCallback {
                override fun onConnectionStateChanged(connected: Boolean, deviceName: String?) {
                    runOnUiThread {
                        if (connected) {
                            statusText.text = "Connected to $deviceName"
                            appendLog("Bluetooth connected: $deviceName")
                            // Flush any text that was buffered while waiting for BT
                            socketService?.flushBuffer()
                        } else {
                            statusText.text = getString(R.string.status_disconnected)
                            appendLog("Bluetooth disconnected")
                        }
                    }
                }

                override fun onHidReady(ready: Boolean) {
                    runOnUiThread {
                        if (ready) {
                            appendLog("HID profile registered — ready for pairing")
                            statusText.text = getString(R.string.status_ready)
                            // Start socket listener once HID is ready
                            socketService?.start()
                        } else {
                            appendLog("HID profile registration failed")
                        }
                    }
                }
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            hidService = null
            hidBound = false
        }
    }

    private val socketConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            socketService = (service as SocketListenerService.LocalBinder).getService()
            socketBound = true

            socketService?.setPort(portInput.text.toString().toIntOrNull() ?: 9876)
            socketService?.appendNewline = newlineCheckbox.isChecked
            socketService?.appendSpace = spaceCheckbox.isChecked

            socketService?.transcriptionCallback = object : SocketListenerService.TranscriptionCallback {
                override fun onTranscription(text: String) {
                    runOnUiThread { appendLog("> $text") }
                }

                override fun onStatusChanged(status: String) {
                    runOnUiThread { appendLog("[Socket] $status") }
                }
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            socketService = null
            socketBound = false
        }
    }

    private fun openBluetoothSettings() {
        val intent = Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).apply {
            putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 120)
        }
        try {
            startActivity(intent)
        } catch (_: SecurityException) {
            // Fall back to general Bluetooth settings
            startActivity(Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS))
        }
    }

    private fun savePreferences() {
        prefs.edit().apply {
            putInt(KEY_DELAY, delayInput.text.toString().toIntOrNull() ?: 10)
            putInt(KEY_PORT, portInput.text.toString().toIntOrNull() ?: 9876)
            putBoolean(KEY_NEWLINE, newlineCheckbox.isChecked)
            putBoolean(KEY_SPACE, spaceCheckbox.isChecked)
            apply()
        }
    }

    private fun appendLog(message: String) {
        logText.append("$message\n")
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
