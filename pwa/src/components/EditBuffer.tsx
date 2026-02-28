import { useState } from "react";

interface EditBufferProps {
  text: string;
  onSend: (text: string) => void;
  onDiscard: () => void;
}

export function EditBuffer({ text, onSend, onDiscard }: EditBufferProps) {
  const [value, setValue] = useState(text);

  return (
    <div className="w-full max-w-sm">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full bg-gray-900 text-white border border-gray-700 rounded p-3 text-sm resize-none"
        rows={4}
        autoFocus
      />
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => onSend(value)}
          disabled={!value.trim()}
          className="flex-1 py-2 bg-sky-600 text-white rounded text-sm font-medium disabled:opacity-50"
        >
          Send
        </button>
        <button
          onClick={onDiscard}
          className="flex-1 py-2 bg-gray-800 text-gray-300 rounded text-sm"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
