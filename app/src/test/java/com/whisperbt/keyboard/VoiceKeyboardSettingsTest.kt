package com.whisperbt.keyboard

import android.content.Intent
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

/** Auto Enter's persistence, the gear key's launch, the picker's gear, and the layouts' key sizes. */
class VoiceKeyboardSettingsTest {

    private class FakeStore : BooleanStore {
        val map = mutableMapOf<String, Boolean>()
        override fun getBoolean(key: String, default: Boolean) = map[key] ?: default
        override fun putBoolean(key: String, value: Boolean) { map[key] = value }
    }

    // --- persistence -------------------------------------------------------

    @Test
    fun `auto enter is off until switched on`() {
        assertFalse(VoiceKeyboardSettings(FakeStore()).autoEnter)
    }

    @Test
    fun `auto enter persists across a restart`() {
        val store = FakeStore()
        VoiceKeyboardSettings(store).autoEnter = true
        assertTrue(VoiceKeyboardSettings(store).autoEnter)
        VoiceKeyboardSettings(store).autoEnter = false
        assertFalse(VoiceKeyboardSettings(store).autoEnter)
    }

    @Test
    fun `the settings screen and the keyboard share one preferences file and key`() {
        val store = FakeStore()
        VoiceKeyboardSettings(store).autoEnter = true // what the settings screen does
        assertEquals(mapOf(VoiceKeyboardSettings.KEY_AUTO_ENTER to true), store.map)
        assertEquals("voice_keyboard", VoiceKeyboardSettings.PREFS_NAME)
        assertEquals("auto_enter", VoiceKeyboardSettings.KEY_AUTO_ENTER)

        // Both ends reach the setting only through VoiceKeyboardSettings, never a literal key.
        for (name in listOf("VoiceInputMethodService.kt", "VoiceSettingsActivity.kt")) {
            val src = File("src/main/java/com/whisperbt/keyboard/$name").readText()
            assertTrue("$name uses VoiceKeyboardSettings", src.contains("VoiceKeyboardSettings"))
            assertFalse("$name hard-codes the key", src.contains("\"auto_enter\""))
            assertFalse("$name opens its own prefs", src.contains("getSharedPreferences"))
        }
    }

    // --- gear key ----------------------------------------------------------

    @Test
    fun `the gear key starts the settings screen as a new task`() {
        val flags = mutableListOf<Int>()
        VoiceSettingsLauncher.open { flags += it }
        assertEquals(1, flags.size)
        assertEquals(Intent.FLAG_ACTIVITY_NEW_TASK, flags[0] and Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    // --- the picker's gear: method.xml and the manifest --------------------

    private fun parse(path: String): Element =
        DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(File(path)).documentElement

    private val activityClass = VoiceSettingsActivity::class.java.name

    @Test
    fun `method xml points settingsActivity at the settings activity`() {
        val root = parse("src/main/res/xml/method.xml")
        assertEquals("input-method", root.tagName)
        assertEquals(activityClass, root.getAttribute("android:settingsActivity"))
    }

    @Test
    fun `the manifest exports the settings activity`() {
        val manifest = parse("src/main/AndroidManifest.xml")
        val activities = manifest.getElementsByTagName("activity")
        val shortName = "." + activityClass.substringAfterLast('.')
        val found = (0 until activities.length).map { activities.item(it) as Element }
            .filter { it.getAttribute("android:name") == shortName || it.getAttribute("android:name") == activityClass }
        assertEquals(1, found.size)
        assertEquals("true", found[0].getAttribute("android:exported"))
    }

    // --- layouts -----------------------------------------------------------

    private fun dp(v: String): Double {
        assertTrue("$v is in dp", v.endsWith("dp"))
        return v.removeSuffix("dp").toDouble()
    }

    private fun allElements(e: Element): List<Element> =
        listOf(e) + (0 until e.childNodes.length).map { e.childNodes.item(it) }
            .filterIsInstance<Element>().flatMap { allElements(it) }

    private fun byId(root: Element, id: String): Element =
        allElements(root).firstOrNull { it.getAttribute("android:id") == "@+id/$id" }
            ?: fail("no view $id").let { error("unreachable") }

    @Test
    fun `the keyboard has the five keys, each at least 48dp, fitting a 360dp screen`() {
        val root = parse("src/main/res/layout/voice_keyboard.xml")
        val ids = listOf("voiceSwitch", "voiceSettings", "voiceMic", "voiceEnter", "voiceBackspace")
        val keys = ids.map { byId(root, it) }
        val row = allElements(root).first { it.getAttribute("android:id") == "@+id/voiceMic" }
            .parentNode as Element
        // All five sit in one row, in this order.
        val rowIds = (0 until row.childNodes.length).map { row.childNodes.item(it) }
            .filterIsInstance<Element>().map { it.getAttribute("android:id").removePrefix("@+id/") }
        assertEquals(ids, rowIds)

        val screen = 360.0
        val rootPad = dp(root.getAttribute("android:padding"))
        val totalWeight = keys.sumOf { it.getAttribute("android:layout_weight").toDouble() }
        val margins = keys.sumOf {
            dp(it.getAttribute("android:layout_marginStart").ifEmpty { "0dp" }) +
                dp(it.getAttribute("android:layout_marginEnd").ifEmpty { "0dp" })
        }
        val perWeight = (screen - 2 * rootPad - margins) / totalWeight
        for (k in keys) {
            val id = k.getAttribute("android:id")
            assertEquals("$id width is weighted", "0dp", k.getAttribute("android:layout_width"))
            val width = perWeight * k.getAttribute("android:layout_weight").toDouble()
            assertTrue("$id is $width dp wide", width >= 48.0)
            assertTrue("$id is tall enough", dp(k.getAttribute("android:layout_height")) >= 48.0)
            // A Button's default minWidth would push neighbours into each other.
            assertTrue("$id minWidth", dp(k.getAttribute("android:minWidth")) <= 48.0)
        }
    }

    @Test
    fun `auto enter is not on the keyboard`() {
        val src = File("src/main/res/layout/voice_keyboard.xml").readText().lowercase()
        assertFalse(src.contains("switch\n") || src.contains("<switch") || src.contains("switchcompat"))
        assertFalse(src.contains("auto enter") || src.contains("auto_enter"))
    }

    @Test
    fun `the settings screen has the Auto Enter switch, at least 48dp tall`() {
        val root = parse("src/main/res/layout/activity_voice_settings.xml")
        val sw = byId(root, "autoEnterSwitch")
        assertTrue(dp(sw.getAttribute("android:minHeight")) >= 48.0)
        assertTrue(sw.tagName.endsWith("Switch") || sw.tagName.endsWith("SwitchCompat"))
        val text = sw.getAttribute("android:text")
        assertEquals("@string/voice_auto_enter", text)
        val strings = File("src/main/res/values/strings.xml").readText()
        assertTrue(strings.contains(">Auto Enter<"))
    }
}
