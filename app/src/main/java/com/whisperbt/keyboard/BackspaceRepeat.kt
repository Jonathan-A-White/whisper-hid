package com.whisperbt.keyboard

/**
 * Holding the voice keyboard's backspace. [press] deletes one at once and
 * schedules the repeats; [release] and [cancel] stop them. Plain Kotlin: the
 * clock is [post]/[remove] (the main Handler's postDelayed and removeCallbacks)
 * and the delete is [deleteOne].
 *
 * A repeat that outlives the finger is a stuck key, so everything that can end
 * a touch (up, cancel, the finger leaving the key, the keyboard hiding or
 * losing the window) must call [release] or [cancel]; nothing is sent after.
 */
class BackspaceRepeat(
    post: (Runnable, Long) -> Unit,
    remove: (Runnable) -> Unit,
    private val deleteOne: () -> Unit
) {
    companion object {
        /** From the press to the first repeat. */
        const val INITIAL_DELAY_MS = 400L
        /** The gap between the first and second repeat. */
        const val START_INTERVAL_MS = 150L
        /** The fastest gap, about word-at-a-time speed: a hold never deletes everything at once. */
        const val CAP_INTERVAL_MS = 40L
        /** Repeating time over which the gap shrinks from [START_INTERVAL_MS] to [CAP_INTERVAL_MS]. */
        const val RAMP_MS = 2_000L

        /**
         * The wait before repeat [n] (0 = the first repeat after the press).
         * Never grows from one repeat to the next and never goes below
         * [CAP_INTERVAL_MS]: the gap shrinks linearly with the time spent
         * repeating, so the speed-up takes about [RAMP_MS] of holding.
         */
        fun delayBeforeRepeat(n: Int): Long {
            if (n <= 0) return INITIAL_DELAY_MS
            var elapsed = 0L // time spent repeating, from the first repeat
            var delay = START_INTERVAL_MS
            for (i in 1 until n) {
                elapsed += delay
                delay = gapAfter(elapsed)
                if (delay == CAP_INTERVAL_MS) break
            }
            return delay
        }

        private fun gapAfter(elapsedMs: Long): Long {
            val span = START_INTERVAL_MS - CAP_INTERVAL_MS
            val gap = START_INTERVAL_MS - span * elapsedMs / RAMP_MS
            return maxOf(CAP_INTERVAL_MS, gap)
        }
    }

    private val timer = OneShotTimer(post, remove) { tick() }
    private var held = false
    private var repeats = 0

    val isHeld: Boolean get() = held

    /** The finger went down: delete one now, then keep deleting while it stays. */
    fun press() {
        if (held) { deleteOne(); return }
        held = true
        repeats = 0
        deleteOne()
        timer.schedule(delayBeforeRepeat(0))
    }

    /** The finger came up. */
    fun release() = cancel()

    /** The touch ended any other way, or the key went away: stop at once. */
    fun cancel() {
        held = false
        timer.cancel()
    }

    private fun tick() {
        if (!held) return
        deleteOne()
        repeats++
        timer.schedule(delayBeforeRepeat(repeats))
    }
}
