package com.whisperbt.keyboard

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    companion object {
        private const val PERM_REQUEST_CODE = 1001
        private const val PWA_BASE_URL = "https://jonathan-a-white.github.io/whisper-hid/"
    }

    private var hidService: BluetoothHidService? = null
    private var hidBound = false

    private lateinit var statusService: TextView
    private lateinit var statusBluetooth: TextView
    private lateinit var btnOpenPwa: Button
    private lateinit var btnStopService: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusService = findViewById(R.id.statusService)
        statusBluetooth = findViewById(R.id.statusBluetooth)
        btnOpenPwa = findViewById(R.id.btnOpenPwa)
        btnStopService = findViewById(R.id.btnStopService)

        btnOpenPwa.setOnClickListener { openPwa() }
        btnStopService.setOnClickListener { stopHidService() }

        requestPermissions()
        startHidService()
    }

    override fun onStart() {
        super.onStart()
        bindHidService()
    }

    override fun onStop() {
        unbindHidService()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun openPwa() {
        val token = hidService?.authToken
        if (token.isNullOrEmpty()) {
            Toast.makeText(this, "Service not ready yet", Toast.LENGTH_SHORT).show()
            return
        }
        val url = "$PWA_BASE_URL?token=$token"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
    }

    private fun stopHidService() {
        unbindHidService()
        stopService(Intent(this, BluetoothHidService::class.java))
        statusService.text = "Service: Stopped"
        statusBluetooth.text = ""
    }

    private fun updateStatus() {
        val service = hidService
        if (service == null) {
            statusService.text = "Service: Starting..."
            statusBluetooth.text = ""
            return
        }

        statusService.text = "Service: Running"

        when (service.getBtState()) {
            BluetoothHidService.BtState.CONNECTED -> {
                val name = service.getConnectedDeviceName() ?: "Unknown"
                statusBluetooth.text = "Bluetooth: Connected to \"$name\""
            }
            BluetoothHidService.BtState.REGISTERED ->
                statusBluetooth.text = "Bluetooth: Waiting for connection..."
            BluetoothHidService.BtState.RECONNECTING ->
                statusBluetooth.text = "Bluetooth: Reconnecting..."
            BluetoothHidService.BtState.FAILED ->
                statusBluetooth.text = "Bluetooth: Connection failed"
            BluetoothHidService.BtState.IDLE ->
                statusBluetooth.text = "Bluetooth: Initializing..."
        }
    }

    // --- Permissions ---

    private fun requestPermissions() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.BLUETOOTH_SCAN)
            }
        }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERM_REQUEST_CODE)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERM_REQUEST_CODE) {
            val denied = grantResults.any { it != PackageManager.PERMISSION_GRANTED }
            if (denied) {
                Toast.makeText(this, "Bluetooth permissions are required", Toast.LENGTH_LONG).show()
            }
        }
    }

    // --- Service lifecycle ---

    private fun startHidService() {
        val intent = Intent(this, BluetoothHidService::class.java)
        ContextCompat.startForegroundService(this, intent)
    }

    private fun bindHidService() {
        val intent = Intent(this, BluetoothHidService::class.java)
        bindService(intent, hidConnection, Context.BIND_AUTO_CREATE)
    }

    private fun unbindHidService() {
        if (hidBound) {
            unbindService(hidConnection)
            hidBound = false
            hidService = null
        }
    }

    private val hidConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            hidService = (service as BluetoothHidService.LocalBinder).getService()
            hidBound = true
            updateStatus()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            hidService = null
            hidBound = false
        }
    }
}
