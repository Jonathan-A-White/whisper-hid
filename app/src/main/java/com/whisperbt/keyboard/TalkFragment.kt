package com.whisperbt.keyboard

import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

class TalkFragment : Fragment() {

    private lateinit var pttButton: Button
    private lateinit var statusText: TextView
    private lateinit var statusDot: View
    private lateinit var lastTranscription: TextView
    private lateinit var pinnedRecycler: RecyclerView
    private lateinit var pinnedHeader: TextView
    private lateinit var pinnedAdapter: PinnedAdapter

    private var toneGen: ToneGenerator? = null
    private var vibrator: Vibrator? = null
    private var pttRecording = false

    private val mainActivity get() = activity as? MainActivity

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View? {
        return inflater.inflate(R.layout.fragment_talk, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        pttButton = view.findViewById(R.id.pttButton)
        statusText = view.findViewById(R.id.statusText)
        statusDot = view.findViewById(R.id.statusDot)
        lastTranscription = view.findViewById(R.id.lastTranscription)
        pinnedRecycler = view.findViewById(R.id.pinnedRecycler)
        pinnedHeader = view.findViewById(R.id.pinnedHeader)

        try {
            toneGen = ToneGenerator(AudioManager.STREAM_NOTIFICATION, ToneGenerator.MAX_VOLUME)
        } catch (_: RuntimeException) {}

        @Suppress("DEPRECATION")
        vibrator = requireContext().getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator

        setupPttButton()
        setupPinnedList()
    }

    override fun onResume() {
        super.onResume()
        if (!isHidden) onBecameVisible()
    }

    override fun onPause() {
        mainActivity?.setServiceListener(null)
        super.onPause()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) onBecameVisible()
        else mainActivity?.setServiceListener(null)
    }

    private fun onBecameVisible() {
        refreshPinned()
        updateConnectionStatus()
        refreshLastTranscription()
        mainActivity?.setServiceListener(serviceListener)
    }

    override fun onDestroyView() {
        resetPttButton()
        toneGen?.release()
        toneGen = null
        super.onDestroyView()
    }

    private fun setupPttButton() {
        pttButton.setOnClickListener {
            if (!pttRecording) {
                pttRecording = true
                mainActivity?.socketService?.pttStart()
                toneGen?.startTone(ToneGenerator.TONE_PROP_BEEP, 160)
                haptic(longArrayOf(0, 60))
                pttButton.text = getString(R.string.recording)
                pttButton.setBackgroundResource(R.drawable.talk_button_recording)
                pttButton.animate().scaleX(1.05f).scaleY(1.05f).setDuration(150).start()
                mainActivity?.appendLog("[PTT] Recording...")
            } else {
                pttRecording = false
                mainActivity?.socketService?.pttStop()
                toneGen?.startTone(ToneGenerator.TONE_PROP_BEEP2, 120)
                haptic(longArrayOf(0, 40, 80, 40))
                pttButton.text = getString(R.string.hold_to_talk)
                pttButton.setBackgroundResource(R.drawable.talk_button_idle)
                pttButton.animate().scaleX(1.0f).scaleY(1.0f).setDuration(150).start()
                mainActivity?.appendLog("[PTT] Stopped — transcribing...")
            }
        }
    }

    private fun setupPinnedList() {
        pinnedAdapter = PinnedAdapter(emptyList()) { entry ->
            sendText(entry.text)
        }
        pinnedRecycler.layoutManager = LinearLayoutManager(
            requireContext(), LinearLayoutManager.HORIZONTAL, false
        )
        pinnedRecycler.adapter = pinnedAdapter
    }

    fun refreshPinned() {
        if (!isAdded) return
        val pinned = mainActivity?.db?.getPinned() ?: emptyList()
        if (pinned.isEmpty()) {
            pinnedHeader.visibility = View.GONE
            pinnedRecycler.visibility = View.GONE
        } else {
            pinnedHeader.visibility = View.VISIBLE
            pinnedRecycler.visibility = View.VISIBLE
            pinnedAdapter.updateItems(pinned)
        }
    }

    private fun refreshLastTranscription() {
        val latest = mainActivity?.db?.getLatest()
        if (latest != null) {
            lastTranscription.visibility = View.VISIBLE
            lastTranscription.text = "Last: ${latest.text}"
        }
    }

    private fun sendText(text: String) {
        val hidService = mainActivity?.hidService
        if (hidService?.isConnected() == true) {
            val toSend = buildString {
                append(text)
                if (mainActivity?.socketService?.appendNewline == true) append('\n')
                else if (mainActivity?.socketService?.appendSpace == true) append(' ')
            }
            hidService.sendString(toSend)
            Toast.makeText(requireContext(), "Sent: ${text.take(50)}", Toast.LENGTH_SHORT).show()
            mainActivity?.appendLog("[Resend] $text")
        } else {
            Toast.makeText(requireContext(), "Not connected", Toast.LENGTH_SHORT).show()
        }
    }

    fun updateConnectionStatus() {
        if (!isAdded) return
        val connected = mainActivity?.hidService?.isConnected() == true
        val deviceName = mainActivity?.hidService?.getConnectedDeviceName()

        if (connected && deviceName != null) {
            statusText.text = "Connected to $deviceName"
            setStatusDotColor(requireContext().getColor(R.color.status_connected))
        } else {
            statusText.text = getString(R.string.status_disconnected)
            setStatusDotColor(requireContext().getColor(R.color.status_disconnected))
        }
    }

    private fun setStatusDotColor(color: Int) {
        val bg = statusDot.background
        if (bg is GradientDrawable) {
            bg.mutate()
            (bg as GradientDrawable).setColor(color)
        }
    }

    fun onNewTranscription(text: String) {
        if (!isAdded) return
        lastTranscription.visibility = View.VISIBLE
        lastTranscription.text = "Last: $text"
    }

    private fun haptic(timings: LongArray) {
        vibrator?.vibrate(VibrationEffect.createWaveform(timings, -1))
    }

    private fun resetPttButton() {
        if (pttRecording) {
            mainActivity?.socketService?.pttStop()
            pttRecording = false
        }
        pttButton.text = getString(R.string.hold_to_talk)
        pttButton.setBackgroundResource(R.drawable.talk_button_idle)
        pttButton.scaleX = 1.0f
        pttButton.scaleY = 1.0f
    }

    private val serviceListener = object : MainActivity.ServiceListener {
        override fun onConnectionStateChanged(connected: Boolean, deviceName: String?) {
            activity?.runOnUiThread { updateConnectionStatus() }
        }

        override fun onTranscription(text: String) {
            activity?.runOnUiThread { onNewTranscription(text) }
        }

        override fun onStatusChanged(status: String) {}
    }
}
