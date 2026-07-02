import { useCallback, useEffect, useState } from "react";
import {
  getCorrections,
  putCorrections,
  suggestCorrections,
  type CorrectionSuggestion,
} from "../lib/api";

export function WordCorrections() {
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newFrom, setNewFrom] = useState("");
  const [newTo, setNewTo] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<CorrectionSuggestion[] | null>(null);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);

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

  // Ask the cleanup LLM to scan recent dictations for likely mishearings.
  const handleSuggest = async () => {
    setSuggesting(true);
    setSuggestNote(null);
    try {
      const result = await suggestCorrections();
      const fresh = result.suggestions.filter(
        (s) => !(s.wrong.toLowerCase() in corrections)
      );
      setSuggestions(fresh);
      if (fresh.length === 0) {
        setSuggestNote(
          result.transcripts === 0
            ? "No recent dictations to analyze — dictate a few things first."
            : "No likely mishearings found in recent dictations."
        );
      }
    } catch (e) {
      setSuggestions(null);
      setSuggestNote(e instanceof Error ? e.message : "Suggestion request failed");
    } finally {
      setSuggesting(false);
    }
  };

  const handleAcceptSuggestion = async (s: CorrectionSuggestion) => {
    const updated = { ...corrections, [s.wrong.toLowerCase()]: s.right };
    try {
      const saved = await putCorrections(updated);
      setCorrections(saved);
      setSuggestions(
        (prev) => prev?.filter((x) => x.wrong !== s.wrong) ?? null
      );
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
          <div className="space-y-2">
            <input
              type="text"
              value={newFrom}
              onChange={(e) => setNewFrom(e.target.value)}
              placeholder="Wrong word"
              className="w-full bg-gray-900 text-white border border-gray-700 rounded px-2 py-1.5 text-sm placeholder-gray-600"
            />
            <input
              type="text"
              value={newTo}
              onChange={(e) => setNewTo(e.target.value)}
              placeholder="Correct word"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              className="w-full bg-gray-900 text-white border border-gray-700 rounded px-2 py-1.5 text-sm placeholder-gray-600"
            />
            <button
              onClick={handleAdd}
              disabled={!newFrom.trim() || !newTo.trim()}
              className="w-full py-2 bg-sky-600 text-white rounded text-sm font-medium disabled:opacity-40 hover:bg-sky-500"
            >
              Add correction
            </button>
          </div>

          {/* LLM-suggested corrections from recent dictations */}
          <div className="space-y-2">
            <button
              onClick={handleSuggest}
              disabled={suggesting}
              className="w-full py-2 bg-gray-800 text-emerald-400 rounded text-sm font-medium disabled:opacity-40 hover:bg-gray-700"
            >
              {suggesting ? "Analyzing recent dictations..." : "✨ Suggest corrections"}
            </button>
            {suggestNote && (
              <p className="text-xs text-gray-500">{suggestNote}</p>
            )}
            {suggestions && suggestions.length > 0 && (
              <div className="space-y-1">
                {suggestions.map((s) => (
                  <div
                    key={s.wrong}
                    className="flex items-center gap-2 bg-gray-900 rounded px-3 py-1.5"
                  >
                    <span className="text-sm text-red-300 flex-1 truncate">
                      {s.wrong}
                    </span>
                    <span className="text-gray-600 text-xs">&rarr;</span>
                    <span className="text-sm text-green-300 flex-1 truncate">
                      {s.right}
                    </span>
                    <button
                      onClick={() => handleAcceptSuggestion(s)}
                      className="text-emerald-400 hover:text-emerald-300 text-sm font-bold ml-1"
                      aria-label={`Add correction ${s.wrong} to ${s.right}`}
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
