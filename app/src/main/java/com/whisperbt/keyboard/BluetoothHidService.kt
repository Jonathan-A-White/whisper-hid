package com.whisperbt.keyboard

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Foreground service that registers the phone as a Bluetooth HID keyboard
 * and handles sending keystrokes to the connected host (laptop).
 *
 * Usage:
 *   Start via startForegroundService(Intent(context, BluetoothHidService::class.java))
 *   Bind to it with bindService() to get [BluetoothHidBinder] for direct calls.
 */
@SuppressLint("MissingPermission")
class BluetoothHidService : Service() {

    companion object {
        private const val TAG = "BluetoothHidService"

        const val NOTIFICATION_ID = 1001
        const val CHANNEL_ID = "whisper_bt_keyboard"

        // Intent actions for notification buttons
        const val ACTION_TOGGLE_STT = "com.whisperbt.keyboard.TOGGLE_STT"
        const val ACTION_STOP_SERVICE = "com.whisperbt.keyboard.STOP_SERVICE"

        // Extras passed back via broadcasts
        const val EXTRA_STATUS = "status"
        const val BROADCAST_STATUS_CHANGED = "com.whisperbt.keyboard.STATUS_CHANGED"

        // Default inter-keystroke delay in ms to prevent dropped keys
        const val DEFAULT_KEYSTROKE_DELAY_MS = 10L

        // HID report ID (0 = no report ID, single report device)
        const val REPORT_ID: Byte = 0
    }

    inner class BluetoothHidBinder : Binder() {
        fun getService(): BluetoothHidService = this@BluetoothHidService
    }

    private val binder = BluetoothHidBinder()

    // Bluetooth state
    private var bluetoothAdapter: BluetoothAdapter? = null
    private var hidDevice: BluetoothHidDevice? = null
    private var connectedHost: BluetoothDevice? = null
    private var isRegistered = false

    // STT active state (controlled by notification toggle)
    var isSttActive: Boolean = false
        private set

    // Keystroke delay (configurable from MainActivity)
    var keystrokeDelayMs: Long = DEFAULT_KEYSTROKE_DELAY_MS

    // Whether to append a newline after each transcription segment
    var appendNewline: Boolean = true

    // Whether to append a space between segments
    var appendSpace: Boolean = false

    // Executor for sending keystrokes off the main thread
    private val keystrokeExecutor = Executors.newSingleThreadExecutor()

    // ──────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ──────────────────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "onCreate")
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        initBluetooth()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TOGGLE_STT -> {
                isSttActive = !isSttActive
                Log.i(TAG, "STT toggled: $isSttActive")
                updateNotification()
                broadcastStatus()
            }
            ACTION_STOP_SERVICE -> {
                Log.i(TAG, "Stop requested via notification")
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        super.onDestroy()
        Log.i(TAG, "onDestroy — unregistering HID app")
        hidDevice?.unregisterApp()
        keystrokeExecutor.shutdown()
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Bluetooth HID setup
    // ──────────────────────────────────────────────────────────────────────────

    private fun initBluetooth() {
        val bm = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        bluetoothAdapter = bm.adapter
        if (bluetoothAdapter == null || !bluetoothAdapter!!.isEnabled) {
            Log.e(TAG, "Bluetooth not available or disabled")
            return
        }
        bluetoothAdapter!!.getProfileProxy(this, profileListener, BluetoothProfile.HID_DEVICE)
    }

    private val profileListener = object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
            if (profile == BluetoothProfile.HID_DEVICE) {
                hidDevice = proxy as BluetoothHidDevice
                Log.i(TAG, "HID profile connected — registering app")
                registerHidApp()
            }
        }

