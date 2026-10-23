package com.whisperbt.keyboard

/**
 * The keyboard host the service is linked to ([connected]) and the one it
 * reconnects to ([lastKnown]). Both hold only a device with an HID link or one
 * he picked in the device picker: Android's "plugged" device at registration
 * can be a car's audio link, not a computer (mw-fxa9j0).
 */
class HostMemory<T : Any> {
    var connected: T? = null
    var lastKnown: T? = null

    /** He picked [device] in the device picker: it is the reconnect target. */
    fun onPick(device: T) { lastKnown = device }

    /**
     * Registration reported [plugged]. Adopt it as the connected host only when
     * [hidConnected] confirms an HID link to it; otherwise leave both fields
     * alone. True when it was adopted.
     */
    fun onRegistered(plugged: T?, hidConnected: (T) -> Boolean): Boolean {
        if (plugged == null || !hidConnected(plugged)) return false
        connected = plugged
        lastKnown = plugged
        return true
    }
}
