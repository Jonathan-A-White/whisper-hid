package com.whisperbt.keyboard

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

// On Android an exception that escapes ANY thread (main, the keystroke
// thread, a binder callback's executor) ends the whole process, and a sticky
// service that dies over and over is what puts "Whisper HID Service keeps
// stopping" on screen. The service's entry points run through these, so a
// bug in one of them costs an error line in /logs instead of the keyboard.

/** Runs [block]; an exception it throws goes to [onError] (named by [what]) instead of up the thread. */
inline fun runGuarded(what: String, onError: (String, Exception) -> Unit, block: () -> Unit) {
    try {
        block()
    } catch (e: Exception) {
        onError(what, e)
    }
}

/**
 * Every task handed to [inner] runs guarded, and a task the executor refuses
 * (it was shut down in onDestroy, and a HID callback or a /type still
 * arrived) is reported instead of thrown at the caller.
 */
class GuardedExecutor(
    private val inner: Executor,
    private val what: String,
    private val onError: (String, Exception) -> Unit
) : Executor {
    override fun execute(command: Runnable) {
        try {
            inner.execute { runGuarded(what, onError) { command.run() } }
        } catch (e: RejectedExecutionException) {
            onError(what, e)
        }
    }
}

/**
 * Calls [start] (Service.startForeground or Context.startForegroundService)
 * and returns why Android refused, or null when it worked. Two refusals are
 * expected: a SecurityException on Android 14+ without BLUETOOTH_CONNECT, and
 * on Android 12+ ForegroundServiceStartNotAllowedException (an
 * IllegalStateException) when the start comes from the background, which is
 * what a START_STICKY restart after the process died always is.
 */
fun attemptForegroundStart(start: () -> Unit): Exception? = try {
    start()
    null
} catch (e: IllegalStateException) {
    e
} catch (e: SecurityException) {
    e
}
