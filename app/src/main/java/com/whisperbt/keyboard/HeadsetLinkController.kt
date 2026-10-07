package com.whisperbt.keyboard

/** The service's SCO machinery, behind an interface so the policy can be tested. */
interface ScoDriver {
    /** A headset with a mic is present and the user has not released it (Zoom mode). */
    fun canOpen(): Boolean
    fun open()
    fun close()
}

/**
 * Decides when the headset's call link (SCO) is open. A held SCO link
 * silences every other app's audio on a headset that has a mic (media, video,
 * assistant voice), so by default the link is open only while a dictation
 * runs; "Keep the headset link warm" ([keepWarm]) restores holding it for as
 * long as the headset is connected, which saves the link's set-up time on the
 * first word. Free of Android types: the service supplies the [driver] and
 * reports link state through [onScoConnected]/[onScoDisconnected].
 */
class HeadsetLinkController(
    private val driver: ScoDriver,
    private val nowMs: () -> Long,
    keepWarm: Boolean
) {
    data class Begin(val waitedMs: Long, val connected: Boolean)

    private val lock = Object()
    private var warm = keepWarm
    private var inDictation = false
    private var dictationStartedAtMs = 0L
    private var connected = false

    val dictating: Boolean get() = synchronized(lock) { inDictation }
    val keepWarm: Boolean get() = synchronized(lock) { warm }

    /** A headset with a mic appeared (or Zoom mode was switched off). */
    fun onHeadsetPresent() {
        if (synchronized(lock) { warm || inDictation }) driver.open()
    }

    fun onScoConnected() = synchronized(lock) {
        connected = true
        lock.notifyAll()
    }

    fun onScoDisconnected() = synchronized(lock) { connected = false }

    /**
     * A dictation is starting: open the link and wait up to [timeoutMs] for it,
     * so the recording does not start before the headset mic is routed. Blocks.
     * Returns how long the wait took and whether the link came up; either way
     * the dictation counts as running until [endDictation].
     */
    fun beginDictation(timeoutMs: Long): Begin {
        val startedAt = nowMs()
        val alreadyUp = synchronized(lock) {
            inDictation = true
            dictationStartedAtMs = startedAt
            connected
        }
        if (alreadyUp) return Begin(0L, true)
        if (!driver.canOpen()) return Begin(0L, false)
        driver.open()
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        val up = synchronized(lock) {
            while (!connected) {
                val leftMs = (deadline - System.nanoTime()) / 1_000_000L
                if (leftMs <= 0) break
                lock.wait(leftMs)
            }
            connected
        }
        return Begin(nowMs() - startedAt, up)
    }

    fun endDictation() {
        val release = synchronized(lock) {
            if (!inDictation) return
            inDictation = false
            // The driver closes asynchronously; a dictation that begins before
            // it has must not take the dying link for a live one.
            if (!warm) connected = false
            !warm
        }
        if (release) driver.close()
    }

    fun setKeepWarm(on: Boolean) {
        val action = synchronized(lock) {
            if (warm == on) return
            warm = on
            if (!on && !inDictation) connected = false
            if (inDictation) null else on
        }
        when (action) {
            true -> if (driver.canOpen()) driver.open()
            false -> driver.close()
            null -> Unit
        }
    }

    /** Ends a dictation whose end never came (a client that died); true if it did. */
    fun expireIfStale(maxMs: Long): Boolean {
        val stale = synchronized(lock) { inDictation && nowMs() - dictationStartedAtMs > maxMs }
        if (stale) endDictation()
        return stale
    }
}

/** Opens and closes the link around a dictation. */
interface DictationLink {
    fun open()
    fun close()
}

/** Holds the headset link from the moment recording is asked for until the text (or an error) is back. */
class DictationLinkTranscriber(
    private val inner: VoiceTranscriber,
    private val link: DictationLink
) : VoiceTranscriber {
    override fun start(): VoiceTranscriber.Outcome {
        link.open()
        val r = inner.start()
        if (r !is VoiceTranscriber.Outcome.Ok) link.close()
        return r
    }

    override fun stop(): VoiceTranscriber.Outcome =
        try { inner.stop() } finally { link.close() }
}
