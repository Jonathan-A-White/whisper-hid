package com.whisperbt.keyboard

/**
 * Maps ASCII/Unicode characters to USB HID keyboard keycodes.
 *
 * HID report format (8 bytes):
 *   [0] modifier byte  (bit 1 = Left Shift)
 *   [1] reserved (0x00)
 *   [2] keycode 1
 *   [3] keycode 2  (additional simultaneous keys — unused here)
 *   [4] keycode 3
 *   [5] keycode 4
 *   [6] keycode 5
 *   [7] keycode 6
 *
 * Reference: USB HID Usage Tables 1.12 — Section 10, Keyboard/Keypad page (0x07)
 */
object HidKeyMapper {

    // Modifier bits
    const val MOD_NONE: Byte = 0x00
    const val MOD_LEFT_SHIFT: Byte = 0x02

    // Special HID keycodes
    const val KEY_NONE: Byte = 0x00
    const val KEY_BACKSPACE: Byte = 0x2A
    const val KEY_TAB: Byte = 0x2B
    const val KEY_ENTER: Byte = 0x28
    const val KEY_SPACE: Byte = 0x2C
    const val KEY_CAPS_LOCK: Byte = 0x39
    const val KEY_ESCAPE: Byte = 0x29
    const val KEY_DELETE: Byte = 0x4C

    /** Represents one HID report: modifier + keycode pair. */
    data class HidKey(val modifier: Byte, val keycode: Byte)

    /** Null result — character has no mapping. */
    private val NO_KEY = HidKey(MOD_NONE, KEY_NONE)

    /**
     * Convert a single character to its HID key representation.
     * Returns null if the character cannot be mapped.
     */
    fun charToHidKey(c: Char): HidKey? {
        return when (c) {
            // Lowercase a-z → keycodes 0x04-0x1D, no modifier
            in 'a'..'z' -> HidKey(MOD_NONE, (0x04 + (c - 'a')).toByte())

            // Uppercase A-Z → same keycodes + Left Shift
            in 'A'..'Z' -> HidKey(MOD_LEFT_SHIFT, (0x04 + (c - 'A')).toByte())

            // Digits 1-9 → keycodes 0x1E-0x26
            in '1'..'9' -> HidKey(MOD_NONE, (0x1E + (c - '1')).toByte())

            // Digit 0 → keycode 0x27
            '0' -> HidKey(MOD_NONE, 0x27)

            // Whitespace
            ' '  -> HidKey(MOD_NONE, KEY_SPACE)
            '\n' -> HidKey(MOD_NONE, KEY_ENTER)
            '\t' -> HidKey(MOD_NONE, KEY_TAB)

            // Punctuation — unshifted
            '-'  -> HidKey(MOD_NONE, 0x2D)
            '='  -> HidKey(MOD_NONE, 0x2E)
            '['  -> HidKey(MOD_NONE, 0x2F)
            ']'  -> HidKey(MOD_NONE, 0x30)
            '\\' -> HidKey(MOD_NONE, 0x31)
            ';'  -> HidKey(MOD_NONE, 0x33)
            '\'' -> HidKey(MOD_NONE, 0x34)
            '`'  -> HidKey(MOD_NONE, 0x35)
            ','  -> HidKey(MOD_NONE, 0x36)
            '.'  -> HidKey(MOD_NONE, 0x37)
            '/'  -> HidKey(MOD_NONE, 0x38)

            // Punctuation — shifted symbols
            '!'  -> HidKey(MOD_LEFT_SHIFT, 0x1E)   // Shift+1
            '@'  -> HidKey(MOD_LEFT_SHIFT, 0x1F)   // Shift+2
            '#'  -> HidKey(MOD_LEFT_SHIFT, 0x20)   // Shift+3
            '$'  -> HidKey(MOD_LEFT_SHIFT, 0x21)   // Shift+4
            '%'  -> HidKey(MOD_LEFT_SHIFT, 0x22)   // Shift+5
            '^'  -> HidKey(MOD_LEFT_SHIFT, 0x23)   // Shift+6
            '&'  -> HidKey(MOD_LEFT_SHIFT, 0x24)   // Shift+7
            '*'  -> HidKey(MOD_LEFT_SHIFT, 0x25)   // Shift+8
            '('  -> HidKey(MOD_LEFT_SHIFT, 0x26)   // Shift+9
            ')'  -> HidKey(MOD_LEFT_SHIFT, 0x27)   // Shift+0
            '_'  -> HidKey(MOD_LEFT_SHIFT, 0x2D)   // Shift+-
            '+'  -> HidKey(MOD_LEFT_SHIFT, 0x2E)   // Shift+=
            '{'  -> HidKey(MOD_LEFT_SHIFT, 0x2F)   // Shift+[
            '}'  -> HidKey(MOD_LEFT_SHIFT, 0x30)   // Shift+]
            '|'  -> HidKey(MOD_LEFT_SHIFT, 0x31)   // Shift+\
            ':'  -> HidKey(MOD_LEFT_SHIFT, 0x33)   // Shift+;
            '"'  -> HidKey(MOD_LEFT_SHIFT, 0x34)   // Shift+'
            '~'  -> HidKey(MOD_LEFT_SHIFT, 0x35)   // Shift+`
            '<'  -> HidKey(MOD_LEFT_SHIFT, 0x36)   // Shift+,
            '>'  -> HidKey(MOD_LEFT_SHIFT, 0x37)   // Shift+.
            '?'  -> HidKey(MOD_LEFT_SHIFT, 0x38)   // Shift+/

            else -> null
        }
    }

