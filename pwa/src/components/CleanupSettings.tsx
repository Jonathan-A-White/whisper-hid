import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCleanup,
  putCleanup,
  type CleanupConfig,
  type CleanupModelInfo,
} from "../lib/api";

/**
 * Settings section for the speech cleanup LLM: pick which model the resident
 * llama-server runs (Qwen3-1.7B by default, Qwen3-4B when downloaded).
 * Switching restarts the llama-server; "available" stays false while the new
 * model loads, so we poll until it comes back.
 */
export function CleanupSettings() {
  const [config, setConfig] = useState<CleanupConfig | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    getCleanup()
      .then(setConfig)
      .catch(() => setConfig(null));
    return () => clearInterval(pollRef.current);
  }, []);

  const pollUntilAvailable = useCallback(() => {
    clearInterval(pollRef.current);
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts += 1;
      try {
        const c = await getCleanup();
        setConfig(c);
        if (c.available || attempts > 60) {
          clearInterval(pollRef.current);
          setSwitching(false);
        }
      } catch {
        clearInterval(pollRef.current);
        setSwitching(false);
      }
    }, 3000);
  }, []);

  if (config === null || config.models.length === 0) return null;

  const downloaded = config.models.filter((m) => m.downloaded);
  const missing = config.models.filter((m) => !m.downloaded);
  const active = downloaded.find((m) => m.active);

  const switchModel = async (name: string) => {
    setError(null);
    setSwitching(true);
    try {
      const saved = await putCleanup({ model: name });
      setConfig(saved);
      if (!saved.available) pollUntilAvailable();
      else setSwitching(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to switch model");
      setSwitching(false);
    }
  };

  return (
    <div>
      <label className="text-sm text-gray-300 block mb-1">
        Speech cleanup model
      </label>
      {downloaded.length > 0 ? (
        <select
          value={active?.name ?? ""}
          disabled={switching}
          onChange={(e) => switchModel(e.target.value)}
          className="w-full bg-gray-900 text-white border border-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
        >
          {downloaded.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} ({m.size_mb} MB)
            </option>
          ))}
        </select>
      ) : (
        <p className="text-sm text-gray-500 bg-gray-900 rounded px-3 py-2">
          No cleanup model installed
        </p>
      )}
      {switching && (
        <p className="text-xs text-sky-400 mt-1">
          Loading model... cleanup is unavailable until it finishes.
        </p>
      )}
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      {missing.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-gray-500 mb-1">
            Available to download via Termux:
          </p>
          <div className="space-y-1">
            {missing.map((m: CleanupModelInfo) => (
              <div
                key={m.name}
                className="flex items-center justify-between bg-gray-900 rounded px-3 py-1.5"
              >
                <div>
                  <span className="text-sm text-gray-400">{m.name}</span>
                  {m.description && (
                    <span className="text-xs text-gray-600 ml-2">
                      {m.description}
                    </span>
                  )}
                </div>
                <span className="text-xs text-gray-600 whitespace-nowrap ml-2">
                  ~{m.size_mb} MB
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-600 mt-1.5">
            Run: ./update-model.sh cleanup-4b
          </p>
        </div>
      )}
    </div>
  );
}
