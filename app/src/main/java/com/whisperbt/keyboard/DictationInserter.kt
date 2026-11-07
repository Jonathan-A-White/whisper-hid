package com.whisperbt.keyboard

/** The part of the focused field's InputConnection that dictated text goes through. */
interface InsertTarget {
    fun commitText(text: String, newCursorPosition: Int)
    fun finishComposingText()
}

/**
 * Puts dictated text into the focused field. Free of Android types so the
 * field's behaviour can be faked in a unit test.
 */
class DictationInserter(private val target: InsertTarget) {
    /**
     * commitText replaces the composing region when the editor holds one, so
     * a stale region (an editor re-composing the word at the cursor, or text
     * left composing by the keyboard used before) would swallow the earlier
     * dictation. Finishing it first makes the text land at the cursor,
     * after what is already there. A selection is still replaced: that is
     * what typing over a selection means.
     */
    fun insert(text: String) {
        target.finishComposingText()
        target.commitText(text, 1)
    }
}