    /**
     * Build a full 8-byte HID keyboard report for a given HidKey.
     * Key-down report: modifier set + keycode in byte[2].
     */
    fun buildKeyDownReport(key: HidKey): ByteArray {
        return byteArrayOf(key.modifier, 0x00, key.keycode, 0x00, 0x00, 0x00, 0x00, 0x00)
    }

    /**
     * All-zeros key-up report (releases all keys).
     */
    fun buildKeyUpReport(): ByteArray {
        return ByteArray(8)
    }

    /**
     * Convert a text string to a list of key events (down/up pairs).
     * Characters that have no mapping are silently skipped.
     */
    fun textToKeyEvents(text: String): List<Pair<ByteArray, ByteArray>> {
        return text.mapNotNull { c ->
            charToHidKey(c)?.let { key ->
                Pair(buildKeyDownReport(key), buildKeyUpReport())
            }
        }
    }

    /**
     * Standard USB HID keyboard report descriptor.
     *
     * This is the boot-protocol compatible keyboard descriptor that describes:
     *  - 1 input report: 8 bytes (modifier + reserved + 6 key array)
     *  - 1 output report: 1 byte (LEDs)
     *
     * The laptop host uses this to understand the device capabilities.
     */
    val HID_KEYBOARD_DESCRIPTOR: ByteArray = byteArrayOf(
        0x05.toByte(), 0x01.toByte(),  // Usage Page (Generic Desktop)
        0x09.toByte(), 0x06.toByte(),  // Usage (Keyboard)
        0xA1.toByte(), 0x01.toByte(),  // Collection (Application)

        // Modifier keys (8 bits: Left Ctrl, Left Shift, Left Alt, Left GUI, Right Ctrl, Right Shift, Right Alt, Right GUI)
        0x05.toByte(), 0x07.toByte(),  //   Usage Page (Keyboard/Keypad)
        0x19.toByte(), 0xE0.toByte(),  //   Usage Minimum (Keyboard Left Control = 0xE0)
        0x29.toByte(), 0xE7.toByte(),  //   Usage Maximum (Keyboard Right GUI = 0xE7)
        0x15.toByte(), 0x00.toByte(),  //   Logical Minimum (0)
        0x25.toByte(), 0x01.toByte(),  //   Logical Maximum (1)
        0x75.toByte(), 0x01.toByte(),  //   Report Size (1)
        0x95.toByte(), 0x08.toByte(),  //   Report Count (8)
        0x81.toByte(), 0x02.toByte(),  //   Input (Data, Variable, Absolute) — modifier byte

        // Reserved byte
        0x95.toByte(), 0x01.toByte(),  //   Report Count (1)
        0x75.toByte(), 0x08.toByte(),  //   Report Size (8)
        0x81.toByte(), 0x01.toByte(),  //   Input (Constant) — reserved

        // LED output report (Num Lock, Caps Lock, Scroll Lock, Compose, Kana)
        0x95.toByte(), 0x05.toByte(),  //   Report Count (5)
        0x75.toByte(), 0x01.toByte(),  //   Report Size (1)
        0x05.toByte(), 0x08.toByte(),  //   Usage Page (LEDs)
        0x19.toByte(), 0x01.toByte(),  //   Usage Minimum (Num Lock)
        0x29.toByte(), 0x05.toByte(),  //   Usage Maximum (Kana)
        0x91.toByte(), 0x02.toByte(),  //   Output (Data, Variable, Absolute)

        // LED padding (3 bits to fill out a byte)
        0x95.toByte(), 0x01.toByte(),  //   Report Count (1)
        0x75.toByte(), 0x03.toByte(),  //   Report Size (3)
        0x91.toByte(), 0x01.toByte(),  //   Output (Constant)

        // Key array (6 simultaneous keys)
        0x95.toByte(), 0x06.toByte(),  //   Report Count (6)
        0x75.toByte(), 0x08.toByte(),  //   Report Size (8)
        0x15.toByte(), 0x00.toByte(),  //   Logical Minimum (0)
        0x25.toByte(), 0xFF.toByte(),  //   Logical Maximum (255)
        0x05.toByte(), 0x07.toByte(),  //   Usage Page (Keyboard/Keypad)
        0x19.toByte(), 0x00.toByte(),  //   Usage Minimum (0)
        0x29.toByte(), 0xFF.toByte(),  //   Usage Maximum (255)
        0x81.toByte(), 0x00.toByte(),  //   Input (Data, Array, Absolute) — key array

        0xC0.toByte()                  // End Collection
    )
}
