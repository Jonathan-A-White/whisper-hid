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
}
