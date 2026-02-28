import { useState, useRef, useCallback } from "react";

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

const DELETE_WIDTH = 80;
const SWIPE_THRESHOLD = 40;

export function HistoryView({ store, hid }: HistoryViewProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const touchRef = useRef<{
    startX: number;
    startY: number;
    id: string;
    startOffset: number;
    direction: "horizontal" | "vertical" | null;
  } | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const setCardRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) cardRefs.current.set(id, el);
      else cardRefs.current.delete(id);
    },
    [],
  );

  const closeSwipe = useCallback(() => {
    if (swipedId) {
      const el = cardRefs.current.get(swipedId);
      if (el) {
        el.style.transition = "transform 0.2s ease";
        el.style.transform = "translateX(0)";
      }
      setSwipedId(null);
    }
  }, [swipedId]);

  const handleTouchStart = (e: React.TouchEvent, id: string) => {
    if (swipedId && swipedId !== id) {
      closeSwipe();
    }
    touchRef.current = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      id,
      startOffset: swipedId === id ? -DELETE_WIDTH : 0,
      direction: null,
    };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const t = touchRef.current;
    if (!t) return;
    const dx = e.touches[0].clientX - t.startX;
    const dy = e.touches[0].clientY - t.startY;

    if (!t.direction) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
        t.direction = "vertical";
        return;
      }
      if (Math.abs(dx) > 8) {
        t.direction = "horizontal";
      } else {
        return;
      }
    }

    if (t.direction === "vertical") return;

    const el = cardRefs.current.get(t.id);
    if (el) {
      const offset = Math.min(0, Math.max(-DELETE_WIDTH, t.startOffset + dx));
      el.style.transition = "none";
      el.style.transform = `translateX(${offset}px)`;
    }
  };

  const handleTouchEnd = () => {
    const t = touchRef.current;
    if (!t) return;
    touchRef.current = null;

    const el = cardRefs.current.get(t.id);
    if (!el) return;

    const match = el.style.transform.match(/translateX\((-?[\d.]+)/);
    const currentOffset = match ? parseFloat(match[1]) : t.startOffset;

    el.style.transition = "transform 0.2s ease";
    if (currentOffset < -SWIPE_THRESHOLD) {
      el.style.transform = `translateX(-${DELETE_WIDTH}px)`;
      setSwipedId(t.id);
    } else {
      el.style.transform = "translateX(0)";
      if (swipedId === t.id) setSwipedId(null);
    }
  };

  const handleDelete = (id: string) => {
    store.deleteEntry(id);
    setSwipedId(null);
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
    <div className="p-4" onClick={() => swipedId && closeSwipe()}>
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
            <div key={entry.id} className="relative overflow-hidden rounded">
              {/* Delete action revealed on swipe */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(entry.id);
                }}
                className="absolute right-0 top-0 bottom-0 flex items-center justify-center bg-red-600 text-white text-sm font-medium"
                style={{ width: DELETE_WIDTH }}
              >
                Delete
              </button>
              {/* Sliding card */}
              <div
                ref={setCardRef(entry.id)}
                onTouchStart={(e) => handleTouchStart(e, entry.id)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                className="relative bg-gray-900 p-3 border border-gray-800"
                style={{ willChange: "transform" }}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    onClick={(e) => {
                      if (swipedId === entry.id) {
                        e.stopPropagation();
                        closeSwipe();
                        return;
                      }
                      hid.sendText(entry.text);
                    }}
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
                  {formatTime(entry.timestamp)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
