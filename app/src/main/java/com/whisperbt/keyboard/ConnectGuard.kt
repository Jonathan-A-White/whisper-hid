package com.whisperbt.keyboard

/**
 * A device pick (POST /connect) before the HID app is registered cannot
 * work: BluetoothHidDevice.connect() just returns false, which used to surface
 * as "Failed to initiate connection". Answer with the real reason instead.
 */
object ConnectGuard {
    const val NOT_REGISTERED = "not_registered"

    /** The error code to answer a pick with, or null when it may go ahead. */
    fun blocker(registered: Boolean): String? = if (registered) null else NOT_REGISTERED
}
