package com.whisperbt.keyboard

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Settings
import android.text.format.DateFormat
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.whisperbt.keyboard.databinding.ActivityMainBinding
import java.util.Date

/**
 * Main activity — minimal UI for status monitoring and settings.
 *
 * Functionality:
 *  - Start/Stop the foreground services
 *  - Show connection status and recent log lines
 *  - Settings: keystroke delay, port, newline/space append, auto-start
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val PREFS_NAME = "whisper_bt_prefs"
        private const val PREF_PORT = "port"
        private const val PREF_DELAY = "keystroke_delay_ms"
        private const val PREF_NEWLINE = "append_newline"
        private const val PREF_SPACE = "append_space"
        private const val PREF_AUTOSTART = "auto_start"
        private const val MAX_LOG_LINES = 200
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: SharedPreferences

    private var hidService: BluetoothHidService? = null
    private var servicesBound = false

    private val logLines = ArrayDeque<String>(MAX_LOG_LINES)

    // ──────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ──────────────────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        setupUi()
        loadPrefsIntoUi()
        registerReceivers()
    }

    override fun onResume() {
        super.onResume()
        updateBluetoothStatus()
    }

    override fun onDestroy() {
        super.onDestroy()
        unregisterReceivers()
        if (servicesBound) {
            unbindService(hidServiceConnection)
            servicesBound = false
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // UI setup
    // ──────────────────────────────────────────────────────────────────────────

    private fun setupUi() {
        // Start/Stop services button
        binding.btnToggleService.setOnClickListener {
            if (servicesBound && hidService != null) {
                stopServices()
            } else {
                startServices()
            }
        }

        // Open Bluetooth settings for pairing
        binding.btnPairDevice.setOnClickListener {
            startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
        }

        // Save settings on change
        binding.btnSaveSettings.setOnClickListener {
            saveSettings()
            Toast.makeText(this, "Settings saved", Toast.LENGTH_SHORT).show()
        }
    }

    private fun loadPrefsIntoUi() {
        binding.etPort.setText(prefs.getInt(PREF_PORT, SocketListenerService.DEFAULT_PORT).toString())
        binding.etKeystrokeDelay.setText(prefs.getLong(PREF_DELAY, BluetoothHidService.DEFAULT_KEYSTROKE_DELAY_MS).toString())
        binding.switchNewline.isChecked = prefs.getBoolean(PREF_NEWLINE, true)
        binding.switchSpace.isChecked = prefs.getBoolean(PREF_SPACE, false)
        binding.switchAutoStart.isChecked = prefs.getBoolean(PREF_AUTOSTART, false)
    }

    private fun saveSettings() {
        val port = binding.etPort.text.toString().toIntOrNull() ?: SocketListenerService.DEFAULT_PORT
        val delay = binding.etKeystrokeDelay.text.toString().toLongOrNull() ?: BluetoothHidService.DEFAULT_KEYSTROKE_DELAY_MS
        val newline = binding.switchNewline.isChecked
        val space = binding.switchSpace.isChecked
        val autoStart = binding.switchAutoStart.isChecked

        prefs.edit()
            .putInt(PREF_PORT, port)
            .putLong(PREF_DELAY, delay)
            .putBoolean(PREF_NEWLINE, newline)
            .putBoolean(PREF_SPACE, space)
            .putBoolean(PREF_AUTOSTART, autoStart)
            .apply()

        // Push live settings into bound service if running
        hidService?.apply {
            keystrokeDelayMs = delay
            appendNewline = newline
            appendSpace = space
        }
    }

    private fun updateBluetoothStatus() {
        val bm = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val adapter: BluetoothAdapter? = bm.adapter
        val status = when {
            adapter == null     -> "Bluetooth not supported"
            !adapter.isEnabled  -> "Bluetooth OFF"
            servicesBound       -> hidService?.getStatusSummary() ?: "Service running"
            else                -> "Services stopped"
        }
        binding.tvStatus.text = status
        binding.btnToggleService.text = if (servicesBound) "Stop Services" else "Start Services"
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Service management
    // ──────────────────────────────────────────────────────────────────────────

    private fun startServices() {
        val port = prefs.getInt(PREF_PORT, SocketListenerService.DEFAULT_PORT)

        // Start BluetoothHidService as foreground service
        val hidIntent = Intent(this, BluetoothHidService::class.java)
        startForegroundService(hidIntent)

        // Bind to get a reference for status updates
        bindService(hidIntent, hidServiceConnection, Context.BIND_AUTO_CREATE)

        // Start SocketListenerService
        val socketIntent = Intent(this, SocketListenerService::class.java).apply {
            putExtra(SocketListenerService.EXTRA_PORT, port)
        }
        startService(socketIntent)

        appendLog("Services started")
        updateBluetoothStatus()
    }

    private fun stopServices() {
        if (servicesBound) {
            unbindService(hidServiceConnection)
            servicesBound = false
        }
        hidService = null

        stopService(Intent(this, BluetoothHidService::class.java))
        stopService(Intent(this, SocketListenerService::class.java))

        appendLog("Services stopped")
        updateBluetoothStatus()
    }

    private val hidServiceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            hidService = (service as BluetoothHidService.BluetoothHidBinder).getService()
            servicesBound = true

            // Push current prefs into the live service
            saveSettings()
            updateBluetoothStatus()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            hidService = null
            servicesBound = false
            updateBluetoothStatus()
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Broadcast receivers
    // ──────────────────────────────────────────────────────────────────────────

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val status = intent.getStringExtra(BluetoothHidService.EXTRA_STATUS) ?: return
            binding.tvStatus.text = status
        }
    }

    private val logReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val line = intent.getStringExtra(SocketListenerService.EXTRA_LOG_LINE) ?: return
            appendLog(line)
        }
    }

    private fun registerReceivers() {
        val statusFilter = IntentFilter(BluetoothHidService.BROADCAST_STATUS_CHANGED)
        val logFilter    = IntentFilter(SocketListenerService.BROADCAST_LOG)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, statusFilter, RECEIVER_NOT_EXPORTED)
            registerReceiver(logReceiver, logFilter, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(statusReceiver, statusFilter)
            registerReceiver(logReceiver, logFilter)
        }
    }

    private fun unregisterReceivers() {
        runCatching { unregisterReceiver(statusReceiver) }
        runCatching { unregisterReceiver(logReceiver) }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Log view
    // ──────────────────────────────────────────────────────────────────────────

    private fun appendLog(message: String) {
        val timestamp = DateFormat.format("HH:mm:ss", Date()).toString()
        val line = "[$timestamp] $message"

        if (logLines.size >= MAX_LOG_LINES) logLines.removeFirst()
        logLines.addLast(line)

        binding.tvLog.text = logLines.joinToString("\n")
        binding.scrollLog.post { binding.scrollLog.fullScroll(android.view.View.FOCUS_DOWN) }
    }
}
