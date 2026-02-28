import { useState } from "react";

interface HistoryViewProps {
  store: {
    entries: { id: string; text: string; timestamp: number; pinned: boolean }[];
    searchQuery: string;
    setSearchQuery: (q: string) => void;
    deleteEntry: (id: string) => Promise<void>;
    togglePin: (id: string) => Promise<void>;
    clearAll: () => Promise<void>;
  };
  hid: {
    sendText: (text: string) => Promise<boolean>;
  };
}

export function HistoryView({ store, hid }: HistoryViewProps) {
  const [confirmClear, setConfirmClear] = useState(false);

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
            <div
              key={entry.id}
              className="bg-gray-900 rounded p-3 border border-gray-800"
            >
              <div className="flex items-start justify-between gap-2">
                <button
                  onClick={() => hid.sendText(entry.text)}
                  className="text-left text-sm text-gray-200 flex-1 hover:text-white"
                >
                  {entry.text}
                </button>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={() => store.togglePin(entry.id)}
                    className={`p-1 text-xs ${
                      entry.pinned ? "text-yellow-400" : "text-gray-500"
                    }`}
                    title={entry.pinned ? "Unpin" : "Pin"}
                  >
                    {entry.pinned ? "\u2605" : "\u2606"}
                  </button>
                  <button
                    onClick={() => store.deleteEntry(entry.id)}
                    className="p-1 text-xs text-gray-500 hover:text-red-400"
                    title="Delete"
                  >
                    \u2715
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-600 mt-1">
                {formatTime(entry.timestamp)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
