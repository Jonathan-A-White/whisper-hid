import { useState, useEffect } from "react";
import type { SendTo } from "../types";
import {
  copyEntry,
  deleteEntry,
  editEntry,
  sendDisabledFor,
  sendEntry,
  toggleActionRow,
} from "../lib/historyActions";
import { HistoryActions } from "./HistoryActions";
import { EntryEditor } from "./EntryEditor";

interface HistoryViewProps {
  store: {
    entries: { id: string; text: string; timestamp: number; pinned: boolean; model?: string; speedRatio?: number; audioDuration?: number; processingMs?: number }[];
    searchQuery: string;
    setSearchQuery: (q: string) => void;
    deleteEntry: (id: string) => Promise<void>;
    updateEntry: (id: string, text: string) => Promise<void>;
    togglePin: (id: string) => Promise<void>;
    clearAll: () => Promise<void>;
  };
  hid: {
    sendText: (text: string) => Promise<boolean>;
  };
  sendTo?: SendTo;
}

export function HistoryView({ store, hid, sendTo }: HistoryViewProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // The brief "Copied" notice on the tapped entry
  useEffect(() => {
    if (!copiedId) return;
    const t = setTimeout(() => setCopiedId(null), 2000);
    return () => clearTimeout(t);
  }, [copiedId]);

  const handleCopy = async (id: string, text: string) => {
    const { copied } = await copyEntry(text, navigator.clipboard);
    if (copied) setCopiedId(id);
  };

  const startEditing = (entry: { id: string; text: string }) => {
    const next = editEntry(entry);
    setOpenId(null);
    setEditingId(next.editingId);
    setEditText(next.editText);
  };

  const saveEdit = () => {
    if (editingId && editText.trim()) {
      store.updateEntry(editingId, editText);
    }
    setEditingId(null);
    setEditText("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
  };

  const handleDelete = async (id: string) => {
    setOpenId(null);
    await deleteEntry(id, store);
  };

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">History</h2>
        {store.entries.length > 0 && (
          <button
            onClick={() => {
              if (confirmClear) {
                store.clearAll();
                setConfirmClear(false);
              } else {
                setConfirmClear(true);
                setTimeout(() => setConfirmClear(false), 3000);
              }
            }}
            className="text-xs text-red-400 px-2 py-1"
          >
            {confirmClear ? "Confirm Clear?" : "Clear All"}
          </button>
        )}
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search history..."
        value={store.searchQuery}
        onChange={(e) => store.setSearchQuery(e.target.value)}
        className="w-full bg-gray-900 text-white border border-gray-700 rounded px-3 py-2 text-sm mb-4 placeholder-gray-500"
      />

      {store.entries.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">
          {store.searchQuery ? "No matches" : "No transcriptions yet"}
        </p>
      ) : (
        <div className="space-y-2">
          {store.entries.map((entry) => (
            <div key={entry.id} className="rounded">
              <div className="bg-gray-900 p-3 border border-gray-800 rounded">
                {editingId === entry.id ? (
                  <EntryEditor
                    text={editText}
                    onChange={setEditText}
                    onSave={saveEdit}
                    onCancel={cancelEdit}
                  />
                ) : (
                  /* Normal display */
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <button
                        onClick={() => setOpenId(toggleActionRow(openId, entry.id))}
                        className="text-left text-sm text-gray-200 flex-1 hover:text-white"
                      >
                        {entry.text}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          store.togglePin(entry.id);
                        }}
                        className={`p-2 text-sm flex-shrink-0 ${
                          entry.pinned ? "text-yellow-400" : "text-gray-500"
                        }`}
                        title={entry.pinned ? "Unpin" : "Pin"}
                      >
                        {entry.pinned ? "\u2605" : "\u2606"}
                      </button>
                    </div>
                    <p className="text-xs text-gray-600 mt-1">
                      {copiedId === entry.id && (
                        <span className="text-green-400">Copied · </span>
                      )}
                      {formatTime(entry.timestamp)}
                      {entry.model && (
                        <span className="text-gray-500"> · {entry.model}</span>
                      )}
                      {entry.speedRatio != null && (
                        <span className={entry.speedRatio >= 1 ? "text-green-600" : "text-yellow-600"}> · {entry.speedRatio.toFixed(1)}x</span>
                      )}
                    </p>
                    {openId === entry.id && (
                      <HistoryActions
                        sendDisabled={sendDisabledFor(sendTo)}
                        onSend={() => sendEntry(entry.text, { sendTo, hid })}
                        onCopy={() => handleCopy(entry.id, entry.text)}
                        onEdit={() => startEditing(entry)}
                        onDelete={() => handleDelete(entry.id)}
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
