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
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
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
    var keystrokeDelayMs: Long = 10L

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
        startForeground(NOTIFICATION_ID, buildNotification("Initializing..."))

        generateAuthToken()

        val btManager = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        btAdapter = btManager.adapter
        if (btAdapter == null) {
            addLog("error", "Bluetooth not available")
            stopSelf()
            return
        }

        startHttpServer()
        enableSco()
        registerHidDevice()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        cancelReconnect()
        stopHttpServer()
        disableSco()
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

    private data class HttpRequest(
        val method: String,
        val path: String,
        val headers: Map<String, String>,
        val body: String
    )

    private fun validateToken(request: HttpRequest): Boolean {
        val authHeader = request.headers["authorization"] ?: ""
        if (authHeader.startsWith("Bearer ")) {
            return authHeader.substring(7) == authToken
        }
        return false
    }

    // --- SCO Management ---

    private fun enableSco() {
        try {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val devices = audioManager.availableCommunicationDevices
                val btDevice = devices.firstOrNull {
                    it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                }
                if (btDevice != null) {
                    audioManager.setCommunicationDevice(btDevice)
                    addLog("info", "SCO enabled via setCommunicationDevice")
                } else {
                    addLog("info", "No BT SCO device found, using fallback")
                    @Suppress("DEPRECATION")
                    audioManager.startBluetoothSco()
                }
            } else {
                @Suppress("DEPRECATION")
                audioManager.startBluetoothSco()
                addLog("info", "SCO enabled via startBluetoothSco")
            }
        } catch (e: Exception) {
            addLog("error", "Failed to enable SCO: ${e.message}")
        }
    }

    private fun disableSco() {
        try {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                audioManager.stopBluetoothSco()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to disable SCO", e)
        }
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
                    cancelReconnect()
                    reconnectAttempt = 0
                    val name = try { device?.name } catch (_: SecurityException) { "Unknown" }
                    addLog("info", "BT connected to $name")
                    updateNotification("Connected to $name")
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    connectedDevice = null
                    addLog("info", "BT disconnected")
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
                    addLog("error", "Missing permission for sendReport")
                    return@execute
                }
            }
        }
    }

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
                    addLog("error", "Missing permission for sendReport")
                    return@execute
                }
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
            val input = BufferedReader(InputStreamReader(socket.getInputStream()))
            val output = socket.getOutputStream()

            val requestLine = input.readLine() ?: return
            val parts = requestLine.split(" ", limit = 3)
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1]

            val headers = mutableMapOf<String, String>()
            var line = input.readLine()
            while (line != null && line.isNotEmpty()) {
                val colonIdx = line.indexOf(':')
                if (colonIdx > 0) {
                    headers[line.substring(0, colonIdx).trim().lowercase()] =
                        line.substring(colonIdx + 1).trim()
                }
                line = input.readLine()
            }

            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = if (contentLength > 0) {
                val buf = CharArray(contentLength)
                var read = 0
                while (read < contentLength) {
                    val n = input.read(buf, read, contentLength - read)
                    if (n == -1) break
                    read += n
                }
                String(buf, 0, read)
            } else ""

            val request = HttpRequest(method, path, headers, body)

            when (path) {
                "/type" -> handleType(request, output)
                "/backspace" -> handleBackspace(request, output)
                "/status" -> handleStatus(request, output)
                "/logs" -> handleLogs(request, output)
                "/restart" -> handleRestart(request, output)
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
        sb.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
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
        sb.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
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
        json.put("uptime_seconds", (System.currentTimeMillis() - startTime) / 1000)

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
