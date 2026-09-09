package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Test

class HidKeyMapperTest {

    @Test
    fun `lowercase a maps to keycode 0x04`() {
        val report = HidKeyMapper.map('a')
        assertNotNull(report)
        assertEquals(0x04.toByte(), report!!.keycode)
        assertEquals(0x00.toByte(), report.modifier)
    }

    @Test
    fun `uppercase A maps to keycode 0x04 with shift`() {
        val report = HidKeyMapper.map('A')
        assertNotNull(report)
        assertEquals(0x04.toByte(), report!!.keycode)
        assertEquals(0x02.toByte(), report.modifier)
    }

    @Test
    fun `digits 1-9 map correctly`() {
        for (i in 1..9) {
            val report = HidKeyMapper.map('0' + i)
            assertNotNull("Digit $i should be mapped", report)
            assertEquals((0x1D + i).toByte(), report!!.keycode)
        }
    }

    @Test
    fun `digit 0 maps to keycode 0x27`() {
        val report = HidKeyMapper.map('0')
        assertNotNull(report)
        assertEquals(0x27.toByte(), report!!.keycode)
    }

    @Test
    fun `space maps to keycode 0x2C`() {
        val report = HidKeyMapper.map(' ')
        assertNotNull(report)
        assertEquals(HidKeyMapper.KEY_SPACE, report!!.keycode)
    }

    @Test
    fun `enter maps to keycode 0x28`() {
        val report = HidKeyMapper.map('\n')
        assertNotNull(report)
        assertEquals(HidKeyMapper.KEY_ENTER, report!!.keycode)
    }

    @Test
    fun `backspace report generates correct keycode`() {
        val report = HidKeyMapper.backspaceReport()
        assertEquals(HidKeyMapper.KEY_BACKSPACE, report.keycode)
    }

    @Test
    fun `toBytes produces 8-byte report`() {
        val report = HidKeyMapper.HidReport(0x00, 0x04)
        val bytes = HidKeyMapper.toBytes(report)
        assertEquals(8, bytes.size)
        assertEquals(0x00.toByte(), bytes[0]) // modifier
        assertEquals(0x00.toByte(), bytes[1]) // reserved
        assertEquals(0x04.toByte(), bytes[2]) // key1
    }

    @Test
    fun `KEY_UP_REPORT is all zeros`() {
        val report = HidKeyMapper.KEY_UP_REPORT
        assertEquals(8, report.size)
        assertTrue(report.all { it == 0.toByte() })
    }

    @Test
    fun `shifted symbols have shift modifier`() {
        val symbols = "!@#\$%^&*()_+{}|:\"~<>?"
        for (c in symbols) {
            val report = HidKeyMapper.map(c)
            assertNotNull("Symbol '$c' should be mapped", report)
            assertEquals(
                "Symbol '$c' should have shift modifier",
                0x02.toByte(),
                report!!.modifier
            )
        }
    }

    @Test
    fun `unmapped character returns null`() {
        // Non-ASCII characters should return null
        val report = HidKeyMapper.map('\u00E9') // é
        assertNull(report)
    }

    // --- buildReports (explicit down/up pair stream) ---

    private fun isKeyUp(bytes: ByteArray) = bytes.all { it == 0.toByte() }

    @Test
    fun `buildReports emits a down and up pair per character`() {
        val reports = HidKeyMapper.buildReports("ab")
        // a-down, release, b-down, release
        assertEquals(4, reports.size)
        assertEquals(0x04.toByte(), reports[0][2])
        assertTrue(isKeyUp(reports[1]))
        assertEquals(0x05.toByte(), reports[2][2])
        assertTrue(isKeyUp(reports[3]))
    }

    @Test
    fun `buildReports releases between repeated keys`() {
        val reports = HidKeyMapper.buildReports("aa")
        assertEquals(4, reports.size)
        assertTrue(isKeyUp(reports[1]))
        assertEquals(0x04.toByte(), reports[2][2])
        assertTrue(isKeyUp(reports[3]))
    }

