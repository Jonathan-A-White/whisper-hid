package com.whisperbt.keyboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * BroadcastReceiver that starts services on device boot if auto-start is enabled.
 *
 * Requires:
 *   android.permission.RECEIVE_BOOT_COMPLETED
 *   Termux:Boot for the Termux side (configured separately)
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
        private const val PREFS_NAME = "whisper_bt_prefs"
        private const val PREF_AUTOSTART = "auto_start"
        private const val PREF_PORT = "port"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != "android.intent.action.QUICKBOOT_POWERON") {
            return
        }

        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val autoStart = prefs.getBoolean(PREF_AUTOSTART, false)

        if (!autoStart) {
            Log.d(TAG, "Auto-start disabled — skipping")
            return
        }

        Log.i(TAG, "Boot completed — starting services")

        val port = prefs.getInt(PREF_PORT, SocketListenerService.DEFAULT_PORT)

        // Start BluetoothHidService (foreground)
        context.startForegroundService(Intent(context, BluetoothHidService::class.java))

        // Start SocketListenerService
        context.startService(Intent(context, SocketListenerService::class.java).apply {
            putExtra(SocketListenerService.EXTRA_PORT, port)
        })
    }
}
