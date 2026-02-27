package com.whisperbt.keyboard

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
import java.util.concurrent.Executors

class BluetoothHidService : Service() {

    companion object {
        private const val TAG = "BtHidService"
        private const val CHANNEL_ID = "whisper_keyboard_channel"
        private const val NOTIFICATION_ID = 1
        private const val REPORT_ID: Byte = 1

        // Standard USB HID keyboard descriptor (boot protocol compatible).
        // Defines an 8-byte input report: [modifier, reserved, key1..key6]
        // and a 1-byte output report (LEDs).
        private val HID_DESCRIPTOR = byteArrayOf(
            0x05.toByte(), 0x01.toByte(), // Usage Page (Generic Desktop)
            0x09.toByte(), 0x06.toByte(), // Usage (Keyboard)
            0xA1.toByte(), 0x01.toByte(), // Collection (Application)
            0x85.toByte(), REPORT_ID,     //   Report ID (1)

            // Modifier keys (8 bits)
            0x05.toByte(), 0x07.toByte(), //   Usage Page (Key Codes)
            0x19.toByte(), 0xE0.toByte(), //   Usage Minimum (224) - Left Control
            0x29.toByte(), 0xE7.toByte(), //   Usage Maximum (231) - Right GUI
            0x15.toByte(), 0x00.toByte(), //   Logical Minimum (0)
            0x25.toByte(), 0x01.toByte(), //   Logical Maximum (1)
            0x75.toByte(), 0x01.toByte(), //   Report Size (1)
            0x95.toByte(), 0x08.toByte(), //   Report Count (8)
            0x81.toByte(), 0x02.toByte(), //   Input (Data, Variable, Absolute)

            // Reserved byte
            0x75.toByte(), 0x08.toByte(), //   Report Size (8)
            0x95.toByte(), 0x01.toByte(), //   Report Count (1)
            0x81.toByte(), 0x01.toByte(), //   Input (Constant)

            // LED output report (for host keyboard LEDs)
            0x05.toByte(), 0x08.toByte(), //   Usage Page (LEDs)
            0x19.toByte(), 0x01.toByte(), //   Usage Minimum (1)
            0x29.toByte(), 0x05.toByte(), //   Usage Maximum (5)
            0x75.toByte(), 0x01.toByte(), //   Report Size (1)
            0x95.toByte(), 0x05.toByte(), //   Report Count (5)
            0x91.toByte(), 0x02.toByte(), //   Output (Data, Variable, Absolute)
            // LED padding
            0x75.toByte(), 0x03.toByte(), //   Report Size (3)
            0x95.toByte(), 0x01.toByte(), //   Report Count (1)
            0x91.toByte(), 0x01.toByte(), //   Output (Constant)

            // Key array (6 keys)
            0x05.toByte(), 0x07.toByte(), //   Usage Page (Key Codes)
            0x19.toByte(), 0x00.toByte(), //   Usage Minimum (0)
            0x29.toByte(), 0xFF.toByte(), //   Usage Maximum (255)
            0x15.toByte(), 0x00.toByte(), //   Logical Minimum (0)
            0x26.toByte(), 0xFF.toByte(), 0x00.toByte(), // Logical Maximum (255)
            0x75.toByte(), 0x08.toByte(), //   Report Size (8)
            0x95.toByte(), 0x06.toByte(), //   Report Count (6)
            0x81.toByte(), 0x00.toByte(), //   Input (Data, Array)

            0xC0.toByte()                 // End Collection
        )
    }

    interface ConnectionCallback {
        fun onConnectionStateChanged(connected: Boolean, deviceName: String?)
        fun onHidReady(ready: Boolean)
    }

    private val binder = LocalBinder()
    private var btAdapter: BluetoothAdapter? = null
    private var hidDevice: BluetoothHidDevice? = null
    private var connectedDevice: BluetoothDevice? = null
    private var isRegistered = false
    var connectionCallback: ConnectionCallback? = null
    var keystrokeDelayMs: Long = 10L

    private val executor = Executors.newSingleThreadExecutor()

    inner class LocalBinder : Binder() {
        fun getService(): BluetoothHidService = this@BluetoothHidService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Initializing..."))

        val btManager = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        btAdapter = btManager.adapter
        if (btAdapter == null) {
            Log.e(TAG, "Bluetooth not available")
            stopSelf()
            return
        }
        registerHidDevice()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        unregisterHidDevice()
        executor.shutdown()
        super.onDestroy()
    }

