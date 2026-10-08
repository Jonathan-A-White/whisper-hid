import { useCallback, useState } from "react";
import type { Settings, TargetMode } from "../types";
import { CHIP_NOTE_CLASS, chipClass } from "../lib/chip";
import { typeClipboard } from "../lib/typeClipboard";

interface TypeClipboardButtonProps {
  target: TargetMode | null;
  settings: Pick<Settings, "appendNewline" | "newlineAfterEnd">;
  hid: {
    sendText: (text: string) => Promise<boolean>;
    sendNewline: () => Promise<void>;
  };
  store: { addEntry: (text: string) => Promise<unknown> };
}

/** Types what is on the phone clipboard on the host, with its error line. */
export function TypeClipboardButton({
  target,
  settings,
  hid,
  store,
}: TypeClipboardButtonProps) {
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setError(null);
    const result = await typeClipboard({
      readText: () => navigator.clipboard.readText(),
      target,
      settings,
      addEntry: store.addEntry,
      sendText: hid.sendText,
      sendNewline: hid.sendNewline,
    });
    if (result.status === "empty") setError("Clipboard is empty");
    else if (result.status === "blocked")
      setError("Couldn't read the clipboard — allow paste for this page");
  }, [target, settings, hid, store]);

  return (
    <>
      <button onClick={handleClick} className={chipClass()}>
        ⌨️ Type clipboard
      </button>
      {error && <p className={CHIP_NOTE_CLASS}>{error}</p>}
    </>
  );
}
