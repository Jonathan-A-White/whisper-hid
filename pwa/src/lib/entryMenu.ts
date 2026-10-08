// The options menu an entry opens by a long press (Talk's last transcript and
// History). Pure logic, so the timing and the menu's items are testable
// without a screen: the timer and storage are passed in.

/** A finger held this long on an entry's words opens the menu. */
export const LONG_PRESS_MS = 500;

/** A finger that moves further than this is scrolling, not holding. */
export const MOVE_TOLERANCE_PX = 10;

export interface LongPressDeps {
  onLongPress: () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  ms?: number;
}

export interface LongPress {
  start: (x: number, y: number) => void;
  move: (x: number, y: number) => void;
  /** Finger lifted. */
  end: () => void;
  /** Press cancelled by the browser (pointercancel, a scroll taking over). */
  cancel: () => void;
}

export function createLongPress({
  onLongPress,
  setTimer,
  clearTimer,
  ms = LONG_PRESS_MS,
}: LongPressDeps): LongPress {
  let handle: unknown = null;
  let origin: { x: number; y: number } | null = null;

  const stop = () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
    origin = null;
  };

  return {
    start(x, y) {
      stop();
      origin = { x, y };
      handle = setTimer(() => {
        handle = null;
        origin = null;
        onLongPress();
      }, ms);
    },
    move(x, y) {
      if (!origin) return;
      if (Math.hypot(x - origin.x, y - origin.y) > MOVE_TOLERANCE_PX) stop();
    },
    end: stop,
    cancel: stop,
  };
}

export const MENU_LABELS = ["Send", "Copy", "Edit", "Delete", "Cancel"] as const;

export interface MenuHandlers {
  onSend: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export interface MenuItem {
  label: (typeof MENU_LABELS)[number];
  disabled: boolean;
  /** Runs the action (none for Cancel), then closes the menu. */
  run: () => void;
}

export function menuItems(
  handlers: MenuHandlers,
  close: () => void,
  { sendDisabled = false }: { sendDisabled?: boolean } = {}
): MenuItem[] {
  const acting = (fn: () => void) => () => {
    fn();
    close();
  };
  return [
    { label: "Send", disabled: sendDisabled, run: sendDisabled ? () => {} : acting(handlers.onSend) },
    { label: "Copy", disabled: false, run: acting(handlers.onCopy) },
    { label: "Edit", disabled: false, run: acting(handlers.onEdit) },
    { label: "Delete", disabled: false, run: acting(handlers.onDelete) },
    { label: "Cancel", disabled: false, run: close },
  ];
}

export const HINT_KEY = "entryMenuHintSeen";
export const HINT_TEXT = "Hold an entry for options";

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** True until the hint has been shown once. Storage that is missing or
 *  refuses reads as "seen", so the hint never nags. */
export function shouldShowHint(storage: StorageLike | undefined): boolean {
  try {
    return !!storage && storage.getItem(HINT_KEY) === null;
  } catch {
    return false;
  }
}

export function markHintSeen(storage: StorageLike | undefined): void {
  try {
    storage?.setItem(HINT_KEY, "1");
  } catch {
    // storage refused: the hint may show again, which is harmless
  }
}
