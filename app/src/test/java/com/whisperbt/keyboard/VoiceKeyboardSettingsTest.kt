package com.whisperbt.keyboard

import android.content.Intent
import android.view.inputmethod.EditorInfo
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

/** Auto Enter's persistence, the gear key's launch, the picker's gear, and the layouts' key sizes. */
class VoiceKeyboardSettingsTest {

    private class FakeStore : SettingsStore {
        val map = mutableMapOf<String, Any>()
        override fun contains(key: String) = map.containsKey(key)
        override fun getBoolean(key: String, default: Boolean) = map[key] as? Boolean ?: default
        override fun putBoolean(key: String, value: Boolean) { map[key] = value }
        override fun getString(key: String, default: String?) = map[key] as? String ?: default
        override fun putString(key: String, value: String) { map[key] = value }
    }

    // --- persistence and defaults -----------------------------------------

    @Test
    fun `a new install defaults to Auto`() {
        assertEquals(AfterDictation.AUTO, VoiceKeyboardSettings(FakeStore()).mode)
    }

    @Test
    fun `the 1_0_18 switch migrates - On becomes Auto and Off stays Off`() {
        val on = FakeStore().apply { putBoolean("auto_enter", true) }
        assertEquals(AfterDictation.AUTO, VoiceKeyboardSettings(on).mode)
        val off = FakeStore().apply { putBoolean("auto_enter", false) }
        assertEquals(AfterDictation.OFF, VoiceKeyboardSettings(off).mode)
    }

    @Test
    fun `a chosen mode wins over the old switch and persists across a restart`() {
        val store = FakeStore().apply { putBoolean("auto_enter", true) }
        for (m in AfterDictation.values()) {
            VoiceKeyboardSettings(store).mode = m
            assertEquals(m, VoiceKeyboardSettings(store).mode)
        }
        VoiceKeyboardSettings(store).mode = AfterDictation.OFF
        assertEquals(AfterDictation.OFF, VoiceKeyboardSettings(store).mode)
    }

    @Test
    fun `an unreadable stored mode falls back to Auto`() {
        val store = FakeStore().apply { putString("after_dictation", "banana") }
        assertEquals(AfterDictation.AUTO, VoiceKeyboardSettings(store).mode)
    }

    @Test
    fun `a mode changed in an app is remembered for that app only`() {
        val store = FakeStore()
        val settings = VoiceKeyboardSettings(store)
        settings.setAppMode("com.termux", AfterDictation.ENTER)
        settings.setAppMode("org.example.chat", AfterDictation.OFF)
        val again = VoiceKeyboardSettings(store)
        assertEquals(mapOf("com.termux" to AfterDictation.ENTER, "org.example.chat" to AfterDictation.OFF), again.appModes())
        assertEquals(AfterDictation.AUTO, again.mode)

        again.setAppMode("com.termux", AfterDictation.SEND) // changing it again replaces
        assertEquals(AfterDictation.SEND, VoiceKeyboardSettings(store).appModes()["com.termux"])
        again.setAppMode("com.termux", null) // back to the default
        assertEquals(setOf("org.example.chat"), VoiceKeyboardSettings(store).appModes().keys)
    }

    @Test
    fun `the decision for a field reads the global mode and the app list together`() {
        val settings = VoiceKeyboardSettings(FakeStore())
        val chat = FieldInfo("org.example.chat", 0x20001, EditorInfo.IME_ACTION_SEND)
        assertEquals(EnterPress.Action(EditorInfo.IME_ACTION_SEND), settings.pressFor(chat))
        settings.setAppMode("org.example.chat", AfterDictation.OFF)
        assertEquals(EnterPress.None, settings.pressFor(chat))
        settings.mode = AfterDictation.ENTER
        assertEquals(EnterPress.Key, settings.pressFor(FieldInfo("org.example.notes", 1, 0)))
    }

    @Test
    fun `a new install is Auto and works in Termux, Postern and Google Voice without any pick`() {
        val settings = VoiceKeyboardSettings(FakeStore())
        assertEquals(EnterPress.Key, settings.pressFor(FieldInfo("com.termux", 0, 0)))
        val sendBox = FieldInfo("org.example.postern", 0x20001, EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_ENTER_ACTION)
        assertEquals(EnterPress.Action(EditorInfo.IME_ACTION_SEND), settings.pressFor(sendBox))
        val voice = FieldInfo("com.google.android.apps.googlevoice", 0x20001, EditorInfo.IME_ACTION_SEND)
        assertEquals(EnterPress.Action(EditorInfo.IME_ACTION_SEND), settings.pressFor(voice))
    }

    @Test
    fun `the settings screen and the keyboard share one preferences file and keys`() {
        val store = FakeStore()
        VoiceKeyboardSettings(store).mode = AfterDictation.SEND // what the settings screen does
        assertEquals(mapOf<String, Any>(VoiceKeyboardSettings.KEY_MODE to "send"), store.map)
        assertEquals("voice_keyboard", VoiceKeyboardSettings.PREFS_NAME)
        assertEquals("after_dictation", VoiceKeyboardSettings.KEY_MODE)
        assertEquals("auto_enter", VoiceKeyboardSettings.KEY_AUTO_ENTER)

        // Both ends reach the setting only through VoiceKeyboardSettings, never a literal key.
        for (name in listOf("VoiceInputMethodService.kt", "VoiceSettingsActivity.kt")) {
            val src = File("src/main/java/com/whisperbt/keyboard/$name").readText()
            assertTrue("$name uses VoiceKeyboardSettings", src.contains("VoiceKeyboardSettings"))
            assertFalse("$name hard-codes a key", src.contains("\"auto_enter\"") || src.contains("\"after_dictation\""))
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
    fun `the settings screen offers the four modes, each at least 48dp tall`() {
        val root = parse("src/main/res/layout/activity_voice_settings.xml")
        val strings = File("src/main/res/values/strings.xml").readText()
        val expected = mapOf(
            "modeOff" to "voice_mode_off", "modeEnter" to "voice_mode_enter",
            "modeSend" to "voice_mode_send", "modeAuto" to "voice_mode_auto"
        )
        for ((id, str) in expected) {
            val b = byId(root, id)
            assertTrue("$id is a radio button", b.tagName.endsWith("RadioButton"))
            assertTrue("$id tall enough", dp(b.getAttribute("android:minHeight")) >= 48.0)
            assertEquals("@string/$str", b.getAttribute("android:text"))
            assertTrue("$str is defined", strings.contains("name=\"$str\""))
            // the same four are offered for an app
            val appId = id.replace("mode", "appMode")
            assertTrue("$appId tall enough", dp(byId(root, appId).getAttribute("android:minHeight")) >= 48.0)
        }
        assertTrue(strings.contains(">Off<"))
        assertTrue(strings.contains(">New line (Enter)<"))
        assertTrue(strings.contains(">Send<"))
        assertTrue(strings.contains(">Auto<"))
        assertTrue(strings.contains(">After each dictation<"))
        byId(root, "appModeSection")
        byId(root, "appModeList")
    }
}
