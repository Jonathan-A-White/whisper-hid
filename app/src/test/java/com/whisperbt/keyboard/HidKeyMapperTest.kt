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
        // map() answers only for what a single keystroke can produce.
        // Everything else goes through asciiFallback instead of vanishing.
        assertNull(HidKeyMapper.map('é')) // é
        assertNull(HidKeyMapper.map('—')) // em dash
    }

    // --- buildReports (down/release pairs; modifier changes on their own) ---

    private fun isKeyUp(bytes: ByteArray) = bytes.all { it == 0.toByte() }

    /**
     * Replay a report stream the way a host does and return the text it
     * types. Fails if any key-down report also changes the modifier byte —
     * that is precisely the ambiguity buildReports exists to remove, and a
     * host is free to resolve it either way (see the field corruption
     * documented on buildReports).
     */
    private fun typedText(reports: List<ByteArray>): String {
        val sb = StringBuilder()
        var modifier: Byte = 0
        for (r in reports) {
            if (r[2] == 0.toByte()) {
                modifier = r[0]
                continue
            }
            assertEquals(
                "key-down report changed the modifier in the same report",
                modifier,
                r[0]
            )
            sb.append(charFor(modifier, r[2]))
        }
        return sb.toString()
    }

    private fun charFor(modifier: Byte, keycode: Byte): Char {
        for (c in ' '..'~') {
            val r = HidKeyMapper.map(c) ?: continue
            if (r.modifier == modifier && r.keycode == keycode) return c
        }
        if (keycode == HidKeyMapper.KEY_ENTER) return '\n'
        if (keycode == HidKeyMapper.KEY_TAB) return '\t'
        fail("no character for modifier=$modifier keycode=$keycode")
        return ' '
    }

    /**
     * Replay a report stream on a deliberately pessimistic host: one that,
     * when a single report changes the modifier byte *and* presses a key,
     * presses the key first and applies the new modifier afterwards. That is
     * the host behaviour rule 2 exists to work around, and modelling the
     * worst case is what makes [losing any single report costs at most one
     * character] a real guarantee rather than a hope.
     */
    private fun replayLossy(reports: List<ByteArray>): String {
        val sb = StringBuilder()
        var heldMod: Byte = 0
        var heldKey: Byte = 0
        for (r in reports) {
            val mod = r[0]
            val key = r[2]
            if (key != 0.toByte() && key != heldKey) {
                // Pessimistic ordering: the key lands under the modifier the
                // host had *before* this report.
                val effective = if (mod != heldMod) heldMod else mod
                charForOrNull(effective, key)?.let { sb.append(it) }
            }
            heldMod = mod
            heldKey = key
        }
        return sb.toString()
    }

    private fun charForOrNull(modifier: Byte, keycode: Byte): Char? {
        for (c in ' '..'~') {
            val r = HidKeyMapper.map(c) ?: continue
            if (r.modifier == modifier && r.keycode == keycode) return c
        }
        if (modifier == 0.toByte() && keycode == HidKeyMapper.KEY_ENTER) return '\n'
        if (modifier == 0.toByte() && keycode == HidKeyMapper.KEY_TAB) return '\t'
        return null
    }

    /** Length of the longest common subsequence — how much survived, in order. */
    private fun lcsLength(a: String, b: String): Int {
        val dp = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 1..a.length) {
            for (j in 1..b.length) {
                dp[i][j] =
                    if (a[i - 1] == b[j - 1]) dp[i - 1][j - 1] + 1
                    else maxOf(dp[i - 1][j], dp[i][j - 1])
            }
        }
        return dp[a.length][b.length]
    }

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
    fun `unshifted text still costs exactly two reports per character`() {
        val text = "the quick brown fox jumps over 13 lazy dogs."
        assertEquals(text.length * 2, HidKeyMapper.buildReports(text).size)
    }

    @Test
    fun `shift goes down in a report of its own before the key it shifts`() {
        val reports = HidKeyMapper.buildReports("aB")
        // a-down, release, shift-down (no key), shift+b-down, all-up
        assertEquals(5, reports.size)
        assertEquals(0x00.toByte(), reports[0][0])
        assertTrue(isKeyUp(reports[1]))

        assertEquals("shift must arrive alone", 0x02.toByte(), reports[2][0])
        assertEquals("a modifier-only report carries no keycode", 0x00.toByte(), reports[2][2])

        assertEquals(0x02.toByte(), reports[3][0])
        assertEquals(0x05.toByte(), reports[3][2])

        assertTrue("character ends fully released", isKeyUp(reports[4]))
    }

    @Test
    fun `modifier state never carries from one character to the next`() {
        // Holding Shift across a run was tried and reverted: on a link that
        // loses reports, one lost shift-release poisons everything up to the
        // next case change ("(shared data contract)" came back as
        // "(SHARED DATA CONTRACT)"). Every character must stand alone, so
        // every one of them ends on an all-keys-up report.
        for (text in listOf("AB", "ABC", "**", "://", "Ab", "aB", "A1!a")) {
            val reports = HidKeyMapper.buildReports(text)
            assertTrue("$text must end released", isKeyUp(reports.last()))
            // Walk the stream: after every key-down the very next report is
            // all-zeros, so the host's modifier state is 0 between characters.
            for ((i, r) in reports.withIndex()) {
                if (r[2] == 0.toByte()) continue
                assertTrue(
                    "$text: key-down at $i is not followed by a full release",
                    isKeyUp(reports[i + 1])
                )
            }
        }
    }

    @Test
    fun `each shifted character re-asserts its own shift`() {
        // "AB" is shift-down, shift+A, all-up, shift-down, shift+B, all-up —
        // deliberately NOT one shift held across both.
        val reports = HidKeyMapper.buildReports("AB")
        assertEquals(6, reports.size)
        assertEquals(0x02.toByte(), reports[0][0])
        assertEquals(0x00.toByte(), reports[0][2])
        assertEquals(0x04.toByte(), reports[1][2])
        assertTrue(isKeyUp(reports[2]))
        assertEquals(0x02.toByte(), reports[3][0])
        assertEquals(0x00.toByte(), reports[3][2])
        assertEquals(0x05.toByte(), reports[4][2])
        assertTrue(isKeyUp(reports[5]))
    }

    @Test
    fun `losing any single report costs at most one character`() {
        // Structural check on the stream, not a model of any real host: drop
        // each report in turn, replay on the pessimistic host below, and
        // require the damage to stay local. It is a weaker guard than
        // `modifier state never carries...` above (which is what actually
        // fails on the held-Shift version) because a real host can misbehave
        // in ways this model does not reproduce — the field failure came from
        // the host apparently not honouring a modifier-only report at all.
        // Keep both: this one catches blast radius, that one catches state.
        // The real field text, which has exactly the shape that exposed the
        // stateful version: long unshifted runs between case changes, so one
        // lost modifier report had ~70 characters to corrupt.
        val text = "`knowledge-ledger` (shared data contract) ## Attribution " +
            "This suite derives from **Kieran Klaassen, \"To Read\"** " +
            "(<https://every.to/source-code>) 2026 v1 100% SKILL.md"
        val full = HidKeyMapper.buildReports(text)
        for (drop in full.indices) {
            val lossy = full.filterIndexed { i, _ -> i != drop }
            val got = replayLossy(lossy)
            val wrong = text.length - lcsLength(text, got)
            assertTrue(
                "dropping report $drop cost $wrong characters: \"$got\"",
                wrong <= 1
            )
        }
    }

    @Test
    fun `no key-down report ever also changes the modifier`() {
        // The corruption this guards against, seen in the field: a host that
        // applies the keycode before the new modifier byte types the
        // unshifted character ("To Read" -> "to read", "<" -> ","), and one
        // that applies it before clearing a stale Shift types capitals
        // nobody asked for ("the" -> "THE", "github.com" -> "GitHub.com").
        val text = "# Build Prompt: `knowledge-ledger` (shared data contract) " +
            "**Kieran Klaassen** <https://every.to/source-code> \"Not in v1\" " +
            "## Role -- CLI/API 100% {a} [b] ~x~ ?! a|b c\\d e^f g&h i+j_k"
        var modifier: Byte = 0
        for (r in HidKeyMapper.buildReports(text)) {
            if (r[2] == 0.toByte()) {
                modifier = r[0]
            } else {
                assertEquals(
                    "key-down changed the modifier in the same report",
                    modifier,
                    r[0]
                )
            }
        }
        assertEquals("stream must end with nothing held", 0.toByte(), modifier)
    }

    @Test
    fun `a host replaying the stream gets the text back verbatim`() {
        val samples = listOf(
            "Hello, world!",
            "# Build Prompt: `knowledge-ledger` (shared data contract)",
            "(<https://github.com/EveryInc/compound-engineering-plugin>)",
            "## Role\tIf a downstream skill needs a field that isn't here",
            "THE END -- 100% of it {ok} [yes] ~fine~ a|b c\\d e^f",
        )
        for (s in samples) {
            assertEquals(s, typedText(HidKeyMapper.buildReports(s)))
        }
    }

    // --- ASCII fallbacks for characters a US keyboard has no key for ---

    @Test
    fun `em dash types as a double hyphen instead of vanishing`() {
        // Field bug: "a program — most of it" arrived on the host as
        // "a program  most of it" — the dash silently dropped mid-sentence.
        assertEquals("--", HidKeyMapper.asciiFallback('—'))
        assertEquals(
            "a program -- most of it",
            typedText(HidKeyMapper.buildReports("a program — most of it"))
        )
    }

    @Test
    fun `typographic quotes ellipses and en dashes fall back to ASCII`() {
        // Exactly what the cleanup LLM and pasted prose produce.
        val fancy = "“well…” he said, ‘it’s fine’ – really"
        assertEquals(
            "\"well...\" he said, 'it's fine' - really",
            typedText(HidKeyMapper.buildReports(fancy))
        )
    }

    @Test
    fun `exotic spaces become real spaces and zero-width junk disappears`() {
        // nbsp, thin space and ideographic space are real spaces;
        // zero-width space and a stray BOM type nothing at all.
        val text = "a\u00A0b\u2009c\u200Bd\u3000e\uFEFF"
        assertEquals("a b cd e", typedText(HidKeyMapper.buildReports(text)))
    }

    @Test
    fun `accented letters fold to their base letter rather than dropping out`() {
        val text = "café naïve Zoë straße Æ œuvre"
        assertEquals(
            "cafe naive Zoe strasse AE oeuvre",
            typedText(HidKeyMapper.buildReports(text))
        )
    }

    @Test
    fun `every fallback expands to characters that are themselves typeable`() {
        // A fallback naming an untypeable character would land us right back
        // where we started: silently dropped text.
        for (code in 0x20..0xFFFF) {
            val c = code.toChar()
            val fallback = HidKeyMapper.asciiFallback(c) ?: continue
            for (f in fallback) {
                assertNotNull(
                    "fallback for U+%04X maps '%s' to nothing".format(code, f),
                    HidKeyMapper.map(f)
                )
            }
        }
    }

    @Test
    fun `buildReports skips characters with no honest ASCII form`() {
        assertTrue(HidKeyMapper.buildReports("中文").isEmpty()) // CJK
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
        // a-down, release, ctrl-down, ctrl+j-down, all-up, b-down, release
        assertEquals(7, reports.size)
        assertEquals("ctrl must arrive alone", 0x01.toByte(), reports[2][0])
        assertEquals(0x00.toByte(), reports[2][2])
        assertEquals(0x01.toByte(), reports[3][0])
        assertEquals(HidKeyMapper.KEY_J, reports[3][2])
        assertTrue("ctrl released with the key", isKeyUp(reports[4]))
        assertEquals(0x00.toByte(), reports[5][0])
        assertEquals(0x05.toByte(), reports[5][2])
    }

    @Test
    fun `backslash-enter newline mode types a backslash then Enter`() {
        val reports = HidKeyMapper.buildReports(
            "a\nb", HidKeyMapper.NewlineMode.BACKSLASH_ENTER
        )
        // a, backslash, enter, b — all unshifted, each a down/up pair
        assertEquals(8, reports.size)
        assertEquals(HidKeyMapper.KEY_BACKSLASH, reports[2][2])
        assertEquals(0x00.toByte(), reports[2][0])
        assertTrue(isKeyUp(reports[3]))
        assertEquals(HidKeyMapper.KEY_ENTER, reports[4][2])
        assertTrue(isKeyUp(reports[5]))
    }

    @Test
    fun `end-enter newline mode presses End before the Enter`() {
        val reports = HidKeyMapper.buildReports(
            "\n", HidKeyMapper.NewlineMode.END_ENTER
        )
        // End, then Enter — each its own down/up pair. End breaks a CLI
        // composer out of paste-burst state so the Enter behind it submits.
        assertEquals(4, reports.size)
        assertEquals(HidKeyMapper.KEY_END, reports[0][2])
        assertEquals("End takes no modifier", 0x00.toByte(), reports[0][0])
        assertTrue(isKeyUp(reports[1]))
        assertEquals(HidKeyMapper.KEY_ENTER, reports[2][2])
        assertTrue(isKeyUp(reports[3]))
    }

    @Test
    fun `soft newlines keep the down-release pair stream`() {
        for (mode in HidKeyMapper.NewlineMode.values()) {
            val reports = HidKeyMapper.buildReports("hi\nthere\n", mode)
            assertTrue("mode $mode should end released", isKeyUp(reports.last()))
            // Every key-down is followed by a report that releases it.
            for ((i, r) in reports.withIndex()) {
                if (r[2] == 0.toByte()) continue
                assertTrue("mode $mode: key-down at $i has no release", i + 1 < reports.size)
                assertEquals(
                    "mode $mode: key at $i not released by the next report",
                    0.toByte(),
                    reports[i + 1][2]
                )
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
        assertEquals(
            HidKeyMapper.NewlineMode.END_ENTER,
            HidKeyMapper.NewlineMode.fromWire("end_enter")
        )
        // Older/unknown clients must still get a plain Enter, never nothing.
        assertEquals(HidKeyMapper.NewlineMode.ENTER, HidKeyMapper.NewlineMode.fromWire(null))
        assertEquals(HidKeyMapper.NewlineMode.ENTER, HidKeyMapper.NewlineMode.fromWire(""))
        assertEquals(HidKeyMapper.NewlineMode.ENTER, HidKeyMapper.NewlineMode.fromWire("shift_enter"))
    }

    @Test
    fun `buildReports releases every key it presses and ends released`() {
        val reports = HidKeyMapper.buildReports("Hello, world! It's 100% — done.")
        assertTrue(isKeyUp(reports.last()))
        for ((i, r) in reports.withIndex()) {
            if (r[2] == 0.toByte()) continue
            // key-down: exactly one keycode, in slot 1
            for (j in 3..7) assertEquals(0.toByte(), r[j])
            assertEquals(
                "key at $i not released by the next report",
                0.toByte(),
                reports[i + 1][2]
            )
        }
    }
}
