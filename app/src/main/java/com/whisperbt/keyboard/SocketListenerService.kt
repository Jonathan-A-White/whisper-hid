package com.whisperbt.keyboard

import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Binder
import android.os.IBinder
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.Socket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

class SocketListenerService : Service() {

    companion object {
        private const val TAG = "SocketListener"
        private const val CONTROL_PREFIX = '\u0001' // 0x01
        private const val DEFAULT_PORT = 9876
        private const val RECONNECT_DELAY_MS = 3000L
        private const val MAX_RECONNECT_DELAY_MS = 30000L
    }

    interface TranscriptionCallback {
        fun onTranscription(text: String)
        fun onStatusChanged(status: String)
    }

    private val binder = LocalBinder()
    private var port = DEFAULT_PORT
    private val running = AtomicBoolean(false)
    private var listenerThread: Thread? = null
    private var hidService: BluetoothHidService? = null
    private val textBuffer = ConcurrentLinkedQueue<String>()
    var transcriptionCallback: TranscriptionCallback? = null
    var appendNewline = false
    var appendSpace = true
    private var paused = false

    inner class LocalBinder : Binder() {
        fun getService(): SocketListenerService = this@SocketListenerService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        bindToHidService()
    }

    override fun onDestroy() {
        stop()
        unbindHidService()
        super.onDestroy()
    }

    fun setPort(port: Int) {
        this.port = port
    }

    fun start() {
        if (running.getAndSet(true)) return
        listenerThread = Thread(::listenLoop, "socket-listener").also { it.start() }
        transcriptionCallback?.onStatusChanged("Connecting to localhost:$port...")
    }

    fun stop() {
        running.set(false)
        listenerThread?.interrupt()
        listenerThread = null
        transcriptionCallback?.onStatusChanged("Stopped")
    }

    fun isRunning(): Boolean = running.get()

    private fun listenLoop() {
        var reconnectDelay = RECONNECT_DELAY_MS
        while (running.get()) {
            try {
                Socket("127.0.0.1", port).use { socket ->
                    reconnectDelay = RECONNECT_DELAY_MS
                    transcriptionCallback?.onStatusChanged("Connected to socket")
                    Log.i(TAG, "Connected to localhost:$port")

                    val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
                    var line: String? = null
                    while (running.get() && reader.readLine().also { line = it } != null) {
                        handleLine(line!!)
                    }
                }
            } catch (e: Exception) {
                if (!running.get()) break
                Log.w(TAG, "Socket connection failed, retrying in ${reconnectDelay}ms", e)
                transcriptionCallback?.onStatusChanged("Disconnected — retrying...")
                try {
                    Thread.sleep(reconnectDelay)
                } catch (_: InterruptedException) {
                    break
                }
                reconnectDelay = (reconnectDelay * 2).coerceAtMost(MAX_RECONNECT_DELAY_MS)
            }
        }
    }

    private fun handleLine(line: String) {
        if (line.isEmpty()) return

        if (line[0] == CONTROL_PREFIX) {
            handleControlMessage(line.substring(1))
            return
        }

        if (paused) return

        val text = buildString {
            append(line)
            if (appendNewline) append('\n')
            else if (appendSpace) append(' ')
        }

        transcriptionCallback?.onTranscription(line)

        if (hidService?.isConnected() == true) {
            hidService?.sendString(text)
        } else {
            textBuffer.add(text)
            Log.d(TAG, "Buffered text (BT not connected): $line")
        }
    }

    private fun handleControlMessage(msg: String) {
        Log.i(TAG, "Control message: $msg")
        when {
            msg == "PAUSE" -> {
                paused = true
                transcriptionCallback?.onStatusChanged("Paused")
            }
            msg == "RESUME" -> {
                paused = false
                transcriptionCallback?.onStatusChanged("Listening")
                flushBuffer()
            }
            msg.startsWith("BACKSPACE:") -> {
                val count = msg.substringAfter("BACKSPACE:").toIntOrNull() ?: 1
                hidService?.sendBackspace(count)
            }
        }
    }

    /** Flush any buffered text once BT reconnects. */
    fun flushBuffer() {
        while (textBuffer.isNotEmpty()) {
            val text = textBuffer.poll() ?: break
            hidService?.sendString(text)
        }
    }

    // --- Bind to BluetoothHidService ---

    private val hidConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            hidService = (service as BluetoothHidService.LocalBinder).getService()
            flushBuffer()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            hidService = null
        }
    }

    private fun bindToHidService() {
        val intent = Intent(this, BluetoothHidService::class.java)
        bindService(intent, hidConnection, Context.BIND_AUTO_CREATE)
    }

    private fun unbindHidService() {
        try {
            unbindService(hidConnection)
        } catch (_: IllegalArgumentException) {
            // Not bound
        }
    }
}
