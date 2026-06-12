package com.whisperbt.keyboard

import java.io.InputStream

/** Parsed HTTP request for the loopback control server. */
internal data class HttpRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: String
) {
    companion object {
        /**
         * Reads one request from the stream. The body is read as raw bytes:
         * Content-Length counts bytes, so reading it through a Reader
         * under-reads whenever the body contains multi-byte UTF-8 characters
         * and then blocks until the socket times out.
         */
        fun parse(input: InputStream): HttpRequest? {
            val requestLine = readLine(input) ?: return null
            val parts = requestLine.split(" ", limit = 3)
            if (parts.size < 2) return null

            val headers = mutableMapOf<String, String>()
            var line = readLine(input)
            while (line != null && line.isNotEmpty()) {
                val colonIdx = line.indexOf(':')
                if (colonIdx > 0) {
                    headers[line.substring(0, colonIdx).trim().lowercase()] =
                        line.substring(colonIdx + 1).trim()
                }
                line = readLine(input)
            }

            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = if (contentLength > 0) {
                val buf = ByteArray(contentLength)
                var read = 0
                while (read < contentLength) {
                    val n = input.read(buf, read, contentLength - read)
                    if (n == -1) break
                    read += n
                }
                String(buf, 0, read, Charsets.UTF_8)
            } else ""

            return HttpRequest(parts[0], parts[1], headers, body)
        }

        // Headers are ASCII, so byte-to-char is safe here
        private fun readLine(input: InputStream): String? {
            val sb = StringBuilder()
            while (true) {
                val b = input.read()
                if (b == -1) return if (sb.isEmpty()) null else sb.toString()
                if (b == '\n'.code) return sb.toString()
                if (b != '\r'.code) sb.append(b.toChar())
            }
        }
    }
}
