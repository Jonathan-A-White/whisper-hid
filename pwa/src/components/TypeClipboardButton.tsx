import { useCallback, useState } from "react";
import type { Settings, TargetMode } from "../types";
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
    <div className="flex flex-col items-start">
      <button
        onClick={handleClick}
        className="px-4 py-1.5 rounded-full text-sm font-medium bg-gray-800 text-sky-400 hover:bg-gray-700 transition-colors"
      >
        ⌨️ Type clipboard
      </button>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
