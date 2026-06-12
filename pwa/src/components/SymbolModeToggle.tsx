import { useEffect, useState } from "react";
import { getSymbols, putSymbols } from "../lib/api";

/**
 * Quick on/off pill for symbol mode (spoken words -> symbols), shown on the
 * Talk screen so it can be flipped between prose and code dictation without
 * digging into Settings. Hidden while the Whisper server is unreachable.
 */
export function SymbolModeToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    getSymbols()
      .then((c) => setEnabled(c.enabled))
      .catch(() => setEnabled(null));
  }, []);

  if (enabled === null) return null;

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      const saved = await putSymbols({ enabled: next });
      setEnabled(saved.enabled);
    } catch {
      setEnabled(!next);
    }
  };

  return (
    <button
      onClick={toggle}
      className={`mt-4 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
        enabled
          ? "bg-sky-600 text-white"
          : "bg-gray-800 text-gray-500 hover:bg-gray-700"
      }`}
    >
      {"</>"} Symbols {enabled ? "on" : "off"}
    </button>
  );
}
