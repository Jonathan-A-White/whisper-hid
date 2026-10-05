import { canShare } from "../lib/delivery";

interface PhoneResultProps {
  text: string;
  /** "copied" = brief confirmation; "tap" = auto-copy was refused */
  notice: "copied" | "tap" | null;
  onCopy: () => void;
  onShare: () => void;
}

/** A dictation kept on this phone: the text with big Copy again / Share
 *  buttons. Share is hidden where the browser has no Web Share. */
export function PhoneResult({ text, notice, onCopy, onShare }: PhoneResultProps) {
  const share = canShare(typeof navigator === "undefined" ? undefined : navigator);
  return (
    <div className="mt-4 w-full max-w-sm">
      <p className="bg-gray-900 border border-gray-700 rounded p-3 text-sm text-white whitespace-pre-wrap break-words max-h-40 overflow-y-auto select-text">
        {text}
      </p>
      <p
        className={`mt-1 h-4 text-xs text-center ${
          notice === "copied" ? "text-green-400" : "text-yellow-400"
        }`}
      >
        {notice === "copied" ? "Copied" : notice === "tap" ? "Tap Copy" : ""}
      </p>
      <div className="flex gap-2 mt-1">
        <button
          onClick={onCopy}
          className="flex-1 py-4 bg-sky-600 text-white rounded-lg text-lg font-semibold active:scale-95 transition-transform"
        >
          Copy again
        </button>
        {share && (
          <button
            onClick={onShare}
            className="flex-1 py-4 bg-emerald-600 text-white rounded-lg text-lg font-semibold active:scale-95 transition-transform"
          >
            Share
          </button>
        )}
      </div>
    </div>
  );
}
