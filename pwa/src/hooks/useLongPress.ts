import { useMemo, useRef } from "react";
import type { PointerEvent } from "react";
import { createLongPress } from "../lib/entryMenu";

/** Pointer handlers that call `onLongPress` after a 500 ms hold. Spread them on
 *  the element; a short tap, a scroll or a cancelled press does nothing. The
 *  browser's own context menu (a long press on text) opens the same menu. */
export function useLongPress(onLongPress: () => void) {
  const latest = useRef(onLongPress);
  latest.current = onLongPress;

  return useMemo(() => {
    const press = createLongPress({
      onLongPress: () => latest.current(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
    });
    return {
      onPointerDown: (e: PointerEvent) => press.start(e.clientX, e.clientY),
      onPointerMove: (e: PointerEvent) => press.move(e.clientX, e.clientY),
      onPointerUp: press.end,
      onPointerCancel: press.cancel,
      onPointerLeave: press.cancel,
      onContextMenu: (e: { preventDefault: () => void }) => {
        e.preventDefault();
        latest.current();
      },
    };
  }, []);
}
