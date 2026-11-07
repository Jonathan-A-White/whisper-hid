package com.whisperbt.keyboard

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import org.junit.Assert.assertEquals
import org.junit.Test

/** The Enter key: a KEYCODE_ENTER for fields that take keys (Termux), the IME action otherwise. */
class EnterKeyTest {

    private class FakeTarget : EnterTarget {
        val calls = mutableListOf<String>()
        override fun sendKey(keyCode: Int) { calls += "key:$keyCode" }
        override fun performAction(action: Int) { calls += "action:$action" }
    }

    private val target = FakeTarget()

    private val textInput = 1 // TYPE_CLASS_TEXT

    @Test
    fun `a TYPE_NULL field such as Termux gets KEYCODE_ENTER down and up`() {
        EnterKey.press(target, inputType = 0, imeOptions = EditorInfo.IME_ACTION_SEND)
        assertEquals(listOf("key:${KeyEvent.KEYCODE_ENTER}"), target.calls)
    }

    @Test
    fun `a field with an IME action gets that action`() {
        EnterKey.press(target, textInput, EditorInfo.IME_ACTION_SEND)
        assertEquals(listOf("action:${EditorInfo.IME_ACTION_SEND}"), target.calls)

        target.calls.clear()
        EnterKey.press(target, textInput, EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI)
        assertEquals(listOf("action:${EditorInfo.IME_ACTION_SEARCH}"), target.calls)
    }

    @Test
    fun `a field with no action or unspecified action gets KEYCODE_ENTER`() {
        EnterKey.press(target, textInput, EditorInfo.IME_ACTION_NONE)
        EnterKey.press(target, textInput, EditorInfo.IME_ACTION_UNSPECIFIED)
        assertEquals(listOf("key:66", "key:66"), target.calls)
    }

    @Test
    fun `a field that asks for no enter action gets KEYCODE_ENTER even with an action set`() {
        EnterKey.press(target, textInput, EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_ENTER_ACTION)
        assertEquals(listOf("key:66"), target.calls)
    }

    @Test
    fun `no editor at all still sends the key`() {
        EnterKey.press(target, inputType = 0, imeOptions = 0)
        assertEquals(listOf("key:66"), target.calls)
    }

    // --- after-dictation modes: the one function that decides what to press ---

    private val multiLine = 0x20001 // TYPE_CLASS_TEXT | TYPE_TEXT_FLAG_MULTI_LINE

    /** A chat box (Postern, Google Voice): multi-line, declares Send. A multi-line EditText also sets NO_ENTER_ACTION. */
    private val sendField = FieldInfo(
        "org.example.chat", multiLine, EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_ENTER_ACTION
    )

    /** A notes box: multi-line, declares nothing. */
    private val plainField = FieldInfo(
        "org.example.notes", multiLine, EditorInfo.IME_ACTION_UNSPECIFIED or EditorInfo.IME_FLAG_NO_ENTER_ACTION
    )

    /** Termux. */
    private val termux = FieldInfo("com.termux", 0, 0)

    private val send = EnterPress.Action(EditorInfo.IME_ACTION_SEND)

    private fun pressFor(mode: AfterDictation, field: FieldInfo, overrides: Map<String, AfterDictation> = emptyMap()) =
        AutoEnter.decide(mode, field, overrides)

    @Test
    fun `Off presses nothing in any field`() {
        for (f in listOf(sendField, plainField, termux)) assertEquals(EnterPress.None, pressFor(AfterDictation.OFF, f))
    }

    @Test
    fun `Enter presses the Enter key in any field, even one that declares Send`() {
        for (f in listOf(sendField, plainField, termux)) assertEquals(EnterPress.Key, pressFor(AfterDictation.ENTER, f))
    }

    @Test
    fun `Send uses the field's own action, else Enter`() {
        assertEquals(send, pressFor(AfterDictation.SEND, sendField))
        assertEquals(EnterPress.Key, pressFor(AfterDictation.SEND, plainField))
        assertEquals(EnterPress.Key, pressFor(AfterDictation.SEND, termux))
    }

