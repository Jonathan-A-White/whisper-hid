export const HISTORY_ACTION_LABELS = ["Send", "Copy", "Edit", "Delete"] as const;

interface HistoryActionsProps {
  onSend: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Send types over Bluetooth, so it is off while "This phone" is on. */
  sendDisabled?: boolean;
}

const BUTTON =
  "flex-1 flex items-center justify-center min-h-[44px] min-w-[44px] rounded text-sm font-medium disabled:opacity-40";

/** The row of buttons under a tapped entry. Shared by History and the Talk
 *  screen's front message. */
export function HistoryActions({
  onSend,
  onCopy,
  onEdit,
  onDelete,
  sendDisabled,
}: HistoryActionsProps) {
  return (
    <div className="flex gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
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
