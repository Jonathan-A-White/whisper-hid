import { useEffect, useState } from "react";
import { getSymbols, putSymbols } from "../lib/api";
import { SettingsSwitchRow } from "./SettingsRow";

/**
 * On/off switch row for symbol mode (spoken words -> symbols), at the top of
 * Settings so it can be flipped between prose and code dictation. Hidden
 * while the Whisper server is unreachable.
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
    <SettingsSwitchRow
      label="Symbols"
      hint='Say "dash", type "-"; verbatim, so Cleanup is skipped.'
      checked={enabled}
      onChange={toggle}
    />
  );
}
