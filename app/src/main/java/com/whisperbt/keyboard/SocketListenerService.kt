package com.whisperbt.keyboard

import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ConnectException
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Background service that maintains a TCP connection to localhost:[port]
 * and forwards transcription lines to [BluetoothHidService].
 *
 * Protocol (newline-delimited):
 *   Normal text line  → typed as keystrokes
 *   \x01PAUSE\n       → pause STT output
 *   \x01RESUME\n      → resume STT output
 *   \x01BACKSPACE:N\n → send N backspace keys
 *
 * Auto-reconnects every [RECONNECT_DELAY_MS] on connection failure.
 */
class SocketListenerService : Service() {

    companion object {
        private const val TAG = "SocketListenerService"

        const val EXTRA_PORT = "port"
        const val DEFAULT_PORT = 9876

        private const val RECONNECT_DELAY_MS = 3_000L
        private const val CONNECT_TIMEOUT_MS = 5_000

        // Broadcast for status/log updates towards MainActivity
        const val BROADCAST_LOG = "com.whisperbt.keyboard.LOG"
        const val EXTRA_LOG_LINE = "log_line"

        // Control message prefix byte (0x01 SOH)
        private const val CTRL_PREFIX = '\u0001'
    }

    private val running = AtomicBoolean(false)
    private var port: Int = DEFAULT_PORT

    private val socketExecutor = Executors.newSingleThreadExecutor()

    // Bound reference to BluetoothHidService
    private var hidService: BluetoothHidService? = null
    private val hidConnected = AtomicBoolean(false)

    private val hidConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            hidService = (service as BluetoothHidService.BluetoothHidBinder).getService()
            hidConnected.set(true)
            Log.i(TAG, "Bound to BluetoothHidService")
        }

        override fun onServiceDisconnected(name: ComponentName) {
            hidService = null
            hidConnected.set(false)
            Log.w(TAG, "Unbound from BluetoothHidService")
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ──────────────────────────────────────────────────────────────────────────

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        port = intent?.getIntExtra(EXTRA_PORT, DEFAULT_PORT) ?: DEFAULT_PORT

        if (running.compareAndSet(false, true)) {
            bindToHidService()
            socketExecutor.submit { runSocketLoop() }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        running.set(false)
        if (hidConnected.get()) {
            unbindService(hidConnection)
        }
        socketExecutor.shutdownNow()
        Log.i(TAG, "Stopped")
    }

    // ──────────────────────────────────────────────────────────────────────────
    // HID service binding
    // ──────────────────────────────────────────────────────────────────────────

    private fun bindToHidService() {
        val intent = Intent(this, BluetoothHidService::class.java)
        bindService(intent, hidConnection, Context.BIND_AUTO_CREATE)
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Socket loop
    // ──────────────────────────────────────────────────────────────────────────

    private fun runSocketLoop() {
        Log.i(TAG, "Socket loop started — connecting to localhost:$port")

        while (running.get()) {
            try {
                connectAndRead()
            } catch (e: InterruptedException) {
                Log.d(TAG, "Socket loop interrupted")
                break
            } catch (e: ConnectException) {
                log("Waiting for Termux server on :$port …")
            } catch (e: SocketException) {
                if (running.get()) log("Socket closed: ${e.message}")
            } catch (e: Exception) {
                if (running.get()) Log.e(TAG, "Socket error", e)
            }

            if (running.get()) {
                Thread.sleep(RECONNECT_DELAY_MS)
            }
        }

        Log.i(TAG, "Socket loop ended")
    }

    private fun connectAndRead() {
        Socket("127.0.0.1", port).use { socket ->
            socket.soTimeout = 0 // block indefinitely on read
            log("Connected to localhost:$port")

            val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))

            while (running.get()) {
                val line = reader.readLine() ?: break  // null = server closed connection
                processLine(line)
            }

            log("Server disconnected")
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Line processing
    // ──────────────────────────────────────────────────────────────────────────

    private fun processLine(rawLine: String) {
        if (rawLine.isEmpty()) return

        if (rawLine.first() == CTRL_PREFIX) {
            handleControl(rawLine.drop(1))
        } else {
            handleText(rawLine)
        }
    }

    private fun handleControl(command: String) {
        Log.d(TAG, "Control: $command")
        when {
            command == "PAUSE"  -> {
                log("[CTRL] Paused")
                // BluetoothHidService already checks isSttActive before typing
                // Force via reflection-free approach: just log; UI toggles it
            }
            command == "RESUME" -> {
                log("[CTRL] Resumed")
            }
            command.startsWith("BACKSPACE:") -> {
                val n = command.removePrefix("BACKSPACE:").toIntOrNull() ?: 1
                log("[CTRL] Backspace x$n")
                hidService?.sendBackspace(n)
            }
            else -> Log.w(TAG, "Unknown control command: $command")
        }
    }

    private fun handleText(text: String) {
        log("STT: $text")
        hidService?.typeText(text)
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Logging
    // ──────────────────────────────────────────────────────────────────────────

    private fun log(message: String) {
        Log.d(TAG, message)
        sendBroadcast(Intent(BROADCAST_LOG).apply {
            putExtra(EXTRA_LOG_LINE, message)
        })
    }
}
