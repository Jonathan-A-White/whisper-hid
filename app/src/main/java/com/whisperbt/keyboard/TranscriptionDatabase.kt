package com.whisperbt.keyboard

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class TranscriptionEntry(
    val id: Long,
    val text: String,
    val timestamp: Long,
    val pinned: Boolean
)

class TranscriptionDatabase(context: Context) :
    SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {

    companion object {
        private const val DB_NAME = "transcriptions.db"
        private const val DB_VERSION = 1
        private const val TABLE = "history"
        private const val COL_ID = "id"
        private const val COL_TEXT = "text"
        private const val COL_TIMESTAMP = "timestamp"
        private const val COL_PINNED = "pinned"
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE $TABLE (
                $COL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
                $COL_TEXT TEXT NOT NULL,
                $COL_TIMESTAMP INTEGER NOT NULL,
                $COL_PINNED INTEGER NOT NULL DEFAULT 0
            )"""
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    fun insert(text: String): Long {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return -1
        val values = ContentValues().apply {
            put(COL_TEXT, trimmed)
            put(COL_TIMESTAMP, System.currentTimeMillis())
            put(COL_PINNED, 0)
        }
        return writableDatabase.insert(TABLE, null, values)
    }

    fun getAll(): List<TranscriptionEntry> {
        val list = mutableListOf<TranscriptionEntry>()
        val cursor = readableDatabase.query(
            TABLE, null, null, null, null, null,
            "$COL_PINNED DESC, $COL_TIMESTAMP DESC"
        )
        cursor.use {
            while (it.moveToNext()) {
                list.add(cursorToEntry(it))
            }
        }
        return list
    }

    fun search(query: String): List<TranscriptionEntry> {
        val list = mutableListOf<TranscriptionEntry>()
        val cursor = readableDatabase.query(
            TABLE, null,
            "$COL_TEXT LIKE ?",
            arrayOf("%$query%"),
            null, null,
            "$COL_PINNED DESC, $COL_TIMESTAMP DESC"
        )
        cursor.use {
            while (it.moveToNext()) {
                list.add(cursorToEntry(it))
            }
        }
        return list
    }

    fun getPinned(): List<TranscriptionEntry> {
        val list = mutableListOf<TranscriptionEntry>()
        val cursor = readableDatabase.query(
            TABLE, null,
            "$COL_PINNED = 1",
            null, null, null,
            "$COL_TIMESTAMP DESC"
        )
        cursor.use {
            while (it.moveToNext()) {
                list.add(cursorToEntry(it))
            }
        }
        return list
    }

    fun getLatest(): TranscriptionEntry? {
        val cursor = readableDatabase.query(
            TABLE, null, null, null, null, null,
            "$COL_TIMESTAMP DESC", "1"
        )
        cursor.use {
            return if (it.moveToFirst()) cursorToEntry(it) else null
        }
    }

    fun delete(id: Long) {
        writableDatabase.delete(TABLE, "$COL_ID = ?", arrayOf(id.toString()))
    }

    fun deleteAll() {
        writableDatabase.delete(TABLE, null, null)
    }

    fun setPinned(id: Long, pinned: Boolean) {
        val values = ContentValues().apply {
            put(COL_PINNED, if (pinned) 1 else 0)
        }
        writableDatabase.update(TABLE, values, "$COL_ID = ?", arrayOf(id.toString()))
    }

    private fun cursorToEntry(cursor: android.database.Cursor): TranscriptionEntry {
        return TranscriptionEntry(
            id = cursor.getLong(cursor.getColumnIndexOrThrow(COL_ID)),
            text = cursor.getString(cursor.getColumnIndexOrThrow(COL_TEXT)),
            timestamp = cursor.getLong(cursor.getColumnIndexOrThrow(COL_TIMESTAMP)),
            pinned = cursor.getInt(cursor.getColumnIndexOrThrow(COL_PINNED)) == 1
        )
    }
}