    @Test
    fun `Send also takes Go and Done`() {
        val go = FieldInfo("a", 1, EditorInfo.IME_ACTION_GO)
        val done = FieldInfo("a", 1, EditorInfo.IME_ACTION_DONE)
        assertEquals(EnterPress.Action(EditorInfo.IME_ACTION_GO), pressFor(AfterDictation.SEND, go))
        assertEquals(EnterPress.Action(EditorInfo.IME_ACTION_DONE), pressFor(AfterDictation.SEND, done))
    }

    @Test
    fun `Auto sends in a field that declares Send, presses nothing in a plain multi-line field, Enter in Termux`() {
        assertEquals(send, pressFor(AfterDictation.AUTO, sendField))
        assertEquals(EnterPress.None, pressFor(AfterDictation.AUTO, plainField))
        assertEquals(EnterPress.Key, pressFor(AfterDictation.AUTO, termux))
    }

    @Test
    fun `Auto sends in a field that declares Go but not in one that declares Search or Next or Done`() {
        assertEquals(
            EnterPress.Action(EditorInfo.IME_ACTION_GO),
            pressFor(AfterDictation.AUTO, FieldInfo("a", 1, EditorInfo.IME_ACTION_GO))
        )
        for (a in listOf(EditorInfo.IME_ACTION_SEARCH, EditorInfo.IME_ACTION_NEXT, EditorInfo.IME_ACTION_DONE)) {
            assertEquals(EnterPress.None, pressFor(AfterDictation.AUTO, FieldInfo("a", 1, a)))
        }
    }

    @Test
    fun `Auto treats a field with no input type (TYPE_NULL) as a terminal`() {
        assertEquals(EnterPress.Key, pressFor(AfterDictation.AUTO, FieldInfo("org.example.ssh", 0, 0)))
        assertEquals(EnterPress.Key, pressFor(AfterDictation.AUTO, FieldInfo(null, 0, EditorInfo.IME_ACTION_SEND)))
    }

    @Test
    fun `Termux subpackages and Termux with a Send action are still a terminal`() {
        assertEquals(EnterPress.Key, pressFor(AfterDictation.AUTO, FieldInfo("com.termux", 1, EditorInfo.IME_ACTION_SEND)))
        assertEquals(EnterPress.Key, pressFor(AfterDictation.AUTO, FieldInfo("com.termux.x11", 1, 0)))
        assertEquals(EnterPress.None, pressFor(AfterDictation.AUTO, FieldInfo("com.termuxfake", multiLine, 0)))
    }

    @Test
    fun `a per-app override wins over the global mode, in either direction`() {
        val overrides = mapOf(
            "org.example.chat" to AfterDictation.OFF,
            "org.example.notes" to AfterDictation.ENTER,
            "com.termux" to AfterDictation.SEND
        )
        assertEquals(EnterPress.None, pressFor(AfterDictation.AUTO, sendField, overrides))
        assertEquals(EnterPress.Key, pressFor(AfterDictation.AUTO, plainField, overrides))
        assertEquals(EnterPress.Key, pressFor(AfterDictation.AUTO, termux, overrides)) // Send, no action, so Enter
        // global Off, but this app is on Auto
        assertEquals(send, pressFor(AfterDictation.OFF, sendField, mapOf("org.example.chat" to AfterDictation.AUTO)))
        // another app's override is ignored
        assertEquals(send, pressFor(AfterDictation.AUTO, sendField, mapOf("org.example.notes" to AfterDictation.OFF)))
    }

    @Test
    fun `performing a press sends the key, the action, or nothing`() {
        EnterKey.perform(target, EnterPress.None)
        assertEquals(emptyList<String>(), target.calls)
        EnterKey.perform(target, EnterPress.Key)
        EnterKey.perform(target, send)
        assertEquals(listOf("key:66", "action:${EditorInfo.IME_ACTION_SEND}"), target.calls)
    }
}
