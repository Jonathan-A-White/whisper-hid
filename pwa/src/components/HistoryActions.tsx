export const HISTORY_ACTION_LABELS = ["Send", "Copy", "Edit", "Delete"] as const;

interface HistoryActionsProps {
  onSend: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Send types over Bluetooth, so it is off while "This phone" is on. */
  sendDisabled?: boolean;
  /** One button per line, for the bottom sheet. */
  stacked?: boolean;
}

const BUTTON =
  "flex-1 flex items-center justify-center min-h-[44px] min-w-[44px] rounded text-sm font-medium disabled:opacity-40";

/** The four action buttons inside the entry options menu (EntryMenu). */
export function HistoryActions({
  onSend,
  onCopy,
  onEdit,
  onDelete,
  sendDisabled,
  stacked,
}: HistoryActionsProps) {
  return (
    <div className={stacked ? "flex flex-col gap-2" : "flex gap-2 mt-2"} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={onSend}
        disabled={sendDisabled}
        className={`${BUTTON} bg-blue-600 text-white`}
      >
        Send
      </button>
      <button onClick={onCopy} className={`${BUTTON} bg-gray-700 text-white`}>
        Copy
      </button>
      <button onClick={onEdit} className={`${BUTTON} bg-gray-700 text-white`}>
        Edit
      </button>
      <button onClick={onDelete} className={`${BUTTON} bg-red-600 text-white`}>
        Delete
      </button>
    </div>
  );
}
