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
     * The ASCII a non-typeable character is typed as, or null if there is no
     * sensible stand-in.
     *
     * A US-keyboard HID report can only name keys that exist on a US
     * keyboard, so anything outside that set used to be dropped on the floor
     * — silently, mid-word. That is never the right answer: an em dash
     * vanishing turns "a program — most of it" into "a program  most of it",
     * and the text arrives subtly wrong with nothing to show why. These are
     * not exotic inputs either; the cleanup LLM emits typographic dashes,
     * curly quotes and ellipses as a matter of course, and pasted clipboard
     * text is full of them.
     *
     * Expansion happens BEFORE mapping, so [map] still answers only for
     * characters a single keystroke can produce.
     */
    fun asciiFallback(char: Char): String? = ASCII_FALLBACKS[char]

    /**
     * Build the HID report stream that types [text].
     *
     * Two rules, both load-bearing, both learned from corrupted field sends:
     *
     * **1. An explicit key-down + release pair per character** (2
     * reports/char). A merged stream (key-up folded into the next key-down,
     * ~1 report/char) was tried and REVERTED: field testing against a real
     * host produced bursts of dropped characters and dropped Shifts on every
     * send, regardless of keystroke delay (0-20ms tried) — while this pair
     * stream at the same report rate has always been clean. Every report the
     * stack or host drops silently corrupts a merged stream, and the pair
     * stream degrades more gracefully: a lost release is healed by the next
     * key-down (a report without the old keycode implicitly releases it), so
     * one lost report costs at most one character. Don't re-merge key-ups to
     * shave latency; typing speed comes from lowering keystrokeDelayMs.
     *
     * **2. A modifier change never shares a report with a keycode change.**
     * Shift going down in the same report as the key it shifts is a coin
     * flip: the host decides in which order to turn one report into input
     * events, and a host that presses the key before applying the new
     * modifier byte types the *unshifted* character. That is the
     * `"To Read—Or Not to Read the Code?"` → `'to readOr notead THE Code?"`
     * class of corruption seen in the field — every capital in a burst
     * arriving lowercase, `<` arriving as `,` (Shift+comma losing its
     * Shift), `## Role` as `## role`. The mirror image is a lost release
     * followed by an unshifted key-down, where the host applies the key
     * before clearing Shift and types capitals that were never asked for
     * (`the` → `THE`, `github.com` → `GitHub.com`).
     *
     * So a character whose modifier differs from the one currently held gets
     * a modifier-only report first (modifier byte set, no keycode), exactly
     * as a human pressing Shift before the letter. The release between
     * characters keeps the modifier held, so a run of capitals or of `**`
     * pays for Shift once; the stream always ends with everything released.
     * Cost on ordinary prose is under 5% more reports — case changes only —
     * and unshifted runs are byte-identical to what shipped before. Don't
     * fold the modifier back into the key-down report to save them.
     *
     * [newlineMode] decides what a `\n` types: a real Enter (submits in a CLI
     * composer) or the target app's newline-without-submit key. A soft
     * newline can expand to more than one keystroke, but every one of them
     * still follows both rules above.
     */
    fun buildReports(
        text: String,
        newlineMode: NewlineMode = NewlineMode.ENTER
    ): List<ByteArray> {
        val reports = ArrayList<ByteArray>(text.length * 2 + 2)
        // The modifier byte the host currently believes is held. Only ever
        // changed by a report that carries no keycode (rule 2).
        var held: Byte = MOD_NONE
        for (char in text) {
            val keys =
                if (char == '\n') newlineKeys(newlineMode)
                else keysFor(char)
            for (key in keys) {
                if (key.modifier != held) {
                    held = key.modifier
                    reports.add(modifierOnly(held))
                }
                reports.add(toBytes(key))
                // Release the key but keep the modifier down: the next
                // character re-uses it if it needs the same one.
                reports.add(modifierOnly(held))
            }
        }
        // Never hand the link back with Shift or Ctrl still held.
        if (held != MOD_NONE) reports.add(KEY_UP_REPORT)
        return reports
    }

    /**
     * The key-down reports one character expands to: itself if it is
     * typeable, otherwise its ASCII stand-in ("--" for an em dash), or
     * nothing at all when neither exists.
     */
    private fun keysFor(char: Char): List<HidReport> {
        map(char)?.let { return listOf(it) }
        val fallback = asciiFallback(char) ?: return emptyList()
        return fallback.mapNotNull { map(it) }
    }

    /**
     * A report that holds [modifier] with no key pressed. Doubles as the
     * release report between characters, and is [KEY_UP_REPORT] itself when
     * nothing is held.
     */
    private fun modifierOnly(modifier: Byte): ByteArray =
        if (modifier == MOD_NONE) KEY_UP_REPORT
        else byteArrayOf(modifier, 0, 0, 0, 0, 0, 0, 0)

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

    /**
     * ASCII stand-ins for characters a US keyboard has no key for (see
     * [asciiFallback]). Every entry must expand to characters that are
     * themselves in CHAR_MAP — [keysFor] drops anything that isn't, which
     * would put us back where we started.
     *
     * Scope is deliberate: typography the cleanup LLM and pasted text
     * actually produce (dashes, curly quotes, ellipses, exotic spaces) and
     * accented Latin letters, which fold to their base letter. Losing the
     * accent is a small wrong; losing the letter is a corrupted word.
     * Anything genuinely un-transliterable (CJK, emoji) still types nothing
     * — there is no honest ASCII for it.
     */
    private val ASCII_FALLBACKS: Map<Char, String> = buildMap {
        // Dashes and hyphens
        put('\u2010', "-")       // ‐ hyphen
        put('\u2011', "-")       // ‑ non-breaking hyphen
        put('\u2012', "-")       // ‒ figure dash
        put('\u2013', "-")       // – en dash
        put('\u2014', "--")      // — em dash
        put('\u2015', "--")      // ― horizontal bar
        put('\u2212', "-")       // − minus sign
        put('\u00AD', "")        // soft hyphen (invisible; types nothing)

        // Quotes and primes
        put('\u2018', "'")       // ‘ left single
        put('\u2019', "'")       // ’ right single / apostrophe
        put('\u201A', "'")       // ‚ single low
        put('\u201B', "'")       // ‛ single high-reversed
        put('\u2032', "'")       // ′ prime
        put('\u201C', "\"")      // “ left double
        put('\u201D', "\"")      // ” right double
        put('\u201E', "\"")      // „ double low
        put('\u201F', "\"")      // ‟ double high-reversed
        put('\u2033', "\"")      // ″ double prime
        put('\u00AB', "\"")      // « guillemet
        put('\u00BB', "\"")      // » guillemet

        // Spaces that aren't the space key, and zero-width junk
        put('\u00A0', " ")       // no-break space
        put('\u2002', " ")       // en space
        put('\u2003', " ")       // em space
        put('\u2007', " ")       // figure space
        put('\u2009', " ")       // thin space
        put('\u200A', " ")       // hair space
        put('\u202F', " ")       // narrow no-break space
        put('\u3000', " ")       // ideographic space
        put('\u200B', "")        // zero-width space
        put('\uFEFF', "")        // BOM / zero-width no-break space

        // Punctuation and symbols
        put('\u2026', "...")     // … ellipsis
        put('\u2022', "-")       // • bullet
        put('\u2023', "-")       // ‣ triangular bullet
        put('\u00B7', "-")       // · middle dot
        put('\u2043', "-")       // ⁃ hyphen bullet
        put('\u2192', "->")      // → right arrow
        put('\u2190', "<-")      // ← left arrow
        put('\u21D2', "=>")      // ⇒ rightwards double arrow
        put('\u2264', "<=")      // ≤
        put('\u2265', ">=")      // ≥
        put('\u2260', "!=")      // ≠
        put('\u00D7', "x")       // × multiplication
        put('\u00F7', "/")       // ÷ division
        put('\u2044', "/")       // ⁄ fraction slash
        put('\u00A9', "(c)")     // ©
        put('\u00AE', "(R)")     // ®
        put('\u2122', "(TM)")    // ™
        put('\u00BC', "1/4")     // ¼
        put('\u00BD', "1/2")     // ½
        put('\u00BE', "3/4")     // ¾

        // Accented Latin letters fold to their base letter. Losing the
        // accent is a small wrong; losing the letter corrupts the word.
        val folds = listOf(
            "ÀÁÂÃÄÅ" to "A", "Ç" to "C", "ÈÉÊË" to "E",
            "ÌÍÎÏ" to "I", "Ñ" to "N", "ÒÓÔÕÖØ" to "O",
            "ÙÚÛÜ" to "U", "ÝŸ" to "Y",
            "àáâãäå" to "a", "ç" to "c", "èéêë" to "e",
            "ìíîï" to "i", "ñ" to "n", "òóôõöø" to "o",
            "ùúûü" to "u", "ýÿ" to "y",
        )
        for ((accented, base) in folds) for (c in accented) put(c, base)
        put('\u00C6', "AE")      // Æ
        put('\u00E6', "ae")      // æ
        put('\u0152', "OE")      // Œ
        put('\u0153', "oe")      // œ
        put('\u00DF', "ss")      // ß
    }
}
