import { useCallback, useEffect, useState } from "react";
import { getCorrections, putCorrections } from "../lib/api";

export function WordCorrections() {
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newFrom, setNewFrom] = useState("");
  const [newTo, setNewTo] = useState("");

  const fetchCorrections = useCallback(async () => {
    try {
      const data = await getCorrections();
      setCorrections(data);
      setError(null);
    } catch {
      setError("Cannot reach Whisper server");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCorrections();
  }, [fetchCorrections]);

  const handleAdd = async () => {
    const from = newFrom.trim();
    const to = newTo.trim();
    if (!from || !to) return;

    const updated = { ...corrections, [from.toLowerCase()]: to };
    try {
      const saved = await putCorrections(updated);
      setCorrections(saved);
      setNewFrom("");
      setNewTo("");
      setError(null);
    } catch {
      setError("Failed to save");
    }
  };

  const handleRemove = async (key: string) => {
    const updated = { ...corrections };
    delete updated[key];
    try {
      const saved = await putCorrections(updated);
      setCorrections(saved);
      setError(null);
    } catch {
      setError("Failed to save");
    }
  };

  const entries = Object.entries(corrections);

  return (
    <div className="space-y-3">
      <label className="text-sm text-gray-300 block">
        Word corrections (auto-replace after transcription)
      </label>

      {loading ? (
        <p className="text-xs text-gray-500">Loading...</p>
      ) : error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : (
        <>
          {/* Existing entries */}
          {entries.length > 0 ? (
            <div className="space-y-1">
              {entries.map(([from, to]) => (
                <div
                  key={from}
                  className="flex items-center gap-2 bg-gray-900 rounded px-3 py-1.5"
                >
                  <span className="text-sm text-red-300 flex-1 truncate">
                    {from}
                  </span>
                  <span className="text-gray-600 text-xs">&rarr;</span>
                  <span className="text-sm text-green-300 flex-1 truncate">
                    {to}
                  </span>
                  <button
                    onClick={() => handleRemove(from)}
                    className="text-gray-600 hover:text-red-400 text-sm ml-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-600">
              No corrections yet. Add words that Whisper frequently gets wrong.
            </p>
          )}

          {/* Add new entry */}
          <div className="flex gap-2">
            <input
              type="text"
              value={newFrom}
              onChange={(e) => setNewFrom(e.target.value)}
              placeholder="Wrong word"
              className="flex-1 bg-gray-900 text-white border border-gray-700 rounded px-2 py-1.5 text-sm placeholder-gray-600"
            />
            <input
              type="text"
              value={newTo}
              onChange={(e) => setNewTo(e.target.value)}
              placeholder="Correct word"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              className="flex-1 bg-gray-900 text-white border border-gray-700 rounded px-2 py-1.5 text-sm placeholder-gray-600"
            />
            <button
              onClick={handleAdd}
              disabled={!newFrom.trim() || !newTo.trim()}
              className="px-3 py-1.5 bg-sky-600 text-white rounded text-sm disabled:opacity-40 hover:bg-sky-500"
            >
              Add
            </button>
          </div>
        </>
      )}
    </div>
  );
}
