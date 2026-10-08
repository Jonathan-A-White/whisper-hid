import { useState } from "react";
import { CLEANUP_INFO } from "../lib/cleanupInfo";

/**
 * Small 'i' button; tap shows what Cleanup is right below, tap again hides it.
 * Rendered in a flex row, so the explanation takes a full-width line of its own.
 */
export function CleanupInfo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="What is Cleanup?"
        aria-expanded={open}
        className={`w-6 h-6 rounded-full text-xs font-semibold italic transition-colors ${
          open ? "bg-sky-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
        }`}
      >
        i
      </button>
      {open && (
        <p className="basis-full text-xs text-gray-400 bg-gray-900 rounded px-3 py-2">
          {CLEANUP_INFO}
        </p>
      )}
    </>
  );
}
