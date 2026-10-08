import { useEffect, useRef } from "react";

interface EntryEditorProps {
  text: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** The inline editor Edit opens, on a History entry and on the Talk screen's
 *  front message. Focuses with the cursor at the end. */
export function EntryEditor({ text, onChange, onSave, onCancel }: EntryEditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full bg-gray-800 text-white border border-gray-600 rounded px-2 py-1 text-sm resize-none focus:outline-none focus:border-blue-500"
      />
      <div className="flex gap-2 mt-2">
        <button
          onClick={onSave}
          disabled={!text.trim()}
          className="text-xs bg-blue-600 text-white px-3 py-1 rounded disabled:opacity-40"
        >
          Save
        </button>
        <button onClick={onCancel} className="text-xs text-gray-400 px-3 py-1">
          Cancel
        </button>
      </div>
    </div>
  );
}
