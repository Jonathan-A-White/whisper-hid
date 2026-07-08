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
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

class BluetoothHidService : Service() {

    companion object {
        private const val TAG = "BtHidService"
        private const val CHANNEL_ID = "whisper_keyboard_channel"
        private const val NOTIFICATION_ID = 1
        private const val REPORT_ID: Byte = 1
        private const val HTTP_PORT = 9877
        private const val MAX_LOG_ENTRIES = 200
        private const val ALLOWED_ORIGIN = "https://jonathan-a-white.github.io"

        // Reconnect schedule: 2s, 4s, 8s, 16s, 30s, then 30s intervals up to 5 min
        private val RECONNECT_DELAYS_MS = longArrayOf(2000, 4000, 8000, 16000, 30000)
        private const val RECONNECT_SLOW_MS = 30000L
        private const val RECONNECT_MAX_DURATION_MS = 5 * 60 * 1000L

        // SCO startup often fails right after the headset profile connects — retry
        private const val SCO_RETRY_DELAY_MS = 3000L
        private const val SCO_MAX_RETRIES = 5

        // Headset mic enable flag persists across service restarts so a
        // restart mid-call doesn't snatch the headset back from the laptop.
        private const val PREFS_NAME = "whisper_hid_prefs"
        private const val KEY_HEADSET_MIC_ENABLED = "headset_mic_enabled"

        // A BT HID host silently drops input reports for a short window right
        // after STATE_CONNECTED (it's still re-enumerating / setting up the
        // input pipe). sendReport() succeeds at the link layer, so the leading
        // keystrokes look sent but never reach the host — the message arrives
        // truncated at the front. Hold off the first keystroke until the link
        // has settled. Only the first send after a (re)connect pays this cost;
        // warm-link sends see zero added latency.
        private const val CONNECT_SETTLE_MS = 1500L

        // Retry budget for a sendReport() the stack refuses to queue
        // (see sendReportReliably).
        private const val SEND_RETRY_ATTEMPTS = 4
        private const val SEND_RETRY_BACKOFF_MS = 20L

        // Bigger budget for the all-keys-up release: losing it leaves a key
        // held at the host, which auto-repeats it forever (see releaseAllKeys).
        private const val RELEASE_RETRY_ATTEMPTS = 10
        private const val RELEASE_RETRY_BACKOFF_MS = 50L

        // Standard USB HID keyboard descriptor (boot protocol compatible).
        private val HID_DESCRIPTOR = byteArrayOf(
            0x05.toByte(), 0x01.toByte(), // Usage Page (Generic Desktop)
            0x09.toByte(), 0x06.toByte(), // Usage (Keyboard)
            0xA1.toByte(), 0x01.toByte(), // Collection (Application)
            0x85.toByte(), REPORT_ID,     //   Report ID (1)
            // Modifier keys (8 bits)
            0x05.toByte(), 0x07.toByte(), //   Usage Page (Key Codes)
            0x19.toByte(), 0xE0.toByte(), //   Usage Minimum (224)
            0x29.toByte(), 0xE7.toByte(), //   Usage Maximum (231)
            0x15.toByte(), 0x00.toByte(), //   Logical Minimum (0)
            0x25.toByte(), 0x01.toByte(), //   Logical Maximum (1)
            0x75.toByte(), 0x01.toByte(), //   Report Size (1)
            0x95.toByte(), 0x08.toByte(), //   Report Count (8)
            0x81.toByte(), 0x02.toByte(), //   Input (Data, Variable, Absolute)
            // Reserved byte
            0x75.toByte(), 0x08.toByte(), //   Report Size (8)
            0x95.toByte(), 0x01.toByte(), //   Report Count (1)
            0x81.toByte(), 0x01.toByte(), //   Input (Constant)
            // LED output report
            0x05.toByte(), 0x08.toByte(), //   Usage Page (LEDs)
            0x19.toByte(), 0x01.toByte(), //   Usage Minimum (1)
            0x29.toByte(), 0x05.toByte(), //   Usage Maximum (5)
            0x75.toByte(), 0x01.toByte(), //   Report Size (1)
            0x95.toByte(), 0x05.toByte(), //   Report Count (5)
            0x91.toByte(), 0x02.toByte(), //   Output (Data, Variable, Absolute)
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

    // --- Connection state machine ---
    enum class BtState { IDLE, REGISTERED, CONNECTED, RECONNECTING, FAILED }

    private val binder = LocalBinder()
    private var btAdapter: BluetoothAdapter? = null
    private var hidDevice: BluetoothHidDevice? = null
    private var connectedDevice: BluetoothDevice? = null
    private var lastKnownDevice: BluetoothDevice? = null
    private var btState = BtState.IDLE
    // Pause after each HID report while typing. Overridable per /type request
    // via "delay_ms" (the PWA sends its Keystroke delay setting). 0 = send at
    // whatever rate the BT stack accepts; sendReportReliably absorbs congestion.
    @Volatile var keystrokeDelayMs: Long = 10L

    // Cancellation for in-progress/queued sends: each send task captures the
    // generation at enqueue and bails as soon as it no longer matches.
    // POST /stop bumps it (see cancelTransmission).
    private val typeGeneration = java.util.concurrent.atomic.AtomicLong(0)

    // Number of send tasks currently running (0 or 1 with the single-threaded
    // executor, but queued tasks make "busy" outlast one task). For /status.
    private val typing = java.util.concurrent.atomic.AtomicInteger(0)

    // Wall-clock time the current link reached CONNECTED, used to enforce the
    // post-connect settle window before the first keystroke (see sendString).
    @Volatile private var connectedAtMs: Long = 0L

    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private var serverSocket: ServerSocket? = null
    private var httpThread: Thread? = null
    private val httpExecutor = Executors.newFixedThreadPool(4)

    // Auth token
    var authToken: String = ""
        private set

    // Reconnect state
    private var reconnectAttempt = 0
    private var reconnectStartTime = 0L
    private var reconnectRunnable: Runnable? = null

    // Headset mic (SCO) state
    private var audioManager: AudioManager? = null
    private var scoReceiver: BroadcastReceiver? = null
    private var audioDeviceCallback: AudioDeviceCallback? = null
    private var scoRetryRunnable: Runnable? = null
    private var scoRetryCount = 0
    private var scoRequested = false
    @Volatile private var scoConnected = false
    // User-facing "Zoom mode" switch: false = release the headset's SCO link
    // so another device (laptop running Zoom) can use the headset mic.
    @Volatile private var headsetMicEnabled = true
    private var audioFocusRequest: AudioFocusRequest? = null
    private var keepAliveTrack: AudioTrack? = null
    private var keepAliveThread: Thread? = null
    @Volatile private var keepAliveRunning = false

    // Log buffer (circular)
    private val logBuffer = ConcurrentLinkedDeque<LogEntry>()

    // Service start time
    private val startTime = System.currentTimeMillis()

    data class LogEntry(val ts: Long, val level: String, val msg: String)

    inner class LocalBinder : Binder() {
        fun getService(): BluetoothHidService = this@BluetoothHidService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        try {
            startForeground(NOTIFICATION_ID, buildNotification("Initializing..."))
        } catch (e: SecurityException) {
            // Android 14+ rejects a connectedDevice foreground service until
            // BLUETOOTH_CONNECT is granted (e.g. first launch before the
            // permission dialog is answered). Bail out instead of crashing.
            Log.e(TAG, "Cannot start foreground service, missing Bluetooth permission?", e)
            stopSelf()
            return
        }

        generateAuthToken()

        val btManager = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        btAdapter = btManager.adapter
        if (btAdapter == null) {
            addLog("error", "Bluetooth not available")
            stopSelf()
            return
        }

        headsetMicEnabled = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_HEADSET_MIC_ENABLED, true)

        startHttpServer()
        setupHeadsetMicRouting()
        registerHidDevice()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        cancelReconnect()
        stopHttpServer()
        teardownHeadsetMicRouting()
        unregisterHidDevice()
        executor.shutdown()
        super.onDestroy()
    }

    // --- Auth token ---

    private fun generateAuthToken() {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        authToken = bytes.joinToString("") { "%02x".format(it) }
        addLog("info", "Auth token generated")
    }

    private fun validateToken(request: HttpRequest): Boolean {
        val authHeader = request.headers["authorization"] ?: ""
        if (authHeader.startsWith("Bearer ")) {
            return authHeader.substring(7) == authToken
        }
        return false
    }

    // --- Headset mic (SCO) routing ---
    //
    // Mic capture happens in Termux (a different app), so routing must be
    // system-wide: startBluetoothSco()/setBluetoothScoOn() force ALL mic capture
    // onto the headset. setCommunicationDevice() — the Android 12+ replacement —
    // only routes the calling app's own communication audio and would leave
    // Termux recording from the phone mic, so the deprecated API is used
    // deliberately on every Android version.

    private fun setupHeadsetMicRouting() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager = am

        scoReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val state = intent?.getIntExtra(
                    AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_ERROR
                )
                when (state) {
                    AudioManager.SCO_AUDIO_STATE_CONNECTED -> onScoConnected(am)
                    AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> {
                        if (scoConnected) {
                            scoConnected = false
                            addLog("info", "Headset mic SCO disconnected")
                        }
                        if (scoRequested && hasBluetoothMic()) scheduleScoRetry()
                    }
                }
            }
        }
        val scoFilter = IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(scoReceiver, scoFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(scoReceiver, scoFilter)
        }

        audioDeviceCallback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
                if (addedDevices.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO && it.isSource }) {
                    addLog("info", "Bluetooth headset mic detected: ${bluetoothMicName() ?: "unknown"}")
                    enableSco()
                }
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
                if (removedDevices.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } &&
                    !hasBluetoothMic()
                ) {
                    addLog("info", "Bluetooth headset removed — mic back to phone")
                    disableSco()
                }
            }
        }
        am.registerAudioDeviceCallback(audioDeviceCallback, handler)

        if (hasBluetoothMic()) {
            addLog("info", "Bluetooth headset mic present: ${bluetoothMicName() ?: "unknown"}")
            enableSco()
        }
    }

    private fun teardownHeadsetMicRouting() {
        disableSco()
        scoReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        scoReceiver = null
        audioDeviceCallback?.let { audioManager?.unregisterAudioDeviceCallback(it) }
        audioDeviceCallback = null
    }

    @Suppress("DEPRECATION")
    private fun onScoConnected(am: AudioManager) {
        scoConnected = true
        scoRetryCount = 0
        cancelScoRetry()
        try {
            am.isBluetoothScoOn = true
        } catch (e: Exception) {
            addLog("error", "setBluetoothScoOn failed: ${e.message}")
        }
        startScoKeepAlive()
        addLog("info", "Headset mic active: ${bluetoothMicName() ?: "Bluetooth headset"}")
    }

    fun hasBluetoothMic(): Boolean =
        audioManager?.getDevices(AudioManager.GET_DEVICES_INPUTS)
            ?.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } == true

    fun bluetoothMicName(): String? =
        audioManager?.getDevices(AudioManager.GET_DEVICES_INPUTS)
            ?.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            ?.productName?.toString()

    fun isHeadsetMicActive(): Boolean = scoConnected

    fun isHeadsetMicEnabled(): Boolean = headsetMicEnabled

    // "Zoom mode": the user shares one multipoint headset between this phone
    // and a laptop. A headset has a single call-audio (SCO) channel, and this
    // service holds it continuously (keep-alive stream + auto-retry), so the
    // laptop can never open its own — Zoom gets no headset mic. Disabling the
    // headset mic releases SCO without stopping the service: HID typing keeps
    // working and dictation falls back to the phone's built-in mic.
    fun setHeadsetMicEnabled(enabled: Boolean) {
        if (headsetMicEnabled == enabled) return
        headsetMicEnabled = enabled
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_HEADSET_MIC_ENABLED, enabled)
            .apply()
        handler.post {
            if (enabled) {
                addLog("info", "Headset mic re-enabled — reclaiming SCO link")
                enableSco()
            } else {
                addLog("info", "Headset mic released for other devices (Zoom mode)")
                disableSco()
            }
        }
    }

    private fun enableSco() {
        val am = audioManager ?: return
        if (!headsetMicEnabled) return
        if (!hasBluetoothMic()) return
        scoRequested = true
        scoRetryCount = 0
        requestScoAudioFocus(am)
        startSco(am)
    }

    @Suppress("DEPRECATION")
    private fun startSco(am: AudioManager) {
        try {
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            am.startBluetoothSco()
            scheduleScoRetry()
        } catch (e: Exception) {
            addLog("error", "Failed to start Bluetooth SCO: ${e.message}")
        }
    }

    // Without holding audio focus, some devices (observed on Samsung/OneUI)
    // silently tear down an app-requested SCO link roughly every 30s, since
    // nothing signals the system that the connection is actively "in use" —
    // Termux's mic reads happen in a separate process the audio policy can't
    // see. Holding AUDIOFOCUS_GAIN for voice communication for as long as SCO
    // is wanted keeps the link from being reclaimed; scheduleScoRetry() still
    // recovers if it drops anyway.
    private fun requestScoAudioFocus(am: AudioManager) {
        if (audioFocusRequest != null) return
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setOnAudioFocusChangeListener { change ->
                addLog("info", "Audio focus changed: $change")
            }
            .build()
        val result = am.requestAudioFocus(request)
        if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            audioFocusRequest = request
        } else {
            addLog("error", "Audio focus request denied ($result) — headset mic may drop periodically")
        }
    }

    private fun abandonScoAudioFocus(am: AudioManager) {
        audioFocusRequest?.let { am.abandonAudioFocusRequest(it) }
        audioFocusRequest = null
    }

    // Audio focus alone doesn't keep the SCO link alive on some devices
    // (observed on Samsung/OneUI): the audio HAL reaps the link after ~15s
    // because no active stream in THIS app is using it — Termux's mic reads
    // are in a separate process the policy can't attribute to the link. Keep
    // a continuous, inaudible output stream (silence) playing over the SCO
    // channel so the link is always "in use" and never torn down. This is the
    // output direction only, so it doesn't contend with Termux's mic capture;
    // SCO is a single bidirectional connection, so keeping the output warm
    // keeps the mic path up too.
    private fun startScoKeepAlive() {
        if (keepAliveRunning) return
        val sampleRate = 16000
        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) {
            addLog("error", "SCO keep-alive: invalid AudioTrack buffer size")
            return
        }
        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(minBuf * 2)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (e: Exception) {
            addLog("error", "SCO keep-alive: failed to create AudioTrack: ${e.message}")
            return
        }
        keepAliveTrack = track
        keepAliveRunning = true
        keepAliveThread = Thread {
            val silence = ShortArray(minBuf / 2)
            try {
                track.play()
                while (keepAliveRunning) {
                    // Blocking write paces the loop to real time.
                    if (track.write(silence, 0, silence.size) < 0) break
                }
            } catch (e: Exception) {
                Log.w(TAG, "SCO keep-alive write loop ended", e)
            }
        }.apply {
            isDaemon = true
            name = "sco-keepalive"
            start()
        }
        addLog("info", "SCO keep-alive stream started")
    }

    private fun stopScoKeepAlive() {
        if (!keepAliveRunning && keepAliveTrack == null) return
        keepAliveRunning = false
        keepAliveThread?.let {
            it.interrupt()
            try { it.join(500) } catch (_: InterruptedException) {}
        }
        keepAliveThread = null
        keepAliveTrack?.let {
            try { it.stop() } catch (_: Exception) {}
            try { it.release() } catch (_: Exception) {}
        }
        keepAliveTrack = null
    }

    private fun scheduleScoRetry() {
        cancelScoRetry()
        if (scoRetryCount >= SCO_MAX_RETRIES) {
            addLog("error", "Headset mic SCO failed after $SCO_MAX_RETRIES attempts — using phone mic")
            return
        }
        scoRetryRunnable = Runnable {
            if (scoRequested && !scoConnected && hasBluetoothMic()) {
                scoRetryCount++
                addLog("info", "Retrying headset mic SCO (attempt $scoRetryCount)")
                audioManager?.let { startSco(it) }
            }
        }
        handler.postDelayed(scoRetryRunnable!!, SCO_RETRY_DELAY_MS)
    }

    private fun cancelScoRetry() {
        scoRetryRunnable?.let { handler.removeCallbacks(it) }
        scoRetryRunnable = null
    }

    @Suppress("DEPRECATION")
    private fun disableSco() {
        scoRequested = false
        scoConnected = false
        cancelScoRetry()
        stopScoKeepAlive()
        val am = audioManager ?: return
        try {
            am.isBluetoothScoOn = false
            am.stopBluetoothSco()
            am.mode = AudioManager.MODE_NORMAL
        } catch (e: Exception) {
            Log.w(TAG, "Failed to disable SCO", e)
        }
        abandonScoAudioFocus(am)
    }

    // --- HID Registration ---

    private fun registerHidDevice() {
        val adapter = btAdapter ?: return
        btState = BtState.IDLE
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
                        btState = BtState.IDLE
                        addLog("error", "HID profile service disconnected")
                    }
                }
            }, BluetoothProfile.HID_DEVICE)
        } catch (e: SecurityException) {
            addLog("error", "Missing Bluetooth permission: ${e.message}")
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
            addLog("error", "Missing Bluetooth permission for registerApp: ${e.message}")
        }
    }

    private fun unregisterHidDevice() {
        try {
            hidDevice?.unregisterApp()
        } catch (e: SecurityException) {
            Log.e(TAG, "Missing Bluetooth permission for unregisterApp", e)
        }
        hidDevice = null
        btState = BtState.IDLE
    }

    private val hidCallback = object : BluetoothHidDevice.Callback() {
        override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, registered: Boolean) {
            if (registered) {
                btState = BtState.REGISTERED
                addLog("info", "HID app registered")
                if (pluggedDevice != null) {
                    connectedDevice = pluggedDevice
                    lastKnownDevice = pluggedDevice
                    btState = BtState.CONNECTED
                    connectedAtMs = System.currentTimeMillis()
                    val name = try { pluggedDevice.name } catch (_: SecurityException) { "Unknown" }
                    addLog("info", "Already connected to $name")
                    updateNotification("Connected to $name")
                } else {
                    updateNotification("Ready — waiting for connection...")
                    connectToHost()
                }
            } else {
                btState = BtState.IDLE
                addLog("error", "HID app registration failed")
                updateNotification("Registration failed")
            }
        }

        override fun onConnectionStateChanged(device: BluetoothDevice?, state: Int) {
            when (state) {
                BluetoothProfile.STATE_CONNECTED -> {
                    connectedDevice = device
                    lastKnownDevice = device
                    btState = BtState.CONNECTED
                    connectedAtMs = System.currentTimeMillis()
                    cancelReconnect()
                    reconnectAttempt = 0
                    val name = try { device?.name } catch (_: SecurityException) { "Unknown" }
                    addLog("info", "BT connected to $name")
                    updateNotification("Connected to $name")
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    connectedDevice = null
                    // Kill the in-progress send and anything queued behind it.
                    // A held key can't be released over a dead link, and — worse —
                    // hosts don't reliably release keys when the device vanishes
                    // (a stuck key keeps auto-repeating until a real key-up or a
                    // reboot). Letting queued sends survive would also blast stale
                    // text into whatever window has focus after reconnect.
                    typeGeneration.incrementAndGet()
                    addLog("info", "BT disconnected — pending sends cancelled")
                    updateNotification("Disconnected — reconnecting...")
                    startReconnect()
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
            // Host setting LED state — acknowledge but ignore
        }
    }

    // --- Reconnect logic ---

    private fun startReconnect() {
        if (btState == BtState.RECONNECTING || btState == BtState.FAILED) return
        btState = BtState.RECONNECTING
        reconnectAttempt = 0
        reconnectStartTime = System.currentTimeMillis()
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (btState != BtState.RECONNECTING) return

        val elapsed = System.currentTimeMillis() - reconnectStartTime
        if (elapsed > RECONNECT_MAX_DURATION_MS) {
            btState = BtState.FAILED
            addLog("error", "Auto-reconnect timed out after $reconnectAttempt attempts")
            updateNotification("Connection failed — reconnect timed out")
            return
        }

        val delay = if (reconnectAttempt < RECONNECT_DELAYS_MS.size) {
            RECONNECT_DELAYS_MS[reconnectAttempt]
        } else {
            RECONNECT_SLOW_MS
        }

        reconnectRunnable = Runnable { attemptReconnect() }
        handler.postDelayed(reconnectRunnable!!, delay)
    }

    private fun attemptReconnect() {
        if (btState != BtState.RECONNECTING) return
        reconnectAttempt++
        addLog("info", "Reconnect attempt $reconnectAttempt")
        connectToHost()
        // If connect() didn't immediately succeed, schedule next attempt
        if (btState == BtState.RECONNECTING) {
            scheduleReconnect()
        }
    }

    private fun cancelReconnect() {
        reconnectRunnable?.let { handler.removeCallbacks(it) }
        reconnectRunnable = null
    }

    private fun getNextRetrySeconds(): Int {
        if (btState != BtState.RECONNECTING) return 0
        val delay = if (reconnectAttempt < RECONNECT_DELAYS_MS.size) {
            RECONNECT_DELAYS_MS[reconnectAttempt]
        } else {
            RECONNECT_SLOW_MS
        }
        return (delay / 1000).toInt()
    }

    // --- Send keystrokes ---

    // Block on the sender thread until the post-connect settle window has
    // elapsed, so the host has finished setting up its input pipe before the
    // first report. Runs inside the single-threaded executor, so it never
    // blocks the HTTP handler that already returned 200. No-op once the link
    // has been up longer than CONNECT_SETTLE_MS.
    private fun waitForConnectSettle() {
        val since = System.currentTimeMillis() - connectedAtMs
        val remaining = CONNECT_SETTLE_MS - since
        if (remaining > 0) {
            addLog("info", "Waiting ${remaining}ms for HID link to settle before typing")
            try {
                Thread.sleep(remaining)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }

    // sendReport() returns false when the stack can't queue the report (tx
    // congestion — likely at low/zero keystroke delay on long text). Back off
    // briefly and retry. Returns false if the report could not be sent —
    // callers must then ABORT the rest of the text: silently skipping reports
    // corrupts the message mid-word, and a skipped all-up release leaves a
    // key held at the host, whose typematic auto-repeat then types it
    // forever until the next key-down arrives.
    private fun sendReportReliably(
        hid: BluetoothHidDevice,
        device: BluetoothDevice,
        bytes: ByteArray,
    ): Boolean {
        repeat(SEND_RETRY_ATTEMPTS) {
            if (hid.sendReport(device, REPORT_ID.toInt(), bytes)) return true
            Thread.sleep(SEND_RETRY_BACKOFF_MS)
        }
        return false
    }

    // Force all keys up. Must succeed if humanly possible — a lost release
    // leaves the host auto-repeating the last key. Bigger retry budget than
    // normal reports; safe to call from any thread.
    private fun releaseAllKeys(hid: BluetoothHidDevice, device: BluetoothDevice) {
        try {
            repeat(RELEASE_RETRY_ATTEMPTS) {
                if (hid.sendReport(device, REPORT_ID.toInt(), HidKeyMapper.KEY_UP_REPORT)) return
                Thread.sleep(RELEASE_RETRY_BACKOFF_MS)
            }
            addLog("error", "Could not send key release after $RELEASE_RETRY_ATTEMPTS attempts — a key may be stuck at the host")
        } catch (_: SecurityException) {
            addLog("error", "Missing permission for key release")
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    /**
     * Kill switch: abandon the in-progress send and everything queued behind
     * it, and immediately release any held key. Bumping [typeGeneration]
     * makes the running executor task bail at its next iteration and makes
     * every task queued before this call exit without typing; the direct
     * release below unsticks the host right away (it may interleave with one
     * final in-flight report, but the task's own finally-release runs after,
     * so all keys still end up released).
     */
    fun cancelTransmission() {
        typeGeneration.incrementAndGet()
        addLog("info", "Transmission cancelled — releasing keys")
        val device = connectedDevice ?: return
        val hid = hidDevice ?: return
        releaseAllKeys(hid, device)
    }

    fun sendString(text: String) {
        val device = connectedDevice ?: return
        val hid = hidDevice ?: return
        val gen = typeGeneration.get()

        executor.execute {
            if (typeGeneration.get() != gen) return@execute // cancelled while queued
            typing.incrementAndGet()
            try {
                waitForConnectSettle()
                for (bytes in HidKeyMapper.buildReports(text)) {
                    if (typeGeneration.get() != gen) {
                        addLog("info", "Send aborted by stop request")
                        return@execute
                    }
                    if (!sendReportReliably(hid, device, bytes)) {
                        addLog("warn", "sendReport failed after $SEND_RETRY_ATTEMPTS attempts — aborting rest of text")
                        return@execute
                    }
                    if (keystrokeDelayMs > 0) Thread.sleep(keystrokeDelayMs)
                }
            } catch (e: SecurityException) {
                addLog("error", "Missing permission for sendReport")
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } finally {
                // Whatever happened above — completion, abort, cancel, or a
                // crash mid-stream — never leave a key held at the host.
                releaseAllKeys(hid, device)
                typing.decrementAndGet()
            }
        }
    }

    fun sendBackspace(count: Int) {
        val device = connectedDevice ?: return
        val hid = hidDevice ?: return
        val report = HidKeyMapper.backspaceReport()
        val gen = typeGeneration.get()

        executor.execute {
            if (typeGeneration.get() != gen) return@execute
            typing.incrementAndGet()
            try {
                waitForConnectSettle()
                for (i in 0 until count) {
                    if (typeGeneration.get() != gen) return@execute
                    if (!sendReportReliably(hid, device, HidKeyMapper.toBytes(report))) return@execute
                    if (keystrokeDelayMs > 0) Thread.sleep(keystrokeDelayMs)
                    if (!sendReportReliably(hid, device, HidKeyMapper.KEY_UP_REPORT)) return@execute
                    if (keystrokeDelayMs > 0) Thread.sleep(keystrokeDelayMs)
                }
            } catch (e: SecurityException) {
                addLog("error", "Missing permission for sendReport")
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } finally {
                releaseAllKeys(hid, device)
                typing.decrementAndGet()
            }
        }
    }

    private fun connectToHost(): Boolean {
        val hid = hidDevice ?: return false
        val adapter = btAdapter ?: return false
        val bondedDevices = try {
            adapter.bondedDevices
        } catch (_: SecurityException) {
            addLog("error", "Missing permission to read bonded devices")
            return false
        }

        if (bondedDevices.isNullOrEmpty()) return false

        val targets = if (lastKnownDevice != null && bondedDevices.contains(lastKnownDevice)) {
            listOf(lastKnownDevice!!) + bondedDevices.filter { it != lastKnownDevice }
        } else {
            bondedDevices.toList()
        }

        for (device in targets) {
            try {
                val initiated = hid.connect(device)
                if (initiated) {
                    val name = try { device.name } catch (_: SecurityException) { device.address }
                    addLog("info", "Initiating HID connection to $name")
                    return true
                }
            } catch (e: SecurityException) {
                addLog("error", "Missing permission for connect")
            }
        }
        return false
    }

    fun isConnected(): Boolean = btState == BtState.CONNECTED

    fun getConnectedDeviceName(): String? = try {
        connectedDevice?.name ?: lastKnownDevice?.name
    } catch (_: SecurityException) { null }

    fun getBtState(): BtState = btState

    /** Soft restart: unregister + re-register HID */
    private fun restart() {
        cancelReconnect()
        unregisterHidDevice()
        addLog("info", "HID service restarting")
        registerHidDevice()
    }

    // --- Logging ---

    private fun addLog(level: String, msg: String) {
        Log.i(TAG, "[$level] $msg")
        while (logBuffer.size >= MAX_LOG_ENTRIES) logBuffer.pollFirst()
        logBuffer.addLast(LogEntry(System.currentTimeMillis() / 1000, level, msg))
    }

    // --- HTTP Server (raw ServerSocket — Android has no com.sun.net.httpserver) ---

    private fun startHttpServer() {
        try {
            serverSocket = ServerSocket(HTTP_PORT, 50, InetAddress.getByName("127.0.0.1"))
            httpThread = Thread {
                while (!Thread.currentThread().isInterrupted) {
                    try {
                        val socket = serverSocket?.accept() ?: break
                        httpExecutor.execute { handleConnection(socket) }
                    } catch (_: Exception) {
                        break
                    }
                }
            }.apply {
                isDaemon = true
                start()
            }
            addLog("info", "HTTP server started on port $HTTP_PORT")
        } catch (e: Exception) {
            addLog("error", "Failed to start HTTP server: ${e.message}")
        }
    }

    private fun stopHttpServer() {
        try { serverSocket?.close() } catch (_: Exception) {}
        httpThread?.interrupt()
        serverSocket = null
        httpThread = null
    }

    private fun handleConnection(socket: Socket) {
        try {
            socket.soTimeout = 10000
            val input = BufferedInputStream(socket.getInputStream())
            val output = socket.getOutputStream()

            val request = HttpRequest.parse(input) ?: return

            when (request.path) {
                "/type" -> handleType(request, output)
                "/stop" -> handleStop(request, output)
                "/backspace" -> handleBackspace(request, output)
                "/status" -> handleStatus(request, output)
                "/logs" -> handleLogs(request, output)
                "/restart" -> handleRestart(request, output)
                "/devices" -> handleDevices(request, output)
                "/connect" -> handleConnect(request, output)
                "/headset-mic" -> handleHeadsetMic(request, output)
                else -> sendResponse(output, 404, JSONObject().put("error", "not_found"))
            }
        } catch (e: Exception) {
            Log.w(TAG, "HTTP connection error", e)
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun statusText(code: Int): String = when (code) {
        200 -> "OK"; 204 -> "No Content"; 400 -> "Bad Request"
        403 -> "Forbidden"; 404 -> "Not Found"; 405 -> "Method Not Allowed"
        500 -> "Internal Server Error"; 503 -> "Service Unavailable"
        else -> "OK"
    }

    private fun sendResponse(output: OutputStream, code: Int, json: JSONObject) {
        val body = json.toString().toByteArray()
        val sb = StringBuilder()
        sb.append("HTTP/1.1 $code ${statusText(code)}\r\n")
        sb.append("Content-Type: application/json\r\n")
        sb.append("Content-Length: ${body.size}\r\n")
        sb.append("Access-Control-Allow-Origin: $ALLOWED_ORIGIN\r\n")
        sb.append("Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n")
        sb.append("Access-Control-Allow-Headers: Authorization, Content-Type\r\n")
        sb.append("Access-Control-Allow-Private-Network: true\r\n")
        sb.append("Connection: close\r\n")
        sb.append("\r\n")
        output.write(sb.toString().toByteArray())
        output.write(body)
        output.flush()
    }

    private fun sendPreflight(output: OutputStream) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 204 No Content\r\n")
        sb.append("Access-Control-Allow-Origin: $ALLOWED_ORIGIN\r\n")
        sb.append("Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n")
        sb.append("Access-Control-Allow-Headers: Authorization, Content-Type\r\n")
        sb.append("Access-Control-Allow-Private-Network: true\r\n")
        sb.append("Content-Length: 0\r\n")
        sb.append("Connection: close\r\n")
        sb.append("\r\n")
        output.write(sb.toString().toByteArray())
        output.flush()
    }

    private fun parseJsonBody(body: String): JSONObject {
        return if (body.isNotBlank()) JSONObject(body) else JSONObject()
    }

    private fun handleType(request: HttpRequest, output: OutputStream) {
        if (request.method == "OPTIONS") { sendPreflight(output); return }
        if (!validateToken(request)) {
            sendResponse(output, 403, JSONObject().put("error", "forbidden").put("message", "Invalid or missing auth token"))
            return
        }
        if (request.method != "POST") {
            sendResponse(output, 405, JSONObject().put("error", "method_not_allowed"))
            return
        }

        try {
            val json = parseJsonBody(request.body)
            val text = json.optString("text", "")
            val append = json.optString("append", " ")
            // Optional per-request delay override, sent by the PWA from its
            // "Keystroke delay" setting. Sticky until the next override.
            val delayMs = json.optLong("delay_ms", -1L)
            if (delayMs >= 0) keystrokeDelayMs = delayMs.coerceAtMost(100L)

            if (text.isEmpty()) {
                sendResponse(output, 400, JSONObject().put("ok", false).put("error", "empty_text"))
                return
            }

            if (btState != BtState.CONNECTED) {
                sendResponse(output, 503, JSONObject()
                    .put("ok", false)
                    .put("error", "bluetooth_disconnected")
                    .put("message", "No Bluetooth device connected."))
                return
            }

            sendString(text + append)
            sendResponse(output, 200, JSONObject().put("ok", true))
        } catch (e: Exception) {
            sendResponse(output, 500, JSONObject().put("ok", false).put("error", e.message ?: "unknown"))
        }
    }

    // Kill switch for runaway typing: abandons the in-progress send and the
    // queue behind it, and forces an all-keys-up release so a stuck key stops
    // auto-repeating at the host. Safe to call any time, even when idle.
    private fun handleStop(request: HttpRequest, output: OutputStream) {
        if (request.method == "OPTIONS") { sendPreflight(output); return }
        if (!validateToken(request)) {
            sendResponse(output, 403, JSONObject().put("error", "forbidden"))
            return
        }
        if (request.method != "POST") {
            sendResponse(output, 405, JSONObject().put("error", "method_not_allowed"))
            return
        }

        try {
            cancelTransmission()
            sendResponse(output, 200, JSONObject().put("ok", true))
        } catch (e: Exception) {
            sendResponse(output, 500, JSONObject().put("ok", false).put("error", e.message ?: "unknown"))
        }
    }

    private fun handleBackspace(request: HttpRequest, output: OutputStream) {
        if (request.method == "OPTIONS") { sendPreflight(output); return }
        if (!validateToken(request)) {
            sendResponse(output, 403, JSONObject().put("error", "forbidden"))
            return
        }
        if (request.method != "POST") {
            sendResponse(output, 405, JSONObject().put("error", "method_not_allowed"))
            return
        }

        try {
            val json = parseJsonBody(request.body)
            val count = json.optInt("count", 1)

            if (btState != BtState.CONNECTED) {
                sendResponse(output, 503, JSONObject()
                    .put("ok", false)
                    .put("error", "bluetooth_disconnected"))
                return
            }

            sendBackspace(count)
            sendResponse(output, 200, JSONObject().put("ok", true))
        } catch (e: Exception) {
            sendResponse(output, 500, JSONObject().put("ok", false).put("error", e.message ?: "unknown"))
        }
    }

    private fun handleStatus(request: HttpRequest, output: OutputStream) {
        if (request.method == "OPTIONS") { sendPreflight(output); return }
        if (request.method != "GET") {
            sendResponse(output, 405, JSONObject().put("error", "method_not_allowed"))
            return
        }

        val json = JSONObject()
        json.put("service", "running")
        json.put("version", BuildConfig.APP_VERSION)
        json.put("uptime_seconds", (System.currentTimeMillis() - startTime) / 1000)
        json.put("keystroke_delay_ms", keystrokeDelayMs)
        json.put("typing", typing.get() > 0)

        json.put("headset_mic", headsetMicJson())

        val deviceName = getConnectedDeviceName()
        when (btState) {
            BtState.CONNECTED -> {
                json.put("bluetooth", "connected")
                json.put("device", deviceName ?: "Unknown")
            }
            BtState.REGISTERED -> {
                json.put("bluetooth", "registered")
            }
            BtState.RECONNECTING -> {
                json.put("bluetooth", "reconnecting")
                json.put("device", deviceName ?: "Unknown")
                json.put("reconnect_attempt", reconnectAttempt)
                json.put("reconnect_max", 10)
                json.put("next_retry_seconds", getNextRetrySeconds())
            }
            BtState.FAILED -> {
                json.put("bluetooth", "failed")
                json.put("device", deviceName ?: "Unknown")
                json.put("failure_reason", "Auto-reconnect timed out after $reconnectAttempt attempts")
            }
            BtState.IDLE -> {
                json.put("bluetooth", "idle")
            }
        }

        sendResponse(output, 200, json)
    }

    private fun headsetMicJson(): JSONObject {
        val json = JSONObject()
            .put("available", hasBluetoothMic())
            .put("active", isHeadsetMicActive())
            .put("enabled", headsetMicEnabled)
        bluetoothMicName()?.let { json.put("device", it) }
        return json
    }

    private fun handleHeadsetMic(request: HttpRequest, output: OutputStream) {
        if (request.method == "OPTIONS") { sendPreflight(output); return }
        if (request.method == "GET") {
            sendResponse(output, 200, headsetMicJson())
            return
        }
        if (request.method != "PUT") {
            sendResponse(output, 405, JSONObject().put("error", "method_not_allowed"))
            return
        }
        if (!validateToken(request)) {
            sendResponse(output, 403, JSONObject().put("error", "forbidden"))
            return
        }

        try {
            val json = parseJsonBody(request.body)
            if (!json.has("enabled")) {
                sendResponse(output, 400, JSONObject()
                    .put("error", "missing_enabled")
                    .put("message", "Body must include {\"enabled\": true|false}"))
                return
            }
            setHeadsetMicEnabled(json.getBoolean("enabled"))
            // "active" may lag: the SCO transition runs async on the main
            // handler. "enabled" reflects the new setting immediately.
            sendResponse(output, 200, headsetMicJson().put("ok", true))
        } catch (e: Exception) {
            sendResponse(output, 500, JSONObject().put("error", e.message ?: "unknown"))
        }
    }

    private fun handleLogs(request: HttpRequest, output: OutputStream) {
        if (request.method == "OPTIONS") { sendPreflight(output); return }
        if (request.method != "GET") {
            sendResponse(output, 405, JSONObject().put("error", "method_not_allowed"))
            return
        }

        val logsArray = JSONArray()
        for (entry in logBuffer) {
            logsArray.put(JSONObject()
                .put("ts", entry.ts)
                .put("level", entry.level)
                .put("msg", entry.msg))
        }

        sendResponse(output, 200, JSONObject().put("logs", logsArray))
    }

    private fun handleRestart(request: HttpRequest, output: OutputStream) {
        if (request.method == "OPTIONS") { sendPreflight(output); return }
        if (!validateToken(request)) {
            sendResponse(output, 403, JSONObject().put("error", "forbidden"))
            return
        }
        if (request.method != "POST") {
            sendResponse(output, 405, JSONObject().put("error", "method_not_allowed"))
            return
        }

        restart()
        sendResponse(output, 200, JSONObject()
            .put("ok", true)
            .put("message", "HID service restarting. Re-registering Bluetooth HID device."))
    }

    private fun handleDevices(request: HttpRequest, output: OutputStream) {
        if (request.method == "OPTIONS") { sendPreflight(output); return }
        if (request.method != "GET") {
            sendResponse(output, 405, JSONObject().put("error", "method_not_allowed"))
            return
        }

        val adapter = btAdapter
        if (adapter == null) {
            sendResponse(output, 500, JSONObject().put("error", "bluetooth_unavailable"))
            return
        }

        val bondedDevices = try {
            adapter.bondedDevices
        } catch (_: SecurityException) {
            sendResponse(output, 500, JSONObject().put("error", "missing_permission"))
            return
        }

        val devicesArray = JSONArray()
        val connectedAddr = connectedDevice?.address
        for (device in bondedDevices ?: emptySet()) {
            val name = try { device.name } catch (_: SecurityException) { null }
            devicesArray.put(JSONObject()
                .put("address", device.address)
                .put("name", name ?: device.address)
                .put("connected", device.address == connectedAddr))
        }

        sendResponse(output, 200, JSONObject().put("devices", devicesArray))
    }

    private fun handleConnect(request: HttpRequest, output: OutputStream) {
        if (request.method == "OPTIONS") { sendPreflight(output); return }
        if (!validateToken(request)) {
            sendResponse(output, 403, JSONObject().put("error", "forbidden"))
            return
        }
        if (request.method != "POST") {
            sendResponse(output, 405, JSONObject().put("error", "method_not_allowed"))
            return
        }

        try {
            val json = parseJsonBody(request.body)
            val address = json.optString("address", "")
            if (address.isEmpty()) {
                sendResponse(output, 400, JSONObject().put("ok", false).put("error", "missing_address"))
                return
            }

            val adapter = btAdapter
            if (adapter == null) {
                sendResponse(output, 500, JSONObject().put("ok", false).put("error", "bluetooth_unavailable"))
                return
            }

            val bondedDevices = try {
                adapter.bondedDevices
            } catch (_: SecurityException) {
                sendResponse(output, 500, JSONObject().put("ok", false).put("error", "missing_permission"))
                return
            }

            val targetDevice = bondedDevices?.firstOrNull { it.address == address }
            if (targetDevice == null) {
                sendResponse(output, 404, JSONObject().put("ok", false).put("error", "device_not_found"))
                return
            }

            val hid = hidDevice
            if (hid == null) {
                sendResponse(output, 503, JSONObject().put("ok", false).put("error", "hid_not_registered"))
                return
            }

            // Disconnect current device first
            if (connectedDevice != null) {
                try {
                    hid.disconnect(connectedDevice)
                } catch (_: SecurityException) {
                    addLog("error", "Missing permission for disconnect")
                }
            }
            cancelReconnect()

            // Set as preferred device and connect
            lastKnownDevice = targetDevice
            val initiated = try {
                hid.connect(targetDevice)
            } catch (e: SecurityException) {
                addLog("error", "Missing permission for connect")
                sendResponse(output, 500, JSONObject().put("ok", false).put("error", "missing_permission"))
                return
            }

            val name = try { targetDevice.name } catch (_: SecurityException) { targetDevice.address }
            if (initiated) {
                addLog("info", "Switching to device: $name")
                sendResponse(output, 200, JSONObject().put("ok", true).put("device", name))
            } else {
                addLog("error", "Failed to initiate connection to $name")
                sendResponse(output, 500, JSONObject().put("ok", false).put("error", "connect_failed"))
            }
        } catch (e: Exception) {
            sendResponse(output, 500, JSONObject().put("ok", false).put("error", e.message ?: "unknown"))
        }
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
