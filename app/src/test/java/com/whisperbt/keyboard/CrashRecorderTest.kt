package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.Collections

/**
 * A crash leaves a record in the app's storage (the newest five kept), and
 * the HID service's GET /crash serves the newest, so it can be read with curl
 * from Termux after the fact.
 */
class CrashRecorderTest {

    @get:Rule val tmp = TemporaryFolder()

    private var now = 1_791_494_000_000L // 2026-10-08T21:13:20Z

    private fun recorder() = CrashRecorder(tmp.root.resolve("crashes"), "1.0.900+abc1234", { now })

    @Test
    fun anExceptionOnAWorkerThreadIsWrittenAndTheCrashRouteServesIt() {
        val handedOn = Collections.synchronizedList(mutableListOf<Throwable>())
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        // Stands in for Android's own handler, which ends the process.
        Thread.setDefaultUncaughtExceptionHandler { _, e -> handedOn += e }
        try {
            recorder().install()
            val worker = Thread({ throw IllegalStateException("boom on the worker") }, "hid-keystrokes")
            worker.start()
            worker.join()
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(previous)
        }

        assertEquals(1, tmp.root.resolve("crashes").listFiles()!!.size)
        // A fresh recorder reads it back, as the restarted service does.
        val reply = recorder().reply()
        assertEquals(200, reply.code)
        assertTrue(reply.body, reply.body.contains("time: 2026-10-08T21:13:20Z"))
        assertTrue(reply.body, reply.body.contains("thread: hid-keystrokes"))
        assertTrue(reply.body, reply.body.contains("version: 1.0.900+abc1234"))
        assertTrue(reply.body, reply.body.contains("java.lang.IllegalStateException: boom on the worker"))
        assertTrue(reply.body, reply.body.contains("at com.whisperbt.keyboard.CrashRecorderTest"))
        // Recording never swallows the crash: Android still gets it.
        assertEquals("boom on the worker", handedOn.single().message)
    }

    @Test
    fun withNoCrashRecordedTheRouteSaysSo() {
        val reply = recorder().reply()
        assertEquals(404, reply.code)
        assertTrue(reply.body.startsWith("No crash recorded"))
    }

    @Test
    fun theRouteServesTheNewestRecord() {
        val r = recorder()
        r.record(Thread.currentThread(), RuntimeException("first"))
        now += 60_000
        r.record(Thread.currentThread(), RuntimeException("second"))
        assertTrue(r.reply().body.contains("RuntimeException: second"))
        assertFalse(r.reply().body.contains("RuntimeException: first"))
    }

    @Test
    fun theNewestNamesTheOlderOnesAndAllServesEveryRecordNewestFirst() {
        // A real crash, then the sticky restart refused: the refusal is newer.
        val r = recorder()
        r.record(Thread.currentThread(), NullPointerException("the real crash"))
        now += 5_000
        r.record(Thread.currentThread(), IllegalStateException("not allowed"), "Not a crash: refused")

        val newest = r.reply().body
        assertTrue(newest.startsWith("Not a crash: refused"))
        assertTrue(newest, newest.contains("1 older record(s) kept: curl 'http://127.0.0.1:9877/crash?all=1'"))

        val all = r.reply(all = true).body
        assertTrue(all.indexOf("Not a crash: refused") < all.indexOf("the real crash"))
        assertTrue(all.contains("\n----\n"))
    }

    @Test
    fun onlyTheNewestFiveAreKept() {
        val r = recorder()
        for (i in 1..7) {
            r.record(Thread.currentThread(), RuntimeException("crash $i"))
            now += 1_000
        }
        val files = tmp.root.resolve("crashes").listFiles()!!.map { it.readText() }
        assertEquals(5, files.size)
        assertTrue(files.none { it.contains("crash 1\n") || it.contains("crash 2\n") })
        assertTrue(files.any { it.contains("crash 7") })
    }

    @Test
    fun twoCrashesInTheSameMillisecondAreBothKept() {
        val r = recorder()
        r.record(Thread.currentThread(), RuntimeException("one"))
        r.record(Thread.currentThread(), RuntimeException("two"))
        assertEquals(2, tmp.root.resolve("crashes").listFiles()!!.size)
        assertTrue(r.reply().body.contains("RuntimeException: two"))
    }

    @Test
    fun aRecordCanBeTitledAsNotACrash() {
        val r = recorder()
        r.record(Thread.currentThread(), IllegalStateException("not allowed"), "Not a crash: refused")
        assertTrue(r.reply().body.startsWith("Not a crash: refused\n"))
    }
}
