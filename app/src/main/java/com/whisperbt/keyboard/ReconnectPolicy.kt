package com.whisperbt.keyboard

/**
 * The auto-reconnect schedule, kept free of Android types so it can be unit
 * tested. 2, 4, 8, 16, 30 s for the first five attempts, 30 s until five
 * minutes have passed since the link dropped, then 60 s for as long as it
 * takes. Elapsed time only ever stretches the delay: it never ends the
 * retries (only "Bluetooth is off" or "no host known" does that, in the
 * service).
 */
object ReconnectPolicy {
    private val EARLY_DELAYS_MS = longArrayOf(2_000, 4_000, 8_000, 16_000, 30_000)
    const val SLOW_AFTER_MS = 5 * 60 * 1000L
    const val STEADY_DELAY_MS = 30_000L
    const val SLOW_DELAY_MS = 60_000L

    /** Delay before attempt [attempt] (1-based), [elapsedMs] after the drop. */
    fun delayMs(attempt: Int, elapsedMs: Long): Long = when {
        elapsedMs >= SLOW_AFTER_MS -> SLOW_DELAY_MS
        attempt in 1..EARLY_DELAYS_MS.size -> EARLY_DELAYS_MS[attempt - 1]
        else -> STEADY_DELAY_MS
    }

    /** After this long down the likelier cause is the far side. */
    const val CHECK_COMPUTER_AFTER_MS = 10 * 60 * 1000L

    /** Same words as the PWA banner (StatusBar.tsx); keep the two in step. */
    const val CHECK_COMPUTER_TEXT = "Still no link. Check that Bluetooth is on and in range on the computer."

    fun checkComputer(downMs: Long): Boolean = downMs > CHECK_COMPUTER_AFTER_MS

    /** The one reconnecting sentence the notification and the app screen share. */
    fun reconnectingText(attempt: Int, nextDelayMs: Long, downMs: Long): String {
        val base = "Reconnecting… (attempt $attempt, next try in ${nextDelayMs / 1000} s)"
        return if (checkComputer(downMs)) "$base $CHECK_COMPUTER_TEXT" else base
    }
}