    private fun registerHidDevice() {
        val adapter = btAdapter ?: return
        try {
            adapter.getProfileProxy(this, object : BluetoothProfile.ServiceListener {
                override fun onServiceConnected(profile: Int, proxy: BluetoothProfile?) {
                    if (profile == BluetoothProfile.HID_DEVICE) {
                        hidDevice = proxy as BluetoothHidDevice
                        registerApp()
                    }
                }

                override fun onServiceDisconnected(profile: Int) {
                    if (profile == BluetoothProfile.HID_DEVICE) {
                        hidDevice = null
                        isRegistered = false
                        connectionCallback?.onHidReady(false)
                    }
                }
            }, BluetoothProfile.HID_DEVICE)
        } catch (e: SecurityException) {
            Log.e(TAG, "Missing Bluetooth permission", e)
        }
    }

    private fun registerApp() {
        val hid = hidDevice ?: return
        val sdp = BluetoothHidDeviceAppSdpSettings(
            "Whisper Keyboard",
            "Speech-to-text Bluetooth keyboard",
            "WhisperBT",
            BluetoothHidDevice.SUBCLASS1_KEYBOARD,
            HID_DESCRIPTOR
        )
        try {
            hid.registerApp(sdp, null, null, executor, hidCallback)
        } catch (e: SecurityException) {
            Log.e(TAG, "Missing Bluetooth permission for registerApp", e)
        }
    }

    private fun unregisterHidDevice() {
        try {
            hidDevice?.unregisterApp()
        } catch (e: SecurityException) {
            Log.e(TAG, "Missing Bluetooth permission for unregisterApp", e)
        }
        hidDevice = null
        isRegistered = false
    }

    private val hidCallback = object : BluetoothHidDevice.Callback() {
        override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, registered: Boolean) {
            isRegistered = registered
            Log.i(TAG, "HID app registered: $registered")
            connectionCallback?.onHidReady(registered)
            updateNotification(if (registered) "Ready — waiting for connection" else "Registration failed")
        }

        override fun onConnectionStateChanged(device: BluetoothDevice?, state: Int) {
            when (state) {
                BluetoothProfile.STATE_CONNECTED -> {
                    connectedDevice = device
                    val name = try { device?.name } catch (_: SecurityException) { "Unknown" }
                    Log.i(TAG, "Connected to $name")
                    connectionCallback?.onConnectionStateChanged(true, name)
                    updateNotification("Connected to $name")
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    connectedDevice = null
                    Log.i(TAG, "Disconnected")
                    connectionCallback?.onConnectionStateChanged(false, null)
                    updateNotification("Disconnected")
                }
            }
        }

        override fun onGetReport(device: BluetoothDevice?, type: Byte, id: Byte, bufferSize: Int) {
            try {
                hidDevice?.replyReport(device, type, id, ByteArray(8))
            } catch (e: SecurityException) {
                Log.e(TAG, "Missing permission for replyReport", e)
            }
        }

        override fun onSetReport(device: BluetoothDevice?, type: Byte, id: Byte, data: ByteArray?) {
            // Host is setting LED state — acknowledge but ignore
        }
    }

    /**
     * Send a string as a sequence of HID keystrokes to the connected device.
     * Each character is sent as key-down then key-up with a configurable delay.
     */
    fun sendString(text: String) {
        val device = connectedDevice ?: return
        val hid = hidDevice ?: return

        executor.execute {
            for (char in text) {
                val report = HidKeyMapper.map(char) ?: continue
                try {
                    hid.sendReport(device, REPORT_ID.toInt(), HidKeyMapper.toBytes(report))
                    Thread.sleep(keystrokeDelayMs)
                    hid.sendReport(device, REPORT_ID.toInt(), HidKeyMapper.KEY_UP_REPORT)
                    Thread.sleep(keystrokeDelayMs)
                } catch (e: SecurityException) {
                    Log.e(TAG, "Missing permission for sendReport", e)
                    return@execute
                }
            }
        }
    }

    /** Send N backspace keystrokes. */
    fun sendBackspace(count: Int) {
        val device = connectedDevice ?: return
        val hid = hidDevice ?: return
        val report = HidKeyMapper.backspaceReport()

        executor.execute {
            repeat(count) {
                try {
                    hid.sendReport(device, REPORT_ID.toInt(), HidKeyMapper.toBytes(report))
                    Thread.sleep(keystrokeDelayMs)
                    hid.sendReport(device, REPORT_ID.toInt(), HidKeyMapper.KEY_UP_REPORT)
                    Thread.sleep(keystrokeDelayMs)
                } catch (e: SecurityException) {
                    Log.e(TAG, "Missing permission for sendReport", e)
                    return@execute
                }
            }
        }
    }

    fun isConnected(): Boolean = connectedDevice != null

    fun getConnectedDeviceName(): String? = try {
        connectedDevice?.name
    } catch (_: SecurityException) {
        null
    }

    // --- Notification helpers ---

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Whisper Keyboard",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Bluetooth HID keyboard status"
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(status: String): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            this, 0, intent, PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Whisper Keyboard")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(status: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(status))
    }
}
