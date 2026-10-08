package com.whisperbt.keyboard

/**
 * A delayed [action] that can be armed and cancelled from any thread. It owns
 * one Runnable for life, so there is no nullable field for one thread to clear
 * between another thread setting it and posting it: the reconnect timer used
 * to do `reconnectRunnable = Runnable {..}; handler.postDelayed(reconnectRunnable!!, ..)`
 * on the main thread while HID callbacks cancelled it (field = null) on the
 * keystroke thread, and that `!!` could throw. [post] and [remove] are the
 * Handler's postDelayed and removeCallbacks, which are thread-safe.
 */
class OneShotTimer(
    private val post: (Runnable, Long) -> Unit,
    private val remove: (Runnable) -> Unit,
    action: () -> Unit
) {
    private val tick = Runnable { action() }

    /** Runs the action once, [delayMs] from now, replacing any pending run. */
    fun schedule(delayMs: Long) {
        remove(tick)
        post(tick, delayMs)
    }

    fun cancel() = remove(tick)
}
