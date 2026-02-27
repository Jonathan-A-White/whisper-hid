package com.whisperbt.keyboard

/**
 * Maps ASCII characters to USB HID keyboard report data.
 *
 * Each keystroke is an 8-byte report:
 *   [modifier, 0x00, key1, key2, key3, key4, key5, key6]
 *
 * Modifier bits:
 *   0x02 = Left Shift
 */
object HidKeyMapper {

    private const val MOD_NONE: Byte = 0x00
    private const val MOD_SHIFT: Byte = 0x02

    /** A key-down report for a single character. */
    data class HidReport(val modifier: Byte, val keycode: Byte)

    /** An all-zeros report that releases all keys. */
    val KEY_UP_REPORT = ByteArray(8)

    /** Build an 8-byte key-down report from a [HidReport]. */
    fun toBytes(report: HidReport): ByteArray {
        return byteArrayOf(report.modifier, 0, report.keycode, 0, 0, 0, 0, 0)
    }

    /** Map a character to its HID report, or null if unmapped. */
    fun map(char: Char): HidReport? = CHAR_MAP[char]

    // HID keycodes for special keys
    const val KEY_ENTER: Byte = 0x28
    const val KEY_TAB: Byte = 0x2B
    const val KEY_BACKSPACE: Byte = 0x2A
    const val KEY_SPACE: Byte = 0x2C

    fun enterReport() = HidReport(MOD_NONE, KEY_ENTER)
    fun tabReport() = HidReport(MOD_NONE, KEY_TAB)
    fun backspaceReport() = HidReport(MOD_NONE, KEY_BACKSPACE)
    fun spaceReport() = HidReport(MOD_NONE, KEY_SPACE)

    private val CHAR_MAP: Map<Char, HidReport> = buildMap {
        // a-z: keycodes 0x04-0x1D
        for (i in 0..25) {
            put('a' + i, HidReport(MOD_NONE, (0x04 + i).toByte()))
        }
        // A-Z: same keycodes + shift
        for (i in 0..25) {
            put('A' + i, HidReport(MOD_SHIFT, (0x04 + i).toByte()))
        }
        // 1-9: keycodes 0x1E-0x26
        for (i in 1..9) {
            put('0' + i, HidReport(MOD_NONE, (0x1D + i).toByte()))
        }
        // 0: keycode 0x27
        put('0', HidReport(MOD_NONE, 0x27))

        // Space, enter, tab, backspace
        put(' ', HidReport(MOD_NONE, KEY_SPACE))
        put('\n', HidReport(MOD_NONE, KEY_ENTER))
        put('\t', HidReport(MOD_NONE, KEY_TAB))

        // Punctuation (unshifted)
        put('-', HidReport(MOD_NONE, 0x2D))    // - and _
        put('=', HidReport(MOD_NONE, 0x2E))    // = and +
        put('[', HidReport(MOD_NONE, 0x2F))    // [ and {
        put(']', HidReport(MOD_NONE, 0x30))    // ] and }
        put('\\', HidReport(MOD_NONE, 0x31))   // \ and |
        put(';', HidReport(MOD_NONE, 0x33))    // ; and :
        put('\'', HidReport(MOD_NONE, 0x34))   // ' and "
        put('`', HidReport(MOD_NONE, 0x35))    // ` and ~
        put(',', HidReport(MOD_NONE, 0x36))    // , and <
        put('.', HidReport(MOD_NONE, 0x37))    // . and >
        put('/', HidReport(MOD_NONE, 0x38))    // / and ?

        // Shifted symbols
        put('!', HidReport(MOD_SHIFT, 0x1E))   // Shift + 1
        put('@', HidReport(MOD_SHIFT, 0x1F))   // Shift + 2
        put('#', HidReport(MOD_SHIFT, 0x20))   // Shift + 3
        put('$', HidReport(MOD_SHIFT, 0x21))   // Shift + 4
        put('%', HidReport(MOD_SHIFT, 0x22))   // Shift + 5
        put('^', HidReport(MOD_SHIFT, 0x23))   // Shift + 6
        put('&', HidReport(MOD_SHIFT, 0x24))   // Shift + 7
        put('*', HidReport(MOD_SHIFT, 0x25))   // Shift + 8
        put('(', HidReport(MOD_SHIFT, 0x26))   // Shift + 9
        put(')', HidReport(MOD_SHIFT, 0x27))   // Shift + 0
        put('_', HidReport(MOD_SHIFT, 0x2D))   // Shift + -
        put('+', HidReport(MOD_SHIFT, 0x2E))   // Shift + =
        put('{', HidReport(MOD_SHIFT, 0x2F))   // Shift + [
        put('}', HidReport(MOD_SHIFT, 0x30))   // Shift + ]
        put('|', HidReport(MOD_SHIFT, 0x31))   // Shift + backslash
        put(':', HidReport(MOD_SHIFT, 0x33))   // Shift + ;
        put('"', HidReport(MOD_SHIFT, 0x34))   // Shift + '
        put('~', HidReport(MOD_SHIFT, 0x35))   // Shift + `
        put('<', HidReport(MOD_SHIFT, 0x36))   // Shift + ,
        put('>', HidReport(MOD_SHIFT, 0x37))   // Shift + .
        put('?', HidReport(MOD_SHIFT, 0x38))   // Shift + /
    }
}
