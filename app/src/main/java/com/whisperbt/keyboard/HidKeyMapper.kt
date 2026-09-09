package com.whisperbt.keyboard

/**
 * Maps ASCII characters to USB HID keyboard report data.
 *
 * Each keystroke is an 8-byte report:
 *   [modifier, 0x00, key1, key2, key3, key4, key5, key6]
 *
 * Modifier bits:
 *   0x01 = Left Ctrl
 *   0x02 = Left Shift
 */
object HidKeyMapper {

    private const val MOD_NONE: Byte = 0x00
    private const val MOD_CTRL: Byte = 0x01
    private const val MOD_SHIFT: Byte = 0x02

    /** A key-down report for a single character. */
    data class HidReport(val modifier: Byte, val keycode: Byte)

    /**
     * How a `\n` in the text is delivered to the host.
     *
     * A plain Enter submits in a CLI composer, so a multi-line send arrives
     * as several separate prompts. Each target app has its own
     * newline-without-submit key, and the PWA picks one per request
     * ("newline_mode" in the /type body):
     *
     *  - [ENTER]: a real Enter. Correct for plain text fields, and for the
     *    deliberate final Enter that submits ("Newline after end of
     *    recording").
     *  - [CTRL_J]: Codex CLI's newline binding. Shift+Enter is *also* bound
     *    there but most terminals can't distinguish it from Enter, so they
     *    submit instead — Ctrl+J is the terminal-independent one.
     *  - [BACKSLASH_ENTER]: Claude Code's escape — a literal "\" then Enter.
     *    Typed as text rather than a chord; Codex would show the backslash
     *    and submit, hence the split.
     */
    enum class NewlineMode {
        ENTER,
        CTRL_J,
        BACKSLASH_ENTER;

        companion object {
            /** Parse the wire value from a /type body; unknown = [ENTER]. */
            fun fromWire(name: String?): NewlineMode = when (name?.lowercase()) {
                "ctrl_j" -> CTRL_J
                "backslash_enter" -> BACKSLASH_ENTER
                else -> ENTER
            }
        }
    }

    /** An all-zeros report that releases all keys. */
    val KEY_UP_REPORT = ByteArray(8)

    /** Build an 8-byte key-down report from a [HidReport]. */
    fun toBytes(report: HidReport): ByteArray {
        return byteArrayOf(report.modifier, 0, report.keycode, 0, 0, 0, 0, 0)
    }

    /** Map a character to its HID report, or null if unmapped. */
    fun map(char: Char): HidReport? = CHAR_MAP[char]

    /**
     * Build the HID report stream that types [text]: an explicit key-down +
     * all-up pair per character (2 reports/char).
     *
     * A merged stream (key-up folded into the next key-down, ~1 report/char)
     * was tried and REVERTED: field testing against a real host produced
     * bursts of dropped characters and dropped Shifts on every send,
     * regardless of keystroke delay (0-20ms tried) — while this pair stream
     * at the same report rate has always been clean. Every report the stack
     * or host drops silently corrupts a merged stream, and the pair stream
     * degrades more gracefully: a lost release is healed by the next
     * key-down (a report without the old keycode implicitly releases it), so
     * one lost report costs at most one character. Don't re-merge key-ups to
     * shave latency; typing speed comes from lowering keystrokeDelayMs.
     *
     * [newlineMode] decides what a `\n` types: a real Enter (submits in a CLI
     * composer) or the target app's newline-without-submit key. A soft
     * newline can expand to more than one keystroke, but every one of them
     * still follows the key-down + all-up pair rule.
     */
    fun buildReports(
        text: String,
        newlineMode: NewlineMode = NewlineMode.ENTER
    ): List<ByteArray> {
        val reports = ArrayList<ByteArray>(text.length * 2)
        for (char in text) {
            val keys =
                if (char == '\n') newlineKeys(newlineMode)
                else listOfNotNull(map(char))
            for (key in keys) {
                reports.add(toBytes(key))
                reports.add(KEY_UP_REPORT)
            }
        }
        return reports
    }

    /** The key-down reports one newline expands to under [mode]. */
    private fun newlineKeys(mode: NewlineMode): List<HidReport> = when (mode) {
        NewlineMode.ENTER -> listOf(enterReport())
        NewlineMode.CTRL_J -> listOf(ctrlJReport())
        NewlineMode.BACKSLASH_ENTER -> listOf(backslashReport(), enterReport())
    }

    // HID keycodes for special keys
    const val KEY_ENTER: Byte = 0x28
    const val KEY_TAB: Byte = 0x2B
    const val KEY_BACKSPACE: Byte = 0x2A
    const val KEY_SPACE: Byte = 0x2C
    const val KEY_J: Byte = 0x0D
    const val KEY_BACKSLASH: Byte = 0x31

    /** Ctrl+J — Codex CLI's "newline without submitting". */
    fun ctrlJReport() = HidReport(MOD_CTRL, KEY_J)

    fun backslashReport() = HidReport(MOD_NONE, KEY_BACKSLASH)

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
