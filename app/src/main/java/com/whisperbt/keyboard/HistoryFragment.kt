package com.whisperbt.keyboard

import android.app.AlertDialog
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class HistoryFragment : Fragment() {

    private lateinit var searchInput: EditText
    private lateinit var clearSearch: ImageButton
    private lateinit var clearAllRow: LinearLayout
    private lateinit var clearAllButton: Button
    private lateinit var historyRecycler: RecyclerView
    private lateinit var emptyState: TextView
    private lateinit var historyAdapter: HistoryAdapter

    private val mainActivity get() = activity as? MainActivity
    private val dateFormat = SimpleDateFormat("MMM d, yyyy  h:mm a", Locale.getDefault())

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View? {
        return inflater.inflate(R.layout.fragment_history, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        searchInput = view.findViewById(R.id.searchInput)
        clearSearch = view.findViewById(R.id.clearSearch)
        clearAllRow = view.findViewById(R.id.clearAllRow)
        clearAllButton = view.findViewById(R.id.clearAllButton)
        historyRecycler = view.findViewById(R.id.historyRecycler)
        emptyState = view.findViewById(R.id.emptyState)

        historyAdapter = HistoryAdapter(
            items = emptyList(),
            onItemClick = { showPreviewDialog(it) },
            onPinClick = { togglePin(it) },
            onDeleteClick = { deleteItem(it) }
        )
        historyRecycler.layoutManager = LinearLayoutManager(requireContext())
        historyRecycler.adapter = historyAdapter

        searchInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                val query = s?.toString()?.trim() ?: ""
                clearSearch.visibility = if (query.isNotEmpty()) View.VISIBLE else View.GONE
                refreshHistory(query)
            }
        })

        clearSearch.setOnClickListener {
            searchInput.text.clear()
        }

        clearAllButton.setOnClickListener {
            AlertDialog.Builder(requireContext())
                .setTitle(R.string.confirm_clear_all)
                .setMessage(R.string.confirm_clear_all_message)
                .setPositiveButton(R.string.clear_all_history) { _, _ ->
                    mainActivity?.db?.deleteAll()
                    refreshHistory()
                    mainActivity?.talkFragment?.refreshPinned()
                    Toast.makeText(requireContext(), R.string.history_cleared, Toast.LENGTH_SHORT)
                        .show()
                }
                .setNegativeButton(R.string.cancel, null)
                .show()
        }
    }

    override fun onResume() {
        super.onResume()
        if (!isHidden) refreshHistory()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) refreshHistory()
    }

    private fun refreshHistory(query: String = searchInput.text.toString().trim()) {
        val db = mainActivity?.db ?: return
        val items = if (query.isEmpty()) db.getAll() else db.search(query)
        historyAdapter.updateItems(items)

        if (items.isEmpty()) {
            historyRecycler.visibility = View.GONE
            emptyState.visibility = View.VISIBLE
            clearAllRow.visibility = View.GONE
        } else {
            historyRecycler.visibility = View.VISIBLE
            emptyState.visibility = View.GONE
            clearAllRow.visibility = View.VISIBLE
        }
    }

    private fun showPreviewDialog(entry: TranscriptionEntry) {
        val dialogView = LayoutInflater.from(requireContext())
            .inflate(R.layout.dialog_history_preview, null)

        dialogView.findViewById<TextView>(R.id.previewText).text = entry.text
        dialogView.findViewById<TextView>(R.id.previewDate).text =
            dateFormat.format(Date(entry.timestamp))

        val pinLabel = if (entry.pinned) getString(R.string.unpin) else getString(R.string.pin)

        AlertDialog.Builder(requireContext())
            .setView(dialogView)
            .setPositiveButton(R.string.send) { _, _ ->
                sendText(entry.text)
            }
            .setNeutralButton(pinLabel) { _, _ ->
                togglePin(entry)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun sendText(text: String) {
        val hidService = mainActivity?.hidService
        if (hidService?.isConnected() == true) {
            val toSend = buildString {
                append(text)
                if (mainActivity?.socketService?.appendNewline == true) append('\n')
                else if (mainActivity?.socketService?.appendSpace == true) append(' ')
            }
            hidService.sendString(toSend)
            Toast.makeText(requireContext(), "Sent: ${text.take(50)}", Toast.LENGTH_SHORT).show()
            mainActivity?.appendLog("[Resend] $text")
        } else {
            Toast.makeText(requireContext(), "Not connected", Toast.LENGTH_SHORT).show()
        }
    }

    private fun togglePin(entry: TranscriptionEntry) {
        val db = mainActivity?.db ?: return
        db.setPinned(entry.id, !entry.pinned)
        refreshHistory()
        mainActivity?.talkFragment?.refreshPinned()
        val msg = if (entry.pinned) R.string.item_unpinned else R.string.item_pinned
        Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    private fun deleteItem(entry: TranscriptionEntry) {
        val db = mainActivity?.db ?: return
        db.delete(entry.id)
        refreshHistory()
        if (entry.pinned) mainActivity?.talkFragment?.refreshPinned()
        Toast.makeText(requireContext(), R.string.item_deleted, Toast.LENGTH_SHORT).show()
    }
}
