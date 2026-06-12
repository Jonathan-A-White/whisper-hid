import { useCallback, useEffect, useState } from "react";
import {
  getSymbols,
  putSymbols,
  resetSymbols,
  type SymbolConfig,
  type SymbolEntry,
  type SymbolSpacing,
} from "../lib/api";

const SPACING_OPTIONS: Array<{ value: SymbolSpacing; label: string }> = [
  { value: "both", label: "join both" },
  { value: "left", label: "join left" },
  { value: "right", label: "join right" },
  { value: "none", label: "keep spaces" },
];

export function SymbolReplacements() {
  const [config, setConfig] = useState<SymbolConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPhrase, setNewPhrase] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [newSpacing, setNewSpacing] = useState<SymbolSpacing>("both");

  useEffect(() => {
    getSymbols()
      .then((c) => setConfig(c))
      .catch(() => setError("Cannot reach Whisper server"));
  }, []);

  const save = useCallback(async (partial: Partial<SymbolConfig>) => {
    try {
      const saved = await putSymbols(partial);
      setConfig(saved);
      setError(null);
    } catch {
      setError("Failed to save");
    }
  }, []);

  const handleAdd = async () => {
    if (!config) return;
    const phrase = newPhrase.trim();
    const symbol = newSymbol;
    if (!phrase || !symbol) return;
    const entries = [
      ...config.entries.filter(
        (e) => e.phrase.toLowerCase() !== phrase.toLowerCase()
      ),
      { phrase, symbol, spacing: newSpacing },
    ];
    await save({ entries });
    setNewPhrase("");
    setNewSymbol("");
    setNewSpacing("both");
  };

  const handleRemove = (entry: SymbolEntry) => {
    if (!config) return;
    save({ entries: config.entries.filter((e) => e !== entry) });
  };

  const handleSpacingChange = (entry: SymbolEntry, spacing: SymbolSpacing) => {
    if (!config) return;
    save({
      entries: config.entries.map((e) => (e === entry ? { ...e, spacing } : e)),
    });
  };

  const handleReset = async () => {
    try {
      setConfig(await resetSymbols());
      setError(null);
    } catch {
      setError("Failed to reset");
    }
  };

  return (
    <div className="space-y-3">
      <label className="text-sm text-gray-300 block">
        Spoken symbols (say a word, type a symbol)
      </label>
      <p className="text-xs text-gray-600">
        When symbol mode is on, spoken phrases are replaced by symbols, e.g.
        &quot;forward slash help&quot; &rarr; &quot;/help&quot;. Toggle symbol
        mode from the Talk screen.
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {config === null && !error ? (
        <p className="text-xs text-gray-500">Loading...</p>
      ) : config !== null ? (
        <>
          {/* Symbol mode toggle */}
          <label className="flex items-center justify-between">
            <span className="text-sm text-gray-300">Symbol mode</span>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => save({ enabled: e.target.checked })}
              className="w-5 h-5 accent-sky-500"
            />
          </label>

          {/* Existing entries */}
          {config.entries.length > 0 ? (
            <div className="space-y-1">
              {config.entries.map((entry) => (
                <div
                  key={entry.phrase}
                  className="flex items-center gap-2 bg-gray-900 rounded px-3 py-1.5"
                >
                  <span className="text-sm text-red-300 flex-1 truncate">
                    {entry.phrase}
                  </span>
                  <span className="text-gray-600 text-xs">&rarr;</span>
                  <span className="text-sm text-green-300 font-mono whitespace-pre">
                    {entry.symbol}
                  </span>
                  <select
                    value={entry.spacing}
                    onChange={(e) =>
                      handleSpacingChange(
                        entry,
                        e.target.value as SymbolSpacing
                      )
                    }
                    className="bg-gray-800 text-gray-400 border border-gray-700 rounded px-1 py-0.5 text-xs"
                  >
                    {SPACING_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleRemove(entry)}
                    className="text-gray-600 hover:text-red-400 text-sm ml-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-600">
              No symbol entries. Add one below or restore the defaults.
            </p>
          )}

          {/* Add new entry */}
          <div className="space-y-2">
            <input
              type="text"
              value={newPhrase}
              onChange={(e) => setNewPhrase(e.target.value)}
              placeholder="Spoken phrase (e.g. forward slash)"
              className="w-full bg-gray-900 text-white border border-gray-700 rounded px-2 py-1.5 text-sm placeholder-gray-600"
            />
            <input
              type="text"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              placeholder="Symbol (e.g. /)"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              className="w-full bg-gray-900 text-white border border-gray-700 rounded px-2 py-1.5 text-sm placeholder-gray-600 font-mono"
            />
            <select
              value={newSpacing}
              onChange={(e) => setNewSpacing(e.target.value as SymbolSpacing)}
              className="w-full bg-gray-900 text-white border border-gray-700 rounded px-2 py-1.5 text-sm"
            >
              <option value="both">Join both sides (foo-bar)</option>
              <option value="left">Join left only (key: value)</option>
              <option value="right">Join right only (&quot;(x&quot;)</option>
              <option value="none">Keep spaces</option>
            </select>
            <button
              onClick={handleAdd}
              disabled={!newPhrase.trim() || !newSymbol}
              className="w-full py-2 bg-sky-600 text-white rounded text-sm font-medium disabled:opacity-40 hover:bg-sky-500"
            >
              Add symbol
            </button>
          </div>

          <button
            onClick={handleReset}
            className="w-full py-2 rounded bg-gray-800 text-gray-400 text-sm"
          >
            Restore default symbols
          </button>
        </>
      ) : null}
    </div>
  );
}
