package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Test
import java.util.Collections
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * On Android an exception that escapes any thread ends the whole process
 * ("Whisper HID Service keeps stopping"). These guards turn the service's
 * entry points (keystroke and HID-callback tasks, receivers, handler
 * runnables, the foreground start) into a logged error instead.
 */
class GuardsTest {

    private val errors = Collections.synchronizedList(mutableListOf<Pair<String, Exception>>())
    private val onError: (String, Exception) -> Unit = { what, e -> errors += what to e }
    private val uncaught = Collections.synchronizedList(mutableListOf<Throwable>())

    // A worker thread like the service's hid-keystrokes thread, whose
    // uncaught exceptions are recorded instead of ending the test JVM.
    private fun worker(): ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "hid-keystrokes").apply { setUncaughtExceptionHandler { _, e -> uncaught += e } }
    }

    private fun ExecutorService.drain() {
        shutdown()
        assertTrue(awaitTermination(5, TimeUnit.SECONDS))
    }

    @Test
    fun anUnguardedTaskThatThrowsReachesTheUncaughtHandler() {
        // The crash path itself: on the phone this handler ends the process.
        val inner = worker()
        inner.execute { throw IllegalArgumentException("bad report") }
        inner.drain()
        assertEquals(1, uncaught.size)
    }

    @Test
    fun aGuardedTaskThatThrowsIsLoggedAndTheThreadKeepsWorking() {
        val inner = worker()
        val executor = GuardedExecutor(inner, "keystroke task", onError)
        var laterTaskRan = false
        executor.execute { throw IllegalArgumentException("bad report") }
        executor.execute { laterTaskRan = true }
        inner.drain()

        assertEquals(emptyList<Throwable>(), uncaught)
        assertEquals(1, errors.size)
        assertEquals("keystroke task", errors[0].first)
        assertEquals("bad report", errors[0].second.message)
        assertTrue(laterTaskRan)
    }

    @Test
    fun aTaskHandedToAShutDownExecutorIsLoggedNotThrown() {
        // A HID callback or a /type arriving after onDestroy shut the thread.
        val inner = worker()
        inner.drain()
        val executor = GuardedExecutor(inner, "keystroke task", onError)
        executor.execute { fail("must not run") }
        assertEquals(1, errors.size)
        assertTrue(errors[0].second is RejectedExecutionException)
    }

    @Test
    fun runGuardedLogsWhatThrewAndCarriesOn() {
        var after = false
        runGuarded("Bluetooth broadcast", onError) { error("receiver blew up") }
        after = true
        assertTrue(after)
        assertEquals("Bluetooth broadcast", errors.single().first)
        assertEquals("receiver blew up", errors.single().second.message)
    }

    @Test
    fun runGuardedRunsTheBlockWhenNothingThrows() {
        var ran = false
        runGuarded("reconnect attempt", onError) { ran = true }
        assertTrue(ran)
        assertEquals(0, errors.size)
    }

    @Test
    fun aForegroundStartRefusedInTheBackgroundIsReturnedNotThrown() {
        // Android 12+ throws ForegroundServiceStartNotAllowedException, an
        // IllegalStateException, when the system restarts the sticky service
        // while the app is in the background. Only SecurityException was caught.
        val refused = attemptForegroundStart {
            throw IllegalStateException("startForeground() not allowed due to mAllowStartForeground false")
        }
        assertTrue(refused is IllegalStateException)
    }

    @Test
    fun aForegroundStartWithoutBluetoothPermissionIsReturnedNotThrown() {
        val refused = attemptForegroundStart { throw SecurityException("needs BLUETOOTH_CONNECT") }
        assertTrue(refused is SecurityException)
    }

    @Test
    fun aForegroundStartThatWorksReturnsNull() {
        var started = false
        assertNull(attemptForegroundStart { started = true })
        assertTrue(started)
    }
}
