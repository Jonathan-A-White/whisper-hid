package com.whisperbt.keyboard

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == "com.termux.app.TermuxBoot.BOOT_COMPLETED"
        ) {
            val prefs = context.getSharedPreferences("whisper_keyboard_prefs", Context.MODE_PRIVATE)
            val autoStart = prefs.getBoolean("auto_start_boot", false)
            if (!autoStart) return

            // A connectedDevice foreground service can't start without
            // BLUETOOTH_CONNECT on Android 12+ — skip autostart until granted.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED
            ) {
                return
            }

            val hidIntent = Intent(context, BluetoothHidService::class.java)
            ContextCompat.startForegroundService(context, hidIntent)
        }
    }
}
