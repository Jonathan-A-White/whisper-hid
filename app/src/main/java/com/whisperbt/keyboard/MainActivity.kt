package com.whisperbt.keyboard

import android.Manifest
import android.media.AudioManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.google.android.material.bottomnavigation.BottomNavigationView

class MainActivity : AppCompatActivity() {

    companion object {
        private const val PERM_REQUEST_CODE = 1001
        const val PREFS_NAME = "whisper_keyboard_prefs"
        const val KEY_DELAY = "keystroke_delay"
        const val KEY_PORT = "socket_port"
        const val KEY_NEWLINE = "append_newline"
        const val KEY_SPACE = "append_space"
        const val KEY_AUTO_START = "auto_start_boot"
    }

    interface ServiceListener {
        fun onConnectionStateChanged(connected: Boolean, deviceName: String?) {}
        fun onTranscription(text: String) {}
        fun onStatusChanged(status: String) {}
    }

    var hidService: BluetoothHidService? = null
    var socketService: SocketListenerService? = null
    lateinit var db: TranscriptionDatabase

    private lateinit var prefs: SharedPreferences
    private lateinit var bottomNav: BottomNavigationView

    var talkFragment: TalkFragment? = null
        private set
    private var historyFragment: HistoryFragment? = null
    private var settingsFragment: SettingsFragment? = null

    private var hidBound = false
    private var socketBound = false
    private var activeFragment: Fragment? = null
    private var serviceListener: ServiceListener? = null
    private val logBuffer = StringBuilder()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        db = TranscriptionDatabase(this)

        bottomNav = findViewById(R.id.bottomNav)

        // Create or restore fragments using show/hide for state preservation
        if (savedInstanceState == null) {
            talkFragment = TalkFragment()
            historyFragment = HistoryFragment()
            settingsFragment = SettingsFragment()

            supportFragmentManager.beginTransaction()
                .add(R.id.fragmentContainer, settingsFragment!!, "settings")
                .hide(settingsFragment!!)
                .add(R.id.fragmentContainer, historyFragment!!, "history")
                .hide(historyFragment!!)
                .add(R.id.fragmentContainer, talkFragment!!, "talk")
                .commit()
            activeFragment = talkFragment
        } else {
            talkFragment = supportFragmentManager.findFragmentByTag("talk") as? TalkFragment
            historyFragment =
                supportFragmentManager.findFragmentByTag("history") as? HistoryFragment
            settingsFragment =
                supportFragmentManager.findFragmentByTag("settings") as? SettingsFragment
            activeFragment = talkFragment
        }

        bottomNav.setOnItemSelectedListener { item ->
            val selected: Fragment = when (item.itemId) {
                R.id.nav_talk -> talkFragment ?: return@setOnItemSelectedListener false
                R.id.nav_history -> historyFragment ?: return@setOnItemSelectedListener false
                R.id.nav_settings -> settingsFragment ?: return@setOnItemSelectedListener false
                else -> return@setOnItemSelectedListener false
            }
            if (selected != activeFragment) {
                supportFragmentManager.beginTransaction().apply {
                    activeFragment?.let { hide(it) }
                    show(selected)
                }.commit()
                activeFragment = selected
            }
            true
        }

        // Back press returns to Talk tab first
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (bottomNav.selectedItemId != R.id.nav_talk) {
                    bottomNav.selectedItemId = R.id.nav_talk
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        requestPermissions()
        startServices()
    }

    override fun onDestroy() {
        stopServices()
        db.close()
        super.onDestroy()
    }

    override fun onStart() {
        super.onStart()
        bindServices()
    }

    override fun onStop() {
        unbindServices()
        super.onStop()
    }

    fun setServiceListener(listener: ServiceListener?) {
        serviceListener = listener
    }

    fun getPrefs(): SharedPreferences = prefs

    fun appendLog(message: String) {
        logBuffer.append(message).append('\n')
        runOnUiThread {
            settingsFragment?.appendLog(message)
        }
    }

    fun getLogText(): String = logBuffer.toString()

    fun clearLogs() {
        logBuffer.clear()
    }

    fun applySettings() {
        hidService?.keystrokeDelayMs = prefs.getInt(KEY_DELAY, 10).toLong()
        socketService?.setPort(prefs.getInt(KEY_PORT, 9876))
        socketService?.appendNewline = prefs.getBoolean(KEY_NEWLINE, false)
        socketService?.appendSpace = prefs.getBoolean(KEY_SPACE, true)
    }

    // --- Permissions ---

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

    // --- Service lifecycle ---

    private fun startServices() {
        // Enable Bluetooth SCO so termux-microphone-record can use the headset mic
        @Suppress("DEPRECATION")
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).startBluetoothSco()

        val hidIntent = Intent(this, BluetoothHidService::class.java)
        ContextCompat.startForegroundService(this, hidIntent)

        val socketIntent = Intent(this, SocketListenerService::class.java)
        startService(socketIntent)

        bindServices()
        appendLog("Services started")
    }

    private fun stopServices() {
        socketService?.stop()
        unbindServices()

        @Suppress("DEPRECATION")
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).stopBluetoothSco()

        stopService(Intent(this, SocketListenerService::class.java))
        stopService(Intent(this, BluetoothHidService::class.java))

        appendLog("Services stopped")
    }

    private fun bindServices() {
        val hidIntent = Intent(this, BluetoothHidService::class.java)
        bindService(hidIntent, hidConnection, Context.BIND_AUTO_CREATE)

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

    // --- Service connections ---

    private val hidConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            hidService = (service as BluetoothHidService.LocalBinder).getService()
            hidBound = true

            hidService?.keystrokeDelayMs = prefs.getInt(KEY_DELAY, 10).toLong()

            hidService?.connectionCallback = object : BluetoothHidService.ConnectionCallback {
                override fun onConnectionStateChanged(connected: Boolean, deviceName: String?) {
                    runOnUiThread {
                        if (connected) {
                            appendLog("Bluetooth connected: $deviceName")
                            socketService?.flushBuffer()
                        } else {
                            appendLog("Bluetooth disconnected")
                        }
                        serviceListener?.onConnectionStateChanged(connected, deviceName)
                    }
                }

                override fun onHidReady(ready: Boolean) {
                    runOnUiThread {
                        if (ready) {
                            appendLog("HID profile registered — ready for pairing")
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

            socketService?.setPort(prefs.getInt(KEY_PORT, 9876))
            socketService?.appendNewline = prefs.getBoolean(KEY_NEWLINE, false)
            socketService?.appendSpace = prefs.getBoolean(KEY_SPACE, true)
            socketService?.pttMode = true

            socketService?.transcriptionCallback =
                object : SocketListenerService.TranscriptionCallback {
                    override fun onTranscription(text: String) {
                        db.insert(text)
                        runOnUiThread {
                            appendLog("> $text")
                            serviceListener?.onTranscription(text)
                        }
                    }

                    override fun onStatusChanged(status: String) {
                        runOnUiThread { appendLog("[Socket] $status") }
                    }

                    override fun onMicReady() {}
                }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            socketService = null
            socketBound = false
        }
    }
}
