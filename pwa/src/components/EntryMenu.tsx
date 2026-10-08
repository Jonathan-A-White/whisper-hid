import { menuItems } from "../lib/entryMenu";
import { HistoryActions } from "./HistoryActions";

interface EntryMenuProps {
  open: boolean;
  onSend: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Send types over Bluetooth, so it is off while "This phone" is on. */
  sendDisabled?: boolean;
}

/** The options menu a long press opens on an entry: a bottom sheet with Send,
 *  Copy, Edit, Delete and Cancel. It closes on an action, Cancel, or a tap
 *  outside. Shared by History and the Talk screen's last transcript. */
export function EntryMenu({ open, onClose, sendDisabled, ...handlers }: EntryMenuProps) {
  if (!open) return null;
  const items = menuItems(handlers, onClose, { sendDisabled });
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i.run]));
  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/60"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label="Entry options"
        className="w-full rounded-t-xl border-t border-gray-700 bg-gray-900 px-4 pt-4"
        style={{ paddingBottom: "calc(var(--bar-inset) + 1rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <HistoryActions
          stacked
          sendDisabled={sendDisabled}
          onSend={byLabel.Send}
          onCopy={byLabel.Copy}
          onEdit={byLabel.Edit}
          onDelete={byLabel.Delete}
        />
        <button
          onClick={onClose}
          className="mt-2 flex w-full min-h-[44px] items-center justify-center rounded bg-gray-800 text-sm font-medium text-gray-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
