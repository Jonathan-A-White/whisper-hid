package com.whisperbt.keyboard

import java.io.ByteArrayInputStream
import org.junit.Assert.*
import org.junit.Test

class HttpRequestTest {

    private fun parse(raw: String): HttpRequest? =
        HttpRequest.parse(ByteArrayInputStream(raw.toByteArray(Charsets.UTF_8)))

    private fun post(body: String): String {
        val bytes = body.toByteArray(Charsets.UTF_8)
        return "POST /type HTTP/1.1\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "\r\n" +
            body
    }

    @Test
    fun `parses request line and headers`() {
        val request = parse("GET /status HTTP/1.1\r\nAuthorization: Bearer abc\r\n\r\n")
        assertNotNull(request)
        assertEquals("GET", request!!.method)
        assertEquals("/status", request.path)
        assertEquals("Bearer abc", request.headers["authorization"])
        assertEquals("", request.body)
    }

    @Test
    fun `reads ascii body fully`() {
        val body = """{"text":"hello world","append":" "}"""
        assertEquals(body, parse(post(body))!!.body)
    }

    @Test
    fun `reads body with multi-byte utf8 characters`() {
        // Regression: Content-Length counts bytes, and reading the body as
        // chars made requests with multi-byte characters hang until the
        // socket timed out (no response ever sent).
        val body = """{"text":"├── CLAUDE.md — café 🎤","append":" "}"""
        assertEquals(body, parse(post(body))!!.body)
    }

    @Test
    fun `does not read past content-length`() {
        val body = """{"text":"first"}"""
        val raw = post(body) + "GARBAGE-AFTER-BODY"
        assertEquals(body, parse(raw)!!.body)
    }

    @Test
    fun `empty stream returns null`() {
        assertNull(parse(""))
    }

    @Test
    fun `malformed request line returns null`() {
        assertNull(parse("NONSENSE\r\n\r\n"))
    }
}
