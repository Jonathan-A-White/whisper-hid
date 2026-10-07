package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Test

/** The voice keyboard holds the headset link only between tapping the mic and getting the text. */
class DictationLinkTranscriberTest {

    private val events = mutableListOf<String>()

    private val link = object : DictationLink {
        override fun open() { events += "link-open" }
        override fun close() { events += "link-close" }
    }

    private class Inner(val events: MutableList<String>) : VoiceTranscriber {
        var startResult: VoiceTranscriber.Outcome = VoiceTranscriber.Outcome.Ok("")
        var stopResult: VoiceTranscriber.Outcome = VoiceTranscriber.Outcome.Ok("hello")
        override fun start(): VoiceTranscriber.Outcome { events += "start"; return startResult }
        override fun stop(): VoiceTranscriber.Outcome { events += "stop"; return stopResult }
    }

    @Test
    fun linkOpensBeforeRecordingStartsAndClosesAfterStop() {
        val t = DictationLinkTranscriber(Inner(events), link)
        t.start()
        t.stop()
        assertEquals(listOf("link-open", "start", "stop", "link-close"), events)
    }

    @Test
    fun aFailedStartReleasesTheLink() {
        val inner = Inner(events).apply { startResult = VoiceTranscriber.Outcome.Unreachable }
        val t = DictationLinkTranscriber(inner, link)
        t.start()
        assertEquals(listOf("link-open", "start", "link-close"), events)
    }

    @Test
    fun aFailedStopStillReleasesTheLink() {
        val inner = Inner(events).apply { stopResult = VoiceTranscriber.Outcome.Failed("boom") }
        val t = DictationLinkTranscriber(inner, link)
        t.start()
        val r = t.stop()
        assertTrue(r is VoiceTranscriber.Outcome.Failed)
        assertEquals("link-close", events.last())
    }

    @Test
    fun resultsPassThroughUnchanged() {
        val t = DictationLinkTranscriber(Inner(events), link)
        assertEquals(VoiceTranscriber.Outcome.Ok(""), t.start())
        assertEquals(VoiceTranscriber.Outcome.Ok("hello"), t.stop())
    }
}
