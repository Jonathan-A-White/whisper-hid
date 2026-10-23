package com.whisperbt.keyboard

import com.whisperbt.keyboard.BluetoothHidService.BtState

/**
 * The link to the keyboard host: which computer it is, whether it is up, and
 * getting back to it when it drops. The reconnect state machine of
 * BluetoothHidService, in plain Kotlin behind a [Port] so it is unit tested
 * with a fake HID profile (HostLinkTest).
 *
 * While Bluetooth is on and a host is known it keeps trying, however long
 * that takes (ReconnectPolicy: 2-30 s early on, then once a minute after
 * 5 minutes). FAILED is only for the two conditions retrying cannot fix,
 * and leaving either one (adapter turned on, host paired or its link
 * appearing) restarts the reconnect from the top.
 *
 * Called from the main thread (retry timer, broadcasts), the HID executor
 * (profile callbacks) and HTTP threads (a device pick), so every entry point
 * is synchronized.
 */
class HostLink<T : Any>(private val port: Port<T>) {

    interface Port<T : Any> {
        fun bluetoothOn(): Boolean
        /** Bonded devices; null when the permission to read them is missing. */
        fun bondedDevices(): Collection<T>?
        /** An HID link to [device] is up (BluetoothHidDevice.getConnectionState). */
        fun hidLinked(device: T): Boolean
        /** BluetoothHidDevice.connect: true when the connection was initiated. */
        fun connect(device: T): Boolean
        fun disconnect(device: T)
        fun name(device: T?): String
        fun now(): Long
        /** Arms the retry timer: [onRetryTimer] runs once after the delay, replacing any pending run. */
        fun scheduleRetry(delayMs: Long)
        fun cancelRetry()
        fun log(level: String, message: String)
        fun notify(status: String)
        /** An HID link came up: the post-connect settle window starts now. */
        fun onLinkUp()
        /** The host's link is gone: cancel the send in progress and everything queued. */
        fun onLinkDown()
        /** Bluetooth is going off: nothing can be released or sent. */
        fun onBluetoothOff()
    }

    companion object {
        const val REASON_BLUETOOTH_OFF = "Bluetooth is off"
        const val REASON_NO_HOST = "No paired host known"
    }

    enum class Pick { SWITCHING, FAILED }

    private val hosts = HostMemory<T>()
    @Volatile var state = BtState.IDLE
        private set
    // Why we are in FAILED (Bluetooth off / no host known); only those two
    // conditions ever put us there, never elapsed time.
    @Volatile var failureReason = ""
        private set
    @Volatile var reconnectAttempt = 0
        private set
    private var reconnectStartTime = 0L

    val connected: T? get() = hosts.connected
    val lastKnown: T? get() = hosts.lastKnown

    /** The HID app is not registered (yet): nothing is linked through it. */
    @Synchronized
    fun idle() {
        state = BtState.IDLE
    }

    /** Registration landed; [plugged] is the device Android reports with it. */
    @Synchronized
    fun onRegistered(plugged: T?) {
        state = BtState.REGISTERED
        port.log("info", "HID app registered")
        // Android's plugged device can be a car's audio link: it is the
        // keyboard host only when an HID link to it exists.
        if (hosts.onRegistered(plugged) { port.hidLinked(it) }) {
            state = BtState.CONNECTED
            port.cancelRetry()
            failureReason = ""
            port.onLinkUp()
            val name = port.name(plugged)
            port.log("info", "Already connected to $name")
            port.notify("Connected to $name")
        } else if (reconnectBlocker() == null) {
            // A host is known: connect now and keep trying (backing
            // off, never giving up) until it answers.
            port.notify("Ready — connecting...")
            startReconnect(immediate = true)
        } else {
            port.notify("Ready — waiting for connection...")
        }
    }

    /** registerApp was refused, or Bluetooth dropped the registration. */
    @Synchronized
    fun onUnregistered() {
        // Bluetooth off is FAILED (its reason shows in the PWA), not idle
        if (port.bluetoothOn()) state = BtState.IDLE
        port.log("error", "HID app not registered (will retry)")
        port.notify("Not registered — retrying...")
    }

    @Synchronized
    fun onConnected(device: T?) {
        hosts.connected = device
        hosts.lastKnown = device
        state = BtState.CONNECTED
        port.onLinkUp()
        port.cancelRetry()
        reconnectAttempt = 0
        failureReason = ""
        val name = port.name(device)
        port.log("info", "BT connected to $name")
        port.notify("Connected to $name")
    }

