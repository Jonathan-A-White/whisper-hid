package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Test

/**
 * Holding the voice keyboard's backspace: a tap deletes one, a hold keeps
 * deleting, slowly then faster up to a cap, and anything that ends the touch
 * stops it at once (a repeat that outlives the finger is a stuck key).
 */
class BackspaceRepeatTest {

    /** A hand-cranked clock standing in for the main Handler. */
    private class FakeClock {
        var now = 0L
        private val pending = mutableListOf<Pair<Long, Runnable>>()

        fun post(r: Runnable, delayMs: Long) { pending += (now + delayMs) to r }
        fun remove(r: Runnable) { pending.removeAll { it.second === r } }

        fun advance(ms: Long) {
            val end = now + ms
            while (true) {
                val next = pending.filter { it.first <= end }.minByOrNull { it.first } ?: break
                pending.remove(next)
                now = next.first
                next.second.run()
            }
            now = end
        }
    }

    /** A text field of [length] characters; each delete takes one away and is timestamped. */
    private class FakeField(length: Int, private val clock: FakeClock) {
        var remaining = length
        val deletedAt = mutableListOf<Long>()
        fun deleteOne() { if (remaining > 0) remaining--; deletedAt += clock.now }
    }

    private val clock = FakeClock()
    private val field = FakeField(10_000, clock)
    private val repeat = BackspaceRepeat(clock::post, clock::remove) { field.deleteOne() }

    // --- 1. a tap is exactly one backspace ---

    @Test
    fun `a tap sends exactly one backspace`() {
        repeat.press()
        clock.advance(100)
        repeat.release()
        clock.advance(5_000)
        assertEquals(1, field.deletedAt.size)
    }

    @Test
    fun `press deletes one at once`() {
        repeat.press()
        assertEquals(listOf(0L), field.deletedAt)
    }

    // --- 2. the schedule ---

    @Test
    fun `the first repeat waits the initial delay`() {
        assertEquals(BackspaceRepeat.INITIAL_DELAY_MS, BackspaceRepeat.delayBeforeRepeat(0))
        assertEquals(400L, BackspaceRepeat.delayBeforeRepeat(0))
    }

    @Test
    fun `repeats start at the slow interval`() {
        assertEquals(150L, BackspaceRepeat.delayBeforeRepeat(1))
    }

    @Test
    fun `delays never grow and none is below the cap`() {
        var previous = Long.MAX_VALUE
        for (n in 0..500) {
            val d = BackspaceRepeat.delayBeforeRepeat(n)
            assertTrue("delay $n grew: $d after $previous", d <= previous)
            assertTrue("delay $n below the cap: $d", d >= BackspaceRepeat.CAP_INTERVAL_MS)
            previous = d
        }
        assertEquals(BackspaceRepeat.CAP_INTERVAL_MS, BackspaceRepeat.delayBeforeRepeat(500))
    }

    @Test
    fun `the cap is reached within about two seconds of repeating`() {
        var elapsed = 0L
        var n = 1
        while (BackspaceRepeat.delayBeforeRepeat(n) > BackspaceRepeat.CAP_INTERVAL_MS) {
            elapsed += BackspaceRepeat.delayBeforeRepeat(n)
            n++
            assertTrue("never reaches the cap", n < 1000)
        }
        assertTrue("took $elapsed ms", elapsed in 1_500L..2_500L)
    }

    // --- 3. every way a touch can end stops the repeat ---

    @Test
    fun `release stops the repeat`() {
        repeat.press()
        clock.advance(1_000)
        repeat.release()
        val count = field.deletedAt.size
        clock.advance(5_000)
        assertEquals(count, field.deletedAt.size)
    }

    @Test
    fun `cancel stops the repeat at once`() {
        repeat.press()
        clock.advance(1_000)
        assertTrue(field.deletedAt.size > 2)
        repeat.cancel()
        val count = field.deletedAt.size
        clock.advance(5_000)
        assertEquals("a backspace was sent after cancel", count, field.deletedAt.size)
        assertFalse(repeat.isHeld)
    }

    @Test
    fun `cancel before the first repeat sends nothing more`() {
        repeat.press()
        clock.advance(399)
        repeat.cancel()
        clock.advance(5_000)
        assertEquals(1, field.deletedAt.size)
    }

    @Test
    fun `cancel when nothing is held does nothing`() {
        repeat.cancel()
        clock.advance(1_000)
        assertTrue(field.deletedAt.isEmpty())
    }

    @Test
    fun `a second press while held does not start a second repeat`() {
        repeat.press()
        repeat.press()
        clock.advance(1_000)
        val twice = field.deletedAt.size
        val other = FakeClock()
        val f = FakeField(10_000, other)
        val single = BackspaceRepeat(other::post, other::remove) { f.deleteOne() }
        single.press()
        other.advance(1_000)
        // the second press deleted one more at once, but the repeats did not double
        assertEquals(f.deletedAt.size + 1, twice)
    }

    @Test
    fun `a new hold after a release starts from the slow end again`() {
        repeat.press()
        clock.advance(3_000)
        repeat.release()
        field.deletedAt.clear()
        val start = clock.now
        repeat.press()
        clock.advance(400 + 150)
        assertEquals(listOf(start, start + 400, start + 550), field.deletedAt)
    }

    // --- 4. a phone-sized hold ---

    @Test
    fun `holding 2_5 seconds deletes more in the second half than the first, then stops on release`() {
        repeat.press()
        clock.advance(2_500)
        val firstHalf = field.deletedAt.count { it < 1_250 }
        val secondHalf = field.deletedAt.count { it in 1_250..2_500 }
        assertTrue("first $firstHalf, second $secondHalf", secondHalf > firstHalf)

        repeat.release()
        val total = field.deletedAt.size
        clock.advance(5_000)
        assertEquals(total, field.deletedAt.size)
        // within reason: far from everything, and the text is still mostly there
        assertTrue("deleted $total", total < 100)
        assertTrue(field.remaining > 9_900)
    }

    @Test
    fun `a long hold never goes faster than the cap`() {
        repeat.press()
        clock.advance(10_000)
        val gaps = field.deletedAt.zipWithNext { a, b -> b - a }
        assertTrue(gaps.drop(1).all { it >= BackspaceRepeat.CAP_INTERVAL_MS })
    }
}
