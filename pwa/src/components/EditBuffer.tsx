export type VoiceEditState = "idle" | "listening" | "applying";

interface EditBufferProps {
  text: string;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  onDiscard: () => void;
  /** null hides the voice edit button (cleanup LLM unavailable) */
  voiceEdit: {
    state: VoiceEditState;
    error: string | null;
    onToggle: () => void;
  } | null;
}

/**
 * Review buffer shown between transcription and HID typing when
 * "Edit before send" is on. Text is editable by keyboard, or — when the
 * cleanup LLM is running — by voice: tap "Edit by voice", speak an
 * instruction ("replace Mike with Sarah", "delete the last sentence"),
 * tap again to apply it to the buffer.
 */
export function EditBuffer({
  text,
  onChange,
  onSend,
  onDiscard,
  voiceEdit,
}: EditBufferProps) {
  const busy = voiceEdit !== null && voiceEdit.state !== "idle";

  return (
    <div className="w-full max-w-sm">
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy}
        className="w-full bg-gray-900 text-white border border-gray-700 rounded p-3 text-sm resize-none disabled:opacity-60"
        rows={4}
        autoFocus
      />
      {voiceEdit && (
        <>
          <button
            onClick={voiceEdit.onToggle}
            disabled={voiceEdit.state === "applying"}
            className={`w-full py-2 mt-2 rounded text-sm font-medium transition-colors ${
              voiceEdit.state === "listening"
                ? "bg-orange-500 text-white animate-pulse"
                : voiceEdit.state === "applying"
                  ? "bg-gray-700 text-gray-400"
                  : "bg-gray-800 text-emerald-400 hover:bg-gray-700"
            }`}
          >
            {voiceEdit.state === "listening"
              ? "Listening... tap to apply"
              : voiceEdit.state === "applying"
                ? "Applying edit..."
                : "🎙 Edit by voice"}
          </button>
          {voiceEdit.error && (
            <p className="mt-1 text-xs text-red-400 text-center">
              {voiceEdit.error}
            </p>
          )}
        </>
      )}
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => onSend(text)}
          disabled={!text.trim() || busy}
          className="flex-1 py-2 bg-sky-600 text-white rounded text-sm font-medium disabled:opacity-50"
        >
          Send
        </button>
        <button
          onClick={onDiscard}
          disabled={busy}
          className="flex-1 py-2 bg-gray-800 text-gray-300 rounded text-sm disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