    @Synchronized
    fun onDisconnected(device: T?) {
        hosts.connected = null
        // Kill the in-progress send and anything queued behind it.
        // A held key can't be released over a dead link, and — worse —
        // hosts don't reliably release keys when the device vanishes
        // (a stuck key keeps auto-repeating until a real key-up or a
        // reboot). Letting queued sends survive would also blast stale
        // text into whatever window has focus after reconnect.
        port.onLinkDown()
        port.log("info", "BT disconnected — pending sends cancelled")
        port.notify("Disconnected — reconnecting...")
        startReconnect()
    }

    /** He picked [device] in the device picker (POST /connect). */
    @Synchronized
    fun pick(device: T): Pick {
        // Disconnect current device first
        hosts.connected?.let { port.disconnect(it) }
        port.cancelRetry()

        // Set as preferred device and connect
        hosts.onPick(device)
        val name = port.name(device)
        if (!port.connect(device)) {
            port.log("error", "Failed to initiate connection to $name")
            return Pick.FAILED
        }
        port.log("info", "Switching to device: $name")
        return Pick.SWITCHING
    }

    @Synchronized
    fun enterFailed(reason: String) {
        port.cancelRetry()
        if (reason == REASON_BLUETOOTH_OFF) {
            hosts.connected = null
            port.onBluetoothOff()
        }
        if (state == BtState.FAILED && failureReason == reason) return
        state = BtState.FAILED
        failureReason = reason
        port.log("error", "Auto-reconnect stopped: $reason")
        port.notify("Not connected — $reason")
    }

    /** Begin (or restart) reconnecting. [immediate] tries once straight away. */
    @Synchronized
    fun startReconnect(immediate: Boolean = false) {
        if (!immediate && state == BtState.RECONNECTING) return
        port.cancelRetry()
        val blocker = reconnectBlocker()
        if (blocker != null) {
            enterFailed(blocker)
            return
        }
        state = BtState.RECONNECTING
        failureReason = ""
        reconnectAttempt = 0
        reconnectStartTime = port.now()
        if (immediate) attemptReconnect() else scheduleReconnect()
    }

    /** The retry timer fired. */
    @Synchronized
    fun onRetryTimer() = attemptReconnect()

    @Synchronized
    fun cancelReconnect() = port.cancelRetry()

    /** Seconds until the next attempt, 0 when not reconnecting. */
    @Synchronized
    fun nextRetrySeconds(): Int {
        if (state != BtState.RECONNECTING) return 0
        return (nextRetryDelayMs() / 1000).toInt()
    }

    /** Why reconnecting is pointless right now, or null if it is worth trying. */
    @Synchronized
    fun reconnectBlocker(): String? = when {
        !port.bluetoothOn() -> REASON_BLUETOOTH_OFF
        !hostKnown() -> REASON_NO_HOST
        else -> null
    }

    /** A host we could connect to: the last one we talked to, or any bonded device. */
    private fun hostKnown(): Boolean {
        if (hosts.lastKnown != null) return true
        return !port.bondedDevices().isNullOrEmpty()
    }

    private fun nextRetryDelayMs(): Long = ReconnectPolicy.delayMs(
        reconnectAttempt + 1, port.now() - reconnectStartTime
    )

    private fun scheduleReconnect() {
        if (state != BtState.RECONNECTING) return
        val delay = nextRetryDelayMs()
        port.notify("Reconnecting… (attempt ${reconnectAttempt + 1}, next try in ${delay / 1000} s)")
        port.scheduleRetry(delay)
    }

    private fun attemptReconnect() {
        if (state != BtState.RECONNECTING) return
        val blocker = reconnectBlocker()
        if (blocker != null) {
            enterFailed(blocker)
            return
        }
        reconnectAttempt++
        port.log("info", "Reconnect attempt $reconnectAttempt")
        connectToHost()
        // If connect() didn't immediately succeed, schedule next attempt
        if (state == BtState.RECONNECTING) scheduleReconnect()
    }

    private fun connectToHost(): Boolean {
        val bonded = port.bondedDevices()
        if (bonded == null) {
            port.log("error", "Missing permission to read bonded devices")
            return false
        }
        if (bonded.isEmpty()) return false
        val last = hosts.lastKnown
        val targets = if (last != null && bonded.contains(last)) {
            listOf(last) + bonded.filter { it != last }
        } else {
            bonded.toList()
        }
        for (device in targets) {
            if (port.connect(device)) {
                port.log("info", "Initiating HID connection to ${port.name(device)}")
                return true
            }
        }
        return false
    }
}
