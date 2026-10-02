package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Test

/**
 * The auto-reconnect schedule: 2, 4, 8, 16, 30 s, then 30 s until 5 minutes
 * have passed, then 60 s for as long as it takes. Time alone never gives up.
 */
class ReconnectPolicyTest {

    private val minute = 60_000L

    @Test
    fun `first five attempts back off 2 4 8 16 30 seconds`() {
        val delays = (1..5).map { ReconnectPolicy.delayMs(it, elapsedMs = 0L) }
        assertEquals(listOf(2000L, 4000L, 8000L, 16000L, 30000L), delays)
    }

    @Test
    fun `later attempts under five minutes wait 30 seconds`() {
        assertEquals(30_000L, ReconnectPolicy.delayMs(10, elapsedMs = 4 * minute))
        assertEquals(30_000L, ReconnectPolicy.delayMs(6, elapsedMs = 90_000L))
    }

    @Test
    fun `after five minutes the delay is one minute`() {
        for (m in listOf(6L, 20L, 120L)) {
            assertEquals("at $m min", 60_000L, ReconnectPolicy.delayMs(40, elapsedMs = m * minute))
        }
        assertEquals(60_000L, ReconnectPolicy.delayMs(14, elapsedMs = 5 * minute))
    }

    @Test
    fun `no elapsed time gives up`() {
        val oneWeek = 7 * 24 * 60 * minute
        for (attempt in listOf(1, 5, 6, 100, 100_000)) {
            for (elapsed in listOf(0L, minute, 5 * minute, 60 * minute, oneWeek)) {
                assertTrue(
                    "attempt $attempt at ${elapsed}ms must still have a positive delay",
                    ReconnectPolicy.delayMs(attempt, elapsed) > 0L
                )
            }
        }
    }
}
