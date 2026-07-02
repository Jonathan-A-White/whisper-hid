import { useEffect, useState } from "react";
import { getCleanup, putCleanup } from "../lib/api";

/**
 * Quick on/off pill for speech cleanup (a local LLM strips filler words and
 * false starts, applies spoken self-corrections, and fixes punctuation on
 * the final transcript). Cleanup adds a few seconds after Stop, so it lives
 * on the Talk screen for easy flipping. Hidden while the Whisper server is
 * unreachable or the cleanup model/binary isn't installed.
 */
export function CleanupToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    getCleanup()
      .then((c) => {
        setEnabled(c.enabled);
        setAvailable(c.available);
      })
      .catch(() => setEnabled(null));
  }, []);

  // Keep showing the pill while enabled-but-unavailable (e.g. the model is
  // still loading after a server restart) so it can be turned off.
  if (enabled === null || (!available && !enabled)) return null;

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      const saved = await putCleanup(next);
      setEnabled(saved.enabled);
      setAvailable(saved.available);
    } catch {
      setEnabled(!next);
    }
  };

  return (
    <button
      onClick={toggle}
      className={`mt-2 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
        enabled
          ? "bg-emerald-600 text-white"
          : "bg-gray-800 text-gray-500 hover:bg-gray-700"
      }`}
    >
      ✨ Cleanup {enabled ? "on" : "off"}
    </button>
  );
}
