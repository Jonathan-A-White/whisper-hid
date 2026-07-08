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

    // --- buildReports (merged key-up stream) ---

    private fun isKeyUp(bytes: ByteArray) = bytes.all { it == 0.toByte() }

    @Test
    fun `buildReports merges key-up into next key-down for distinct keys`() {
        val reports = HidKeyMapper.buildReports("ab")
        // a-down, b-down (implicitly releases a), final release
        assertEquals(3, reports.size)
        assertEquals(0x04.toByte(), reports[0][2])
        assertEquals(0x05.toByte(), reports[1][2])
        assertTrue(isKeyUp(reports[2]))
    }

    @Test
    fun `buildReports inserts release between repeated keys`() {
        val reports = HidKeyMapper.buildReports("aa")
        // a-down, release, a-down, final release
        assertEquals(4, reports.size)
        assertTrue(isKeyUp(reports[1]))
        assertEquals(0x04.toByte(), reports[2][2])
    }

    @Test
    fun `buildReports inserts release on modifier change`() {
        val reports = HidKeyMapper.buildReports("aB")
        // a-down, release, shift+b-down, final release
        assertEquals(4, reports.size)
        assertTrue(isKeyUp(reports[1]))
        assertEquals(0x02.toByte(), reports[2][0])
        assertEquals(0x05.toByte(), reports[2][2])
    }

    @Test
    fun `buildReports keeps shift held across consecutive uppercase`() {
        val reports = HidKeyMapper.buildReports("AB")
        // shift+a-down, shift+b-down, final release
        assertEquals(3, reports.size)
        assertEquals(0x02.toByte(), reports[0][0])
        assertEquals(0x02.toByte(), reports[1][0])
        assertTrue(isKeyUp(reports[2]))
    }

    @Test
    fun `buildReports skips unmapped characters entirely`() {
        assertTrue(HidKeyMapper.buildReports("é").isEmpty())
        assertTrue(HidKeyMapper.buildReports("").isEmpty())
    }

    @Test
    fun `buildReports always ends with a full release`() {
        val reports = HidKeyMapper.buildReports("Hello, world!")
        assertTrue(isKeyUp(reports.last()))
        // Every non-release report carries exactly one keycode
        for (r in reports) {
            if (!isKeyUp(r)) {
                assertTrue(r[2] != 0.toByte())
                for (i in 3..7) assertEquals(0.toByte(), r[i])
            }
        }
    }

    @Test
    fun `buildReports uses roughly one report per character for prose`() {
        val text = "the quick brown fox jumps over the lazy dog"
        val reports = HidKeyMapper.buildReports(text)
        // Old scheme: 2 reports per char = 88. Merged stream should be far
        // closer to 1 per char (releases only for doubled letters + final).
        assertTrue(
            "expected < 1.2 reports/char, got ${reports.size} for ${text.length} chars",
            reports.size < text.length * 1.2
        )
    }
}
