package com.whisperbt.keyboard

/**
 * Gets the HID app registered with Bluetooth and keeps trying until it is, for
 * as long as Bluetooth is on. Plain Kotlin behind a [Port], so it is unit
 * tested with a fake adapter.
 *
 * The service used to ask once (proxy, then registerApp) and wait: if the
 * proxy never answered, registerApp was refused, or Bluetooth later dropped
 * the registration, it sat in IDLE ("idle" in /status) with nothing ever
 * trying again. Now every attempt arms a retry timer on the [ReconnectPolicy]
 * schedule; the timer is only cancelled by REGISTERED, by Bluetooth going off
 * (the adapter-on broadcast starts it again), or by [shutdown].
 *
 * Callable from any thread: the proxy callbacks arrive on main, the app-status
 * callback on the HID executor.
 */
class HidRegistrar(
    private val port: Port,
    /** arms the retry timer: [onRetryTimer] runs once after the delay, replacing any pending run */
    private val schedule: (Long) -> Unit,
    private val cancelTimer: () -> Unit,
    private val now: () -> Long,
    private val log: (level: String, message: String) -> Unit
) {
    /** The HID-device profile proxy. */
    interface Proxy {
        /** Asks Bluetooth to register the HID app; false when it refuses at once. */
        fun registerApp(): Boolean
        /** Unregisters the app and releases the proxy. */
        fun close()
    }

    /**
     * Callbacks of one proxy request. [onConnected] can come again for the
     * same request after [onDisconnected] (Android rebinds the service).
     */
    interface ProxyListener {
        fun onConnected(proxy: Proxy)
        fun onDisconnected()
    }

    interface Port {
        fun bluetoothOn(): Boolean
        /** Asks for the HID-device proxy; false when Android refuses. */
        fun requestProxy(listener: ProxyListener): Boolean
    }

    @Volatile var registered = false
        private set
    private var proxy: Proxy? = null
    // Bumped whenever a request is abandoned, so a stale proxy cannot register.
    private var generation = 0
    // Retrying: the timer is armed and a registration is wanted.
    private var pending = false
    private var attempt = 0
    private var startedAt = 0L
    // After shutdown() a late status callback must not arm the timer again.
    private var stopped = false

    // What the last attempt is waiting on, and since when: Android can take a
    // request and never call back, which used to retry in silence.
    private enum class Waiting { NOTHING, PROXY, REGISTER }
    private var waiting = Waiting.NOTHING
    private var waitingSince = 0L
    private var unanswered = 0

    /**
     * Bluetooth took [NOT_ANSWERING_AFTER] attempts in a row without calling
     * back: restarting HID will not help, the stack is wedged. Cleared by any
     * answer (registered or not) and by Bluetooth going off.
     */
    val notAnswering: Boolean @Synchronized get() = unanswered >= NOT_ANSWERING_AFTER

    companion object {
        const val NOT_ANSWERING_AFTER = 3
    }

    /** Start registering unless it is registered or already being retried. */
    @Synchronized
    fun ensureRegistered() {
        if (registered || pending) return
        stopped = false
        attempt = 0
        startedAt = now()
        begin()
    }

    /** Drop the registration and register again from the top. */
    @Synchronized
    fun restart() {
        stopped = false
        attempt = 0
        startedAt = now()
        begin()
    }

    /** The retry timer fired. */
    @Synchronized
    fun onRetryTimer() {
        if (registered) {
            pending = false
            return
        }
        if (!port.bluetoothOn()) {
            // Adapter on starts it again (ensureRegistered).
            pending = false
            waiting = Waiting.NOTHING
            log("info", "Bluetooth is off: HID registration paused until it is turned on")
            return
        }
        begin()
    }

    /** Bluetooth's answer to registerApp / unregisterApp. */
    @Synchronized
    fun onAppStatus(isRegistered: Boolean) {
        registered = isRegistered
        waiting = Waiting.NOTHING
        unanswered = 0
        if (isRegistered) {
            pending = false
            cancelTimer()
        } else if (!stopped && port.bluetoothOn()) {
            // Refused, or dropped later: try again.
            armRetry()
        }
    }

    @Synchronized
    fun onBluetoothOff() {
        drop()
        waiting = Waiting.NOTHING
        unanswered = 0
        pending = false
        cancelTimer()
    }

    @Synchronized
    fun shutdown() {
        onBluetoothOff()
        stopped = true
    }

    private fun drop() {
        generation++
        proxy?.let { try { it.close() } catch (_: Exception) {} }
        proxy = null
        registered = false
    }

    private fun armRetry() {
        pending = true
        schedule(ReconnectPolicy.delayMs(maxOf(attempt, 1), now() - startedAt))
    }

    private fun begin() {
        noteUnanswered()
        drop()
        if (!port.bluetoothOn()) {
            pending = false
            cancelTimer()
            log("info", "Bluetooth is off: HID registration paused until it is turned on")
            return
        }
        attempt++
        log("info", "Registering the HID app (attempt $attempt)")
        waiting = Waiting.PROXY
        waitingSince = now()
        val gen = generation
        val listener = object : ProxyListener {
            override fun onConnected(proxy: Proxy) = proxyConnected(gen, proxy)
            override fun onDisconnected() = proxyDisconnected(gen)
        }
        val asked = try {
            port.requestProxy(listener)
        } catch (e: SecurityException) {
            log("error", "Missing Bluetooth permission for the HID profile: ${e.message}")
            false
        }
        if (!asked) {
            waiting = Waiting.NOTHING
            log("error", "HID profile proxy request refused (attempt $attempt)")
        }
        armRetry()
    }

    /** The attempt being abandoned asked Bluetooth something and got no word back. */
    private fun noteUnanswered() {
        val what = when (waiting) {
            Waiting.PROXY -> "the HID profile request"
            Waiting.REGISTER -> "registerApp"
            Waiting.NOTHING -> return
        }
        waiting = Waiting.NOTHING
        unanswered++
        val waitedS = (now() - waitingSince) / 1000
        log("error", "No answer from Bluetooth to $what (attempt $attempt, waited $waitedS s)")
    }

    @Synchronized
    private fun proxyConnected(gen: Int, p: Proxy) {
        if (gen != generation) return
        proxy = p
        val accepted = try {
            p.registerApp()
        } catch (e: SecurityException) {
            log("error", "Missing Bluetooth permission for registerApp: ${e.message}")
            false
        }
        if (accepted) {
            waiting = Waiting.REGISTER
            waitingSince = now()
            log("info", "registerApp accepted, waiting for Bluetooth (attempt $attempt)")
        } else {
            waiting = Waiting.NOTHING
            log("error", "registerApp refused (attempt $attempt)")
        }
        // Whatever the answer, the timer stays armed until REGISTERED.
        if (!pending) armRetry()
    }

    @Synchronized
    private fun proxyDisconnected(gen: Int) {
        if (gen != generation) return
        proxy = null
        registered = false
        waiting = Waiting.NOTHING
        log("error", "HID profile service disconnected")
        if (port.bluetoothOn()) armRetry() else pending = false
    }
}
