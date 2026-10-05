package com.whisperbt.keyboard

import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

/** Talks to the Termux Whisper server on localhost:9876, the same two calls the PWA makes. */
class HttpVoiceTranscriber(private val baseUrl: String = "http://localhost:9876") : VoiceTranscriber {

    override fun start() = post("/transcribe/start", readTimeoutMs = 10_000)

    // The server waits ~2s for the recording file, then transcribes: allow a long dictation.
    override fun stop() = post("/transcribe/stop", readTimeoutMs = 180_000)

    private fun post(path: String, readTimeoutMs: Int): VoiceTranscriber.Outcome {
        val conn = try {
            (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 3_000
                readTimeout = readTimeoutMs
            }
        } catch (e: IOException) {
            return VoiceTranscriber.Outcome.Unreachable
        }
        return try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val json = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
            if (code in 200..299) {
                VoiceTranscriber.Outcome.Ok(json.optString("text", ""))
            } else {
                VoiceTranscriber.Outcome.Failed(
                    json.optString("message", "").ifEmpty { "Whisper server error ($code)" }
                )
            }
        } catch (e: ConnectException) {
            VoiceTranscriber.Outcome.Unreachable
        } catch (e: SocketTimeoutException) {
            VoiceTranscriber.Outcome.Failed("Whisper server timed out")
        } catch (e: IOException) {
            VoiceTranscriber.Outcome.Unreachable
        } finally {
            conn.disconnect()
        }
    }
}
