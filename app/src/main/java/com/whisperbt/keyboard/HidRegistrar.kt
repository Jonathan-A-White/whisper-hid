package com.whisperbt.keyboard

/**
 * Gets the HID app registered with Bluetooth and keeps trying until it is.
 * Plain Kotlin behind a [Port], so it can be unit tested with a fake adapter.
 */
class HidRegistrar(
    private val port: Port,
    private val schedule: (Long) -> Unit,
    private val cancelTimer: () -> Unit,
    private val now: () -> Long,
    private val log: (level: String, message: String) -> Unit
) {
    /** The HID-device profile proxy. */
    interface Proxy {
        /** Asks Bluetooth to register the HID app; false when it refuses at once. */
        fun registerApp(): Boolean
        fun close()
    }

    interface ProxyListener {
        fun onConnected(proxy: Proxy)
        fun onDisconnected()
    }

    interface Port {
        fun bluetoothOn(): Boolean
        /** Asks for the HID-device proxy; false when refused. */
        fun requestProxy(listener: ProxyListener): Boolean
    }

    @Volatile var registered = false
        private set
    private var proxy: Proxy? = null
    private var generation = 0

    @Synchronized
    fun ensureRegistered() {
        if (registered) return
        begin()
    }

    @Synchronized
    fun restart() {
        begin()
    }

    /** The retry timer fired. */
    @Synchronized
    fun onRetryTimer() {
    }

    @Synchronized
    fun onAppStatus(isRegistered: Boolean) {
        registered = isRegistered
    }

    @Synchronized
    fun onBluetoothOff() {
        drop()
    }

    @Synchronized
    fun shutdown() {
        drop()
    }

    private fun drop() {
        generation++
        proxy?.let { try { it.close() } catch (_: Exception) {} }
        proxy = null
        registered = false
    }

    private fun begin() {
        drop()
        if (!port.bluetoothOn()) return
        val gen = generation
        val listener = object : ProxyListener {
            override fun onConnected(proxy: Proxy) = proxyConnected(gen, proxy)
            override fun onDisconnected() = proxyDisconnected(gen)
        }
        val asked = try { port.requestProxy(listener) } catch (e: SecurityException) { false }
        if (!asked) log("error", "HID profile proxy request refused")
    }

    @Synchronized
    private fun proxyConnected(gen: Int, p: Proxy) {
        if (gen != generation) return
        proxy = p
        if (!p.registerApp()) log("error", "registerApp refused")
    }

    @Synchronized
    private fun proxyDisconnected(gen: Int) {
        if (gen != generation) return
        proxy = null
        registered = false
    }
}
