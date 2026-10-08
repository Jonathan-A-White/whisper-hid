package com.whisperbt.keyboard

import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.time.Instant
import java.util.Locale

/**
 * Keeps a record of crashes in the app's storage so they can be read after
 * the fact: the phone shows "keeps stopping" but no logcat is ever at hand.
 * [install] makes it the process's uncaught-exception handler (WhisperApp
 * does this first thing); each crash becomes one file in [dir] with the time,
 * thread, app version and stack trace, the newest [keep] are kept, and the
 * HID service's GET /crash serves the newest ([reply]). Free of Android types
 * so it can be tested.
 */
class CrashRecorder(
    private val dir: File,
    private val appVersion: String,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val keep: Int = 5
) {
    data class Reply(val code: Int, val body: String)

    /**
     * Records every uncaught exception, then hands it on to the handler that
     * was there before (Android's, which ends the process as it always did).
     */
    fun install() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                record(thread, error)
            } catch (_: Throwable) {
                // Never let the record get in the way of the crash itself.
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /** Writes one record and drops all but the newest [keep]. */
    @Synchronized
    fun record(thread: Thread, error: Throwable, title: String = "Whisper HID Service crash"): File {
        dir.mkdirs()
        val ms = nowMs()
        val stack = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
        val text = buildString {
            append(title).append('\n')
            append("time: ").append(Instant.ofEpochMilli(ms)).append('\n')
            append("thread: ").append(thread.name).append('\n')
            append("version: ").append(appVersion).append('\n')
            append('\n')
            append(stack)
        }
        // Zero-padded so names sort in time order; a counter keeps two
        // records from the same millisecond apart.
        var seq = 0
        var file: File
        do {
            file = File(dir, String.format(Locale.ROOT, "crash-%013d-%02d.txt", ms, seq++))
        } while (file.exists())
        file.writeText(text)
        records().dropLast(keep).forEach { it.delete() }
        return file
    }

    /** The newest record's text, or null when there is none. */
    fun newest(): String? = records().lastOrNull()?.readText()

    /**
     * The answer to GET /crash: the newest record, and a line naming the older
     * ones when there are any (a crash is often followed by a refused restart,
     * which is newer); with [all] (GET /crash?all=1) every kept record, newest first.
     */
    fun reply(all: Boolean = false): Reply {
        val newestFirst = records().reversed()
        if (newestFirst.isEmpty()) return Reply(404, "No crash recorded.\n")
        if (all) return Reply(200, newestFirst.joinToString("\n----\n\n") { it.readText() })
        val older = newestFirst.size - 1
        val footer = if (older == 0) "" else
            "\n$older older record(s) kept: curl 'http://127.0.0.1:9877/crash?all=1'\n"
        return Reply(200, newestFirst.first().readText() + footer)
    }

    private fun records(): List<File> =
        dir.listFiles { f -> f.name.startsWith("crash-") && f.name.endsWith(".txt") }
            ?.sortedBy { it.name }
            .orEmpty()
}
