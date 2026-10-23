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
        /** Devices with an HID link up right now (BluetoothHidDevice.getConnectedDevices). */
        fun hidLinkedHosts(): List<T>
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
        /** Keep [device] as the host to reconnect to after the service restarts. */
        fun remember(device: T)
    }

    companion object {
        const val REASON_BLUETOOTH_OFF = "Bluetooth is off"
        const val REASON_NO_HOST = "No paired host known"
    }

    /** What a device pick did: already the host, switching to it, or connect() refused. */
    enum class Pick { CONNECTED, SWITCHING, FAILED }

    private val hosts = HostMemory<T>()
    @Volatile var state = BtState.IDLE
        private set
    // Why we are in FAILED (Bluetooth off / no host known); only those two
    // conditions ever put us there, never elapsed time.
    @Volatile var failureReason = ""
        private set
    // Attempts since the link was last up, and when this run of them began
    // (0 = not counting): only a real connection resets them (linkUp), so a
    // pick, Restart HID or the host's link appearing do not show attempt 1 again.
    @Volatile var reconnectAttempt = 0
        private set
    private var reconnectStartTime = 0L
    // The host a pick is switching away from: its DISCONNECTED is expected.
    private var leaving: T? = null

    val connected: T? get() = hosts.connected
    val lastKnown: T? get() = hosts.lastKnown

    /** The service started: [device] is the host it remembered last time. */
    @Synchronized
    fun restore(device: T) {
        if (hosts.lastKnown == null) hosts.lastKnown = device
    }

    /** The HID app is not registered (yet): nothing is linked through it. */
    @Synchronized
    fun idle() {
        state = BtState.IDLE
        // Unregistering drops any HID link: nothing queued may outlive it.
        if (hosts.connected != null) {
            hosts.connected = null
            port.onLinkDown()
        }
    }

    /** Registration landed; [plugged] is the device Android reports with it. */
    @Synchronized
    fun onRegistered(plugged: T?) {
        state = BtState.REGISTERED
        port.log("info", "HID app registered")
        // Android's plugged device can be a car's audio link: it is the
        // keyboard host only when an HID link to it exists.
        val up = if (hosts.onRegistered(plugged) { port.hidLinked(it) }) plugged else linkedHost()
        if (up != null) {
            linkUp(up, "Already connected to ${port.name(up)}")
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
        if (device == null) return
        if (device == leaving) leaving = null
        linkUp(device, "BT connected to ${port.name(device)}")
    }

    /**
     * An HID link closed, or a connection attempt to [device] did not come up
     * (Android reports both as DISCONNECTED). Only the connected host's own
     * link going down drops the connection.
     */
    @Synchronized
    fun onDisconnected(device: T?) {
        val host = hosts.connected
        if (device != null && device == leaving) {
            leaving = null
            port.log("info", "HID link to ${port.name(device)} closed (switched away from it)")
            return
        }
        if (host == null) {
            port.log("info", "HID connection to ${port.name(device)} did not come up")
            // Unregistered: registering again starts the reconnect.
            if (state != BtState.IDLE) startReconnect()
            return
        }
        if (device != null && device != host) {
            // A stale attempt to another device: the host's link is still up.
            port.log("info", "HID link to ${port.name(device)} closed; still connected to ${port.name(host)}")
            return
        }
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
        val name = port.name(device)
        val host = hosts.connected
        // Already the host: disconnecting it to connect it again only drops
        // a working link.
        if (state == BtState.CONNECTED && host == device) {
            port.log("info", "Picked $name: already connected to it")
            return Pick.CONNECTED
        }
        // Its HID link is up though no callback said so: take it, don't dial over it.
        if (port.hidLinked(device)) {
            linkUp(device, "Picked $name: its HID link is up — connected")
            return Pick.CONNECTED
        }
        if (host != null) {
            // What is queued for the old host must not reach the new one.
            hosts.connected = null
            leaving = host
            port.onLinkDown()
            port.disconnect(host)
        }
        hosts.onPick(device)
        port.remember(device)
        val initiated = port.connect(device)
        if (initiated) {
            port.log("info", "Switching to device: $name")
        } else {
            port.log("error", "Failed to initiate connection to $name")
        }
        // From here on it is a reconnect to the picked host with the retry
        // timer armed, so a pick that does not come up is tried again. It
        // used to cancel the timer and leave RECONNECTING with nothing armed:
        // the DISCONNECTED that followed saw RECONNECTING and did nothing, and
        // the status sat at "attempt 1" for good.
        port.cancelRetry()
        state = BtState.RECONNECTING
        failureReason = ""
        if (reconnectStartTime == 0L) reconnectStartTime = port.now()
        scheduleReconnect()
        return if (initiated) Pick.SWITCHING else Pick.FAILED
    }

    private fun linkUp(device: T, message: String) {
        hosts.connected = device
        hosts.lastKnown = device
        port.remember(device)
        state = BtState.CONNECTED
        port.onLinkUp()
        port.cancelRetry()
        reconnectAttempt = 0
        reconnectStartTime = 0L
        failureReason = ""
        port.log("info", message)
        port.notify("Connected to ${port.name(device)}")
    }

    /** A device with an HID link up now, the last known host first. */
    private fun linkedHost(): T? {
        val up = port.hidLinkedHosts()
        val last = hosts.lastKnown
        return if (last != null && last in up) last else up.firstOrNull()
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
        if (reconnectStartTime == 0L) reconnectStartTime = port.now()
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
        // The host dialled in and the callback never came: take its link
        // instead of dialling over it.
        linkedHost()?.let {
            linkUp(it, "HID link to ${port.name(it)} is up — connected")
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
