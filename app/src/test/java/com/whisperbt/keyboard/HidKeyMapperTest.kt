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
}