        override fun onServiceDisconnected(profile: Int) {
            if (profile == BluetoothProfile.HID_DEVICE) {
                hidDevice = null
                isRegistered = false
                Log.w(TAG, "HID profile disconnected")
            }
        }
    }

    private fun registerHidApp() {
        val sdp = BluetoothHidDeviceAppSdpSettings(
            "Whisper Keyboard",
            "Speech-to-text Bluetooth keyboard",
            "WhisperBT",
            BluetoothHidDevice.SUBCLASS1_KEYBOARD,
            HidKeyMapper.HID_KEYBOARD_DESCRIPTOR
        )

        hidDevice?.registerApp(sdp, null, null, mainExecutor, hidCallback)
            ?: Log.e(TAG, "hidDevice is null — cannot register")
    }

    private val hidCallback = object : BluetoothHidDevice.Callback() {
        override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, registered: Boolean) {
            isRegistered = registered
            Log.i(TAG, "HID app registered: $registered, pluggedDevice=$pluggedDevice")
            updateNotification()
            broadcastStatus()
        }

        override fun onConnectionStateChanged(device: BluetoothDevice, state: Int) {
            val stateName = when (state) {
                BluetoothProfile.STATE_CONNECTED    -> "CONNECTED"
                BluetoothProfile.STATE_CONNECTING   -> "CONNECTING"
                BluetoothProfile.STATE_DISCONNECTED -> "DISCONNECTED"
                BluetoothProfile.STATE_DISCONNECTING -> "DISCONNECTING"
                else -> "UNKNOWN($state)"
            }
            Log.i(TAG, "Connection state: $stateName — device=${device.name}")

            connectedHost = if (state == BluetoothProfile.STATE_CONNECTED) device else null
            updateNotification()
            broadcastStatus()
        }

        override fun onGetReport(device: BluetoothDevice, type: Byte, id: Byte, bufferSize: Int) {
            // Respond to GET_REPORT with an empty key-up report
            hidDevice?.replyReport(device, type, id, HidKeyMapper.buildKeyUpReport())
        }

        override fun onSetReport(device: BluetoothDevice, type: Byte, id: Byte, data: ByteArray) {
            // LED state from host (Num Lock, Caps Lock, etc.) — ignore for now
            hidDevice?.reportError(device, BluetoothHidDevice.ERROR_RSP_SUCCESS)
        }

        override fun onSetProtocol(device: BluetoothDevice, protocol: Byte) {
            Log.d(TAG, "onSetProtocol: $protocol")
        }

        override fun onInterruptData(device: BluetoothDevice, reportId: Byte, data: ByteArray) {
            // Host-to-device data on the interrupt pipe — not needed for keyboard output only
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Keystroke sending
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Type [text] as Bluetooth HID keystrokes.
     * This must not be called on the main thread — use [keystrokeExecutor].
     * Appends a newline or space if configured.
     */
    fun typeText(text: String) {
        if (!isSttActive) {
            Log.d(TAG, "STT inactive — ignoring text: $text")
            return
        }
        val fullText = buildString {
            append(text)
            if (appendNewline) append('\n')
            else if (appendSpace) append(' ')
        }
        keystrokeExecutor.submit { sendTextBlocking(fullText) }
    }

    /**
     * Send [text] as keystrokes synchronously on the caller's thread.
     * Blocks between each keystroke by [keystrokeDelayMs].
     */
    private fun sendTextBlocking(text: String) {
        val host = connectedHost
        val hid = hidDevice
        if (host == null || hid == null) {
            Log.w(TAG, "No connected host — buffering not yet implemented, dropping: $text")
            return
        }

        for (c in text) {
            val key = HidKeyMapper.charToHidKey(c)
            if (key == null) {
                Log.v(TAG, "No HID mapping for char: $c (${c.code})")
                continue
            }

            val downReport = HidKeyMapper.buildKeyDownReport(key)
            val upReport   = HidKeyMapper.buildKeyUpReport()

            val sent = hid.sendReport(host, REPORT_ID.toInt(), downReport)
            if (!sent) Log.w(TAG, "sendReport failed (key-down) for '$c'")

            TimeUnit.MILLISECONDS.sleep(keystrokeDelayMs)

            hid.sendReport(host, REPORT_ID.toInt(), upReport)

            TimeUnit.MILLISECONDS.sleep(keystrokeDelayMs)
        }
    }

    /**
     * Send a single [Backspace] key [count] times.
     */
    fun sendBackspace(count: Int) {
        keystrokeExecutor.submit {
            val host = connectedHost ?: return@submit
            val hid  = hidDevice   ?: return@submit
            val down = HidKeyMapper.buildKeyDownReport(
                HidKeyMapper.HidKey(HidKeyMapper.MOD_NONE, HidKeyMapper.KEY_BACKSPACE)
            )
            val up = HidKeyMapper.buildKeyUpReport()
            repeat(count) {
                hid.sendReport(host, REPORT_ID.toInt(), down)
                TimeUnit.MILLISECONDS.sleep(keystrokeDelayMs)
                hid.sendReport(host, REPORT_ID.toInt(), up)
                TimeUnit.MILLISECONDS.sleep(keystrokeDelayMs)
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Status helpers
    // ──────────────────────────────────────────────────────────────────────────

    fun getStatusSummary(): String = buildString {
        append(if (isRegistered) "HID registered" else "HID not registered")
        append(" | ")
        val host = connectedHost
        if (host != null) {
            append("Connected to ${host.name ?: host.address}")
        } else {
            append("Not connected")
        }
        append(" | STT: ${if (isSttActive) "active" else "paused"}")
    }

    private fun broadcastStatus() {
        val intent = Intent(BROADCAST_STATUS_CHANGED).apply {
            putExtra(EXTRA_STATUS, getStatusSummary())
        }
        sendBroadcast(intent)
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Notification
    // ──────────────────────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Whisper BT Keyboard",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Bluetooth keyboard foreground service"
        }
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val openAppPi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        val togglePi = PendingIntent.getService(
            this, 1,
            Intent(this, BluetoothHidService::class.java).setAction(ACTION_TOGGLE_STT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val stopPi = PendingIntent.getService(
            this, 2,
            Intent(this, BluetoothHidService::class.java).setAction(ACTION_STOP_SERVICE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val host = connectedHost
        val contentText = if (host != null) {
            "Connected to ${host.name ?: host.address}"
        } else {
            "Waiting for Bluetooth connection…"
        }

        val toggleLabel = if (isSttActive) "Pause STT" else "Resume STT"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Whisper Keyboard ${if (isSttActive) "●" else "○"}")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(openAppPi)
            .setOngoing(true)
            .addAction(0, toggleLabel, togglePi)
            .addAction(0, "Stop", stopPi)
            .build()
    }

    private fun updateNotification() {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification())
    }
}
