import { useEffect, useState } from "react";
import { getCleanup, putCleanup, type CleanupStyleInfo } from "../lib/api";

/**
 * Quick on/off pill for speech cleanup (a local LLM rewrites the final
 * transcript) plus a style picker for the rewrite flavor: plain cleanup,
 * Claude Code prompt, commit message, chat message, email, or bug report.
 * Cleanup adds a few seconds after Stop, so it lives on the Talk screen for
 * easy flipping. Hidden while the Whisper server is unreachable or the
 * cleanup model/binary isn't installed.
 */
export function CleanupToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [available, setAvailable] = useState(false);
  const [style, setStyle] = useState("standard");
  const [styles, setStyles] = useState<CleanupStyleInfo[]>([]);

  useEffect(() => {
    getCleanup()
      .then((c) => {
        setEnabled(c.enabled);
        setAvailable(c.available);
        setStyle(c.style ?? "standard");
        setStyles(c.styles ?? []);
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
      const saved = await putCleanup({ enabled: next });
      setEnabled(saved.enabled);
      setAvailable(saved.available);
    } catch {
      setEnabled(!next);
    }
  };

  const changeStyle = async (name: string) => {
    const previous = style;
    setStyle(name);
    try {
      const saved = await putCleanup({ style: name });
      setStyle(saved.style);
    } catch {
      setStyle(previous);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        onClick={toggle}
        className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
          enabled
            ? "bg-emerald-600 text-white"
            : "bg-gray-800 text-gray-500 hover:bg-gray-700"
        }`}
      >
        ✨ Cleanup {enabled ? "on" : "off"}
      </button>
      {/* Style picker — only meaningful while cleanup is on */}
      {enabled && styles.length > 1 && (
        <select
          value={style}
          onChange={(e) => changeStyle(e.target.value)}
          aria-label="Cleanup style"
          className="bg-gray-800 text-gray-300 rounded-full px-2 py-1.5 text-sm border-none"
        >
          {styles.map((s) => (
            <option key={s.name} value={s.name}>
              {s.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
