package com.whisperbt.keyboard

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
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

            // Termux:Boot's broadcast is not one of the boot exemptions:
            // Android 12+ refuses a foreground start from the background, and
            // that exception would end the process. Skip instead.
            val hidIntent = Intent(context, BluetoothHidService::class.java)
            attemptForegroundStart { ContextCompat.startForegroundService(context, hidIntent) }
                ?.let { Log.w("BootReceiver", "Could not start the HID service at boot", it) }
        }
    }
}
