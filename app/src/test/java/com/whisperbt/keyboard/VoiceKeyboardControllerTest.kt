package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * The "Whisper voice" keyboard's state machine, driven with a fake
 * transcriber and a hand-cranked executor so every in-between state can be
 * observed: idle -> recording -> transcribing -> idle, and each error.
 */
class VoiceKeyboardControllerTest {

    private class FakeTranscriber : VoiceTranscriber {
        var startResult: VoiceTranscriber.Outcome = VoiceTranscriber.Outcome.Ok("")
        var stopResult: VoiceTranscriber.Outcome = VoiceTranscriber.Outcome.Ok("test one two")
        var starts = 0
        var stops = 0
        override fun start(): VoiceTranscriber.Outcome { starts++; return startResult }
        override fun stop(): VoiceTranscriber.Outcome { stops++; return stopResult }
    }

    private class FakeUi : VoiceKeyboardUi {
        val committed = mutableListOf<String>()
        val renders = mutableListOf<Pair<VoiceKeyboardController.State, String>>()
        override fun render(state: VoiceKeyboardController.State, status: String) {
            renders += state to status
        }
        override fun commitText(text: String) { committed += text }
    }

    private val queued = ArrayDeque<() -> Unit>()
    private lateinit var transcriber: FakeTranscriber
    private lateinit var ui: FakeUi
    private lateinit var controller: VoiceKeyboardController

    private fun runQueued() {
        while (queued.isNotEmpty()) queued.removeFirst().invoke()
    }

    @Before
    fun setUp() {
        transcriber = FakeTranscriber()
        ui = FakeUi()
        controller = VoiceKeyboardController(transcriber, ui) { queued.addLast(it) }
    }

    @Test
    fun `starts idle`() {
        assertEquals(VoiceKeyboardController.State.IDLE, controller.state)
    }

    @Test
    fun `tap then tap commits the returned text plus a space once`() {
        controller.onMicTap()
        runQueued()
        assertEquals(VoiceKeyboardController.State.RECORDING, controller.state)
        assertEquals(VoiceKeyboardController.STATUS_LISTENING, ui.renders.last().second)

        controller.onMicTap()
        runQueued()
        assertEquals(VoiceKeyboardController.State.IDLE, controller.state)
        assertEquals(listOf("test one two "), ui.committed)
        assertEquals(1, transcriber.starts)
        assertEquals(1, transcriber.stops)
    }

    @Test
    fun `shows transcribing while the stop call is pending`() {
        controller.onMicTap(); runQueued()
        controller.onMicTap()
        assertEquals(VoiceKeyboardController.State.TRANSCRIBING, controller.state)
        assertEquals(VoiceKeyboardController.STATUS_TRANSCRIBING, ui.renders.last().second)
        assertTrue(ui.committed.isEmpty())
        runQueued()
    }

    @Test
    fun `a second tap while transcribing does nothing`() {
        controller.onMicTap(); runQueued()
        controller.onMicTap()
        controller.onMicTap()
        controller.onMicTap()
        runQueued()
        assertEquals(1, transcriber.stops)
        assertEquals(1, transcriber.starts)
        assertEquals(listOf("test one two "), ui.committed)
        assertEquals(VoiceKeyboardController.State.IDLE, controller.state)
    }

    @Test
    fun `a second tap while the start call is pending does nothing`() {
        controller.onMicTap()
        controller.onMicTap()
        runQueued()
        assertEquals(1, transcriber.starts)
        assertEquals(0, transcriber.stops)
        assertEquals(VoiceKeyboardController.State.RECORDING, controller.state)
    }

    @Test
    fun `a server that does not answer on start commits nothing and says so`() {
        transcriber.startResult = VoiceTranscriber.Outcome.Unreachable
        controller.onMicTap()
        runQueued()
        assertEquals(VoiceKeyboardController.State.IDLE, controller.state)
        assertEquals("Whisper server is not running: start it in Termux", ui.renders.last().second)
        assertEquals(VoiceKeyboardController.STATUS_SERVER_DOWN, ui.renders.last().second)
        assertTrue(ui.committed.isEmpty())
    }

    @Test
    fun `a server that stops answering on stop commits nothing and says so`() {
        transcriber.stopResult = VoiceTranscriber.Outcome.Unreachable
        controller.onMicTap(); runQueued()
        controller.onMicTap(); runQueued()
        assertEquals(VoiceKeyboardController.State.IDLE, controller.state)
        assertEquals(VoiceKeyboardController.STATUS_SERVER_DOWN, ui.renders.last().second)
        assertTrue(ui.committed.isEmpty())
    }

    @Test
    fun `a server error is shown and commits nothing`() {
        transcriber.stopResult = VoiceTranscriber.Outcome.Failed("Failed to convert audio to WAV.")
        controller.onMicTap(); runQueued()
        controller.onMicTap(); runQueued()
        assertEquals(VoiceKeyboardController.State.IDLE, controller.state)
        assertEquals("Failed to convert audio to WAV.", ui.renders.last().second)
        assertTrue(ui.committed.isEmpty())
    }

    @Test
    fun `an error on start leaves the mic ready for another try`() {
        transcriber.startResult = VoiceTranscriber.Outcome.Failed("Already recording.")
        controller.onMicTap(); runQueued()
        assertEquals(VoiceKeyboardController.State.IDLE, controller.state)

        transcriber.startResult = VoiceTranscriber.Outcome.Ok("")
        controller.onMicTap(); runQueued()
        assertEquals(VoiceKeyboardController.State.RECORDING, controller.state)
    }

    @Test
    fun `blank text commits nothing`() {
        transcriber.stopResult = VoiceTranscriber.Outcome.Ok("   ")
        controller.onMicTap(); runQueued()
        controller.onMicTap(); runQueued()
        assertTrue(ui.committed.isEmpty())
        assertEquals(VoiceKeyboardController.State.IDLE, controller.state)
        assertEquals(VoiceKeyboardController.STATUS_NO_SPEECH, ui.renders.last().second)
    }

    @Test
    fun `surrounding whitespace is trimmed before the single trailing space`() {
        transcriber.stopResult = VoiceTranscriber.Outcome.Ok("  hello there \n")
        controller.onMicTap(); runQueued()
        controller.onMicTap(); runQueued()
        assertEquals(listOf("hello there "), ui.committed)
    }

    @Test
    fun `a second dictation works after the first`() {
        repeat(2) {
            controller.onMicTap(); runQueued()
            controller.onMicTap(); runQueued()
        }
        assertEquals(listOf("test one two ", "test one two "), ui.committed)
    }
}
