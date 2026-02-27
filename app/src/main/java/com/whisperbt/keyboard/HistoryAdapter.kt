package com.whisperbt.keyboard

import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class HistoryAdapter(
    private var items: List<TranscriptionEntry>,
    private val onItemClick: (TranscriptionEntry) -> Unit,
    private val onPinClick: (TranscriptionEntry) -> Unit,
    private val onDeleteClick: (TranscriptionEntry) -> Unit
) : RecyclerView.Adapter<HistoryAdapter.ViewHolder>() {

    private val dateFormat = SimpleDateFormat("MMM d, yyyy  h:mm a", Locale.getDefault())

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val text: TextView = view.findViewById(R.id.historyText)
        val date: TextView = view.findViewById(R.id.historyDate)
        val pinButton: ImageButton = view.findViewById(R.id.pinButton)
        val deleteButton: ImageButton = view.findViewById(R.id.deleteButton)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_history, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val item = items[position]
        holder.text.text = item.text
        holder.date.text = dateFormat.format(Date(item.timestamp))

        val pinColor = if (item.pinned) {
            holder.itemView.context.getColor(R.color.primary)
        } else {
            holder.itemView.context.getColor(R.color.on_surface_secondary)
        }
        holder.pinButton.imageTintList = ColorStateList.valueOf(pinColor)

        holder.itemView.setOnClickListener { onItemClick(item) }
        holder.pinButton.setOnClickListener { onPinClick(item) }
        holder.deleteButton.setOnClickListener { onDeleteClick(item) }
    }

    override fun getItemCount() = items.size

    fun updateItems(newItems: List<TranscriptionEntry>) {
        items = newItems
        notifyDataSetChanged()
    }
}
