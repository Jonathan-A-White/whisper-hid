package com.whisperbt.keyboard

import com.whisperbt.keyboard.BluetoothHidService.Companion.CONNECT_SETTLE_MS
import com.whisperbt.keyboard.BluetoothHidService.Companion.IDLE_WAKE_AFTER_MS
import com.whisperbt.keyboard.BluetoothHidService.Companion.IDLE_WAKE_MS
import com.whisperbt.keyboard.BluetoothHidService.Companion.linkWarmup
import org.junit.Assert.*
import org.junit.Test

/**
 * The warm-up decision guards against the two ways a BT HID host silently
 * eats the leading keystrokes of a send: the post-connect settle window and
 * an idle link the host has powered down. See BluetoothHidService.
 */
class LinkWarmupTest {

    private val connectedAt = 1_000_000L

    @Test
    fun `waits out the remaining settle window right after connect`() {
        val now = connectedAt + 400
        val warmup = linkWarmup(now, connectedAt, lastReportAtMs = 0L)
        assertNotNull(warmup)
        assertEquals(CONNECT_SETTLE_MS - 400, warmup!!.waitMs)
        assertTrue(warmup.reason, warmup.reason.contains("connected"))
    }

    @Test
    fun `settle window wins over idle wake so they never stack`() {
        // Sent nothing yet AND freshly connected: only one wait, the settle.
        val now = connectedAt + 100
        val warmup = linkWarmup(now, connectedAt, lastReportAtMs = 0L)
        assertEquals(CONNECT_SETTLE_MS - 100, warmup!!.waitMs)
    }

    @Test
    fun `settled link with no report yet gets an idle wake`() {
        val now = connectedAt + CONNECT_SETTLE_MS + 30_000
        val warmup = linkWarmup(now, connectedAt, lastReportAtMs = 0L)
        assertNotNull(warmup)
        assertEquals(IDLE_WAKE_MS, warmup!!.waitMs)
    }

    @Test
    fun `warm link needs no wait`() {
        val now = connectedAt + 60_000
        val lastReport = now - 1_500 // typed 1.5s ago
        assertNull(linkWarmup(now, connectedAt, lastReport))
    }

    @Test
    fun `link quiet for exactly the idle threshold still counts as warm`() {
        val now = connectedAt + 60_000
        assertNull(linkWarmup(now, connectedAt, now - IDLE_WAKE_AFTER_MS))
    }

    @Test
    fun `link idle past the threshold gets a wake before typing`() {
        val now = connectedAt + 60_000
        val warmup = linkWarmup(now, connectedAt, now - IDLE_WAKE_AFTER_MS - 1)
        assertNotNull(warmup)
        assertEquals(IDLE_WAKE_MS, warmup!!.waitMs)
        assertTrue(warmup.reason, warmup.reason.contains("idle"))
    }

    @Test
    fun `typical dictation gap after a long-lived connection is woken`() {
        // Connected an hour ago, last dictation typed 20s ago — the case the
        // settle delay alone never covered.
        val now = connectedAt + 3_600_000
        val warmup = linkWarmup(now, connectedAt, now - 20_000)
        assertEquals(IDLE_WAKE_MS, warmup!!.waitMs)
    }

    @Test
    fun `wake window is short enough to be unnoticed after transcription`() {
        // Sanity bound so a future tweak doesn't turn every dictation into a wait.
        assertTrue(IDLE_WAKE_MS <= 2_000)
        assertTrue(IDLE_WAKE_AFTER_MS >= 2_000)
    }
}
