package com.whisperbt.keyboard

import android.app.Application
import android.content.Context
import java.io.File

/** Installs the crash recorder before anything else in the process runs. */
class WhisperApp : Application() {

    companion object {
        /** The crash records in this app's storage (read by GET /crash). */
        fun crashRecorder(context: Context) =
            CrashRecorder(File(context.filesDir, "crashes"), BuildConfig.APP_VERSION)
    }

    override fun onCreate() {
        super.onCreate()
        crashRecorder(this).install()
    }
}
