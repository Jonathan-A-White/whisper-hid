package com.whisperbt.keyboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == "com.termux.app.TermuxBoot.BOOT_COMPLETED"
        ) {
            val prefs = context.getSharedPreferences("whisper_keyboard_prefs", Context.MODE_PRIVATE)
            val autoStart = prefs.getBoolean("auto_start_boot", false)
            if (!autoStart) return

            val hidIntent = Intent(context, BluetoothHidService::class.java)
            ContextCompat.startForegroundService(context, hidIntent)

            val socketIntent = Intent(context, SocketListenerService::class.java)
            context.startService(socketIntent)
        }
    }
}