    @Test
    fun `buildReports carries shift only on the shifted character`() {
        val reports = HidKeyMapper.buildReports("aB")
        // a-down, release, shift+b-down, release
        assertEquals(4, reports.size)
        assertEquals(0x00.toByte(), reports[0][0])
        assertTrue(isKeyUp(reports[1]))
        assertEquals(0x02.toByte(), reports[2][0])
        assertEquals(0x05.toByte(), reports[2][2])
        assertTrue(isKeyUp(reports[3]))
    }

    @Test
    fun `buildReports skips unmapped characters entirely`() {
        assertTrue(HidKeyMapper.buildReports("é").isEmpty())
        assertTrue(HidKeyMapper.buildReports("").isEmpty())
    }

    // --- Newline modes (target app: Claude Code / Codex / plain text) ---

    @Test
    fun `default newline mode types a real Enter`() {
        val reports = HidKeyMapper.buildReports("a\nb")
        assertEquals(6, reports.size)
        assertEquals(HidKeyMapper.KEY_ENTER, reports[2][2])
        assertEquals(0x00.toByte(), reports[2][0])
    }

    @Test
    fun `ctrl-j newline mode types Ctrl+J instead of Enter`() {
        val reports = HidKeyMapper.buildReports(
            "a\nb", HidKeyMapper.NewlineMode.CTRL_J
        )
        // a-down, up, ctrl+j-down, up, b-down, up
        assertEquals(6, reports.size)
        assertEquals(0x01.toByte(), reports[2][0]) // left ctrl
        assertEquals(HidKeyMapper.KEY_J, reports[2][2])
        assertTrue(isKeyUp(reports[3]))
    }

    @Test
    fun `backslash-enter newline mode types a backslash then Enter`() {
        val reports = HidKeyMapper.buildReports(
            "a\nb", HidKeyMapper.NewlineMode.BACKSLASH_ENTER
        )
        // a, backslash, enter, b — each a down/up pair
        assertEquals(8, reports.size)
        assertEquals(HidKeyMapper.KEY_BACKSLASH, reports[2][2])
        assertEquals(0x00.toByte(), reports[2][0])
        assertTrue(isKeyUp(reports[3]))
        assertEquals(HidKeyMapper.KEY_ENTER, reports[4][2])
        assertTrue(isKeyUp(reports[5]))
    }

    @Test
    fun `soft newlines keep the down-up pair stream`() {
        for (mode in HidKeyMapper.NewlineMode.values()) {
            val reports = HidKeyMapper.buildReports("hi\nthere\n", mode)
            assertTrue("mode $mode should end released", isKeyUp(reports.last()))
            for ((i, r) in reports.withIndex()) {
                if (i % 2 == 0) assertTrue("mode $mode index $i", r[2] != 0.toByte())
                else assertTrue("mode $mode index $i", isKeyUp(r))
            }
        }
    }

    @Test
    fun `newline mode wire values parse, unknown falls back to Enter`() {
        assertEquals(
            HidKeyMapper.NewlineMode.CTRL_J,
            HidKeyMapper.NewlineMode.fromWire("ctrl_j")
        )
        assertEquals(
            HidKeyMapper.NewlineMode.BACKSLASH_ENTER,
            HidKeyMapper.NewlineMode.fromWire("BACKSLASH_ENTER")
        )
        assertEquals(
            HidKeyMapper.NewlineMode.ENTER,
            HidKeyMapper.NewlineMode.fromWire("enter")
        )
        // Older/unknown clients must still get a plain Enter, never nothing.
        assertEquals(HidKeyMapper.NewlineMode.ENTER, HidKeyMapper.NewlineMode.fromWire(null))
        assertEquals(HidKeyMapper.NewlineMode.ENTER, HidKeyMapper.NewlineMode.fromWire(""))
        assertEquals(HidKeyMapper.NewlineMode.ENTER, HidKeyMapper.NewlineMode.fromWire("shift_enter"))
    }

    @Test
    fun `buildReports alternates down and up and ends with a release`() {
        val reports = HidKeyMapper.buildReports("Hello, world!")
        assertTrue(isKeyUp(reports.last()))
        for ((i, r) in reports.withIndex()) {
            if (i % 2 == 0) {
                // key-down: exactly one keycode in slot 1
                assertTrue(r[2] != 0.toByte())
                for (j in 3..7) assertEquals(0.toByte(), r[j])
            } else {
                assertTrue(isKeyUp(r))
            }
        }
    }
}
