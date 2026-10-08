package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch

/**
 * The reconnect and SCO retry timers. The service used to keep the pending
 * Runnable in a nullable field and post it with `field!!`; the HID callback
 * thread cancelling (field = null) between the main thread's assignment and
 * its `!!` was a NullPointerException that ended the process.
 */
class OneShotTimerTest {

    private class FakeHandler {
        val pending: MutableList<Runnable> = Collections.synchronizedList(mutableListOf())
        val delays: MutableList<Long> = Collections.synchronizedList(mutableListOf())
        fun post(r: Runnable, delayMs: Long) { pending += r; delays += delayMs }
        fun remove(r: Runnable) { synchronized(pending) { pending.removeAll { it === r } } }
        fun runAll() { val due = pending.toList(); pending.clear(); due.forEach { it.run() } }
    }

    @Test
    fun scheduleRunsTheActionOnceAfterTheDelay() {
        val h = FakeHandler()
        var runs = 0
        val timer = OneShotTimer(h::post, h::remove) { runs++ }
        timer.schedule(3_000L)
        assertEquals(listOf(3_000L), h.delays)
        h.runAll()
        assertEquals(1, runs)
    }

    @Test
    fun reschedulingReplacesThePendingRun() {
        val h = FakeHandler()
        var runs = 0
        val timer = OneShotTimer(h::post, h::remove) { runs++ }
        timer.schedule(2_000L)
        timer.schedule(5_000L)
        assertEquals(1, h.pending.size)
        h.runAll()
        assertEquals(1, runs)
    }

    @Test
    fun cancelRemovesThePendingRunAndIsSafeWhenNothingIsPending() {
        val h = FakeHandler()
        var runs = 0
        val timer = OneShotTimer(h::post, h::remove) { runs++ }
        timer.cancel()
        timer.schedule(2_000L)
        timer.cancel()
        h.runAll()
        assertEquals(0, runs)
    }

    @Test
    fun cancelFromAnotherThreadWhileSchedulingNeverThrows() {
        // Main thread re-arming the reconnect while the HID callback thread
        // cancels it on STATE_CONNECTED, over and over.
        val h = FakeHandler()
        val timer = OneShotTimer(h::post, h::remove) {}
        val failures = Collections.synchronizedList(mutableListOf<Throwable>())
        val go = CountDownLatch(1)
        fun hammer(work: () -> Unit) = Thread {
            go.await()
            try { repeat(100_000) { work() } } catch (e: Throwable) { failures += e }
        }.apply { start() }

        val scheduler = hammer { timer.schedule(1_000L) }
        val canceller = hammer { timer.cancel() }
        go.countDown()
        scheduler.join()
        canceller.join()

        assertEquals(emptyList<Throwable>(), failures)
        timer.cancel()
        assertEquals(0, h.pending.size)
    }
}
