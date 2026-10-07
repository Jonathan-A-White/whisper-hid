package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * When the headset's call link (SCO) is open: only while a dictation runs,
 * unless "Keep the headset link warm" is on. A held link silences every other
 * app's audio on a headset that has a mic, so the default must be released.
 */
class HeadsetLinkControllerTest {

    private class FakeDriver : ScoDriver {
        var present = true
        val calls = mutableListOf<String>()
        var connectOnOpen = true
        lateinit var controller: HeadsetLinkController
        override fun canOpen() = present
        override fun open() {
            calls += "open"
            if (connectOnOpen) controller.onScoConnected()
        }
        override fun close() {
            calls += "close"
            controller.onScoDisconnected()
        }
    }

    private var now = 1_000L
    private lateinit var driver: FakeDriver

    private fun controller(keepWarm: Boolean = false): HeadsetLinkController {
        val c = HeadsetLinkController(driver, { now }, keepWarm)
        driver.controller = c
        return c
    }

    @Before
    fun setUp() {
        driver = FakeDriver()
    }

    @Test
    fun headsetConnectedWithNoDictationLeavesTheLinkClosed() {
        val c = controller()
        c.onHeadsetPresent()
        assertEquals(emptyList<String>(), driver.calls)
        assertFalse(c.dictating)
    }

    @Test
    fun dictationOpensTheLinkAndReportsItConnected() {
        val c = controller()
        val r = c.beginDictation(timeoutMs = 1_000)
        assertEquals(listOf("open"), driver.calls)
        assertTrue(r.connected)
        assertTrue(c.dictating)
    }

    @Test
    fun endingTheDictationClosesTheLink() {
        val c = controller()
        c.beginDictation(1_000)
        c.endDictation()
        assertEquals(listOf("open", "close"), driver.calls)
        assertFalse(c.dictating)
    }

    @Test
    fun noHeadsetMeansDictationDoesNotWaitOrOpen() {
        driver.present = false
        val c = controller()
        val r = c.beginDictation(1_000)
        assertFalse(r.connected)
        assertEquals(emptyList<String>(), driver.calls)
        assertTrue(c.dictating)
    }

    @Test
    fun aLinkThatNeverConnectsTimesOutInsteadOfBlockingForever() {
        driver.connectOnOpen = false
        val c = controller()
        val r = c.beginDictation(timeoutMs = 30)
        assertFalse(r.connected)
        assertTrue(c.dictating)
    }

    @Test
    fun waitedMsIsMeasuredWithTheClock() {
        driver.connectOnOpen = false
        val c = controller()
        val t = Thread {
            Thread.sleep(20)
            now += 750
            c.onScoConnected()
        }
        t.start()
        val r = c.beginDictation(timeoutMs = 5_000)
        t.join()
        assertTrue(r.connected)
        assertEquals(750L, r.waitedMs)
    }

    @Test
    fun aHeadsetThatAppearsMidDictationGetsTheLink() {
        driver.present = false
        val c = controller()
        c.beginDictation(1_000)
        driver.present = true
        c.onHeadsetPresent()
        assertEquals(listOf("open"), driver.calls)
    }

    @Test
    fun keepWarmOpensOnHeadsetAndSurvivesTheDictation() {
        val c = controller(keepWarm = true)
        c.onHeadsetPresent()
        assertEquals(listOf("open"), driver.calls)
        val r = c.beginDictation(1_000)
        assertTrue(r.connected)
        assertEquals(0L, r.waitedMs)
        c.endDictation()
        assertEquals(listOf("open"), driver.calls)
    }

    @Test
    fun turningKeepWarmOnOpensAndOffReleasesWhenIdle() {
        val c = controller()
        c.setKeepWarm(true)
        assertEquals(listOf("open"), driver.calls)
        c.setKeepWarm(false)
        assertEquals(listOf("open", "close"), driver.calls)
    }

    @Test
    fun turningKeepWarmOffDuringADictationKeepsTheLinkUntilItEnds() {
        val c = controller(keepWarm = true)
        c.onHeadsetPresent()
        c.beginDictation(1_000)
        c.setKeepWarm(false)
        assertEquals(listOf("open"), driver.calls)
        c.endDictation()
        assertEquals(listOf("open", "close"), driver.calls)
    }

    @Test
    fun aDictationThatNeverEndsIsReleasedAfterTheMaximumHold() {
        val c = controller()
        c.beginDictation(1_000)
        now += 9_999
        assertFalse(c.expireIfStale(maxMs = 10_000))
        assertTrue(c.dictating)
        now += 2
        assertTrue(c.expireIfStale(maxMs = 10_000))
        assertFalse(c.dictating)
        assertEquals(listOf("open", "close"), driver.calls)
    }

    @Test
    fun expireDoesNothingWhenNoDictationRuns() {
        val c = controller()
        assertFalse(c.expireIfStale(10_000))
        assertEquals(emptyList<String>(), driver.calls)
    }
}
