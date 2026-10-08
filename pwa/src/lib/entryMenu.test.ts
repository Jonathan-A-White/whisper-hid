import { describe, expect, it, vi } from "vitest";
import {
  HINT_KEY,
  HINT_TEXT,
  LONG_PRESS_MS,
  MENU_LABELS,
  createLongPress,
  markHintSeen,
  menuItems,
  shouldShowHint,
} from "./entryMenu";

/** A hand-cranked timer: advance(ms) fires what is due. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

/** An entry whose long press sets `menu`, the way History does. */
function entry() {
  const clock = fakeClock();
  const state = { menu: null as string | null };
  const press = createLongPress({
    onLongPress: () => {
      state.menu = "e1";
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, state, press };
}

describe("long press", () => {
  it("is 500 ms", () => {
    expect(LONG_PRESS_MS).toBe(500);
  });

  it("holding 500 ms opens the menu", () => {
    const { clock, state, press } = entry();
    press.start(10, 10);
    clock.advance(499);
    expect(state.menu).toBeNull();
    clock.advance(1);
    expect(state.menu).toBe("e1");
  });

  it("a short tap does not open the menu", () => {
    const { clock, state, press } = entry();
    press.start(10, 10);
    clock.advance(150);
    press.end();
    clock.advance(1000);
    expect(state.menu).toBeNull();
  });

  it("moving the finger (a scroll) cancels it", () => {
    const { clock, state, press } = entry();
    press.start(10, 10);
    press.move(10, 40);
    clock.advance(1000);
    expect(state.menu).toBeNull();
  });

  it("a small wobble does not cancel it", () => {
    const { clock, state, press } = entry();
    press.start(10, 10);
    press.move(13, 12);
    clock.advance(500);
    expect(state.menu).toBe("e1");
  });

  it("a cancelled press (pointercancel) does not open the menu", () => {
    const { clock, state, press } = entry();
    press.start(10, 10);
    press.cancel();
    clock.advance(1000);
    expect(state.menu).toBeNull();
  });

  it("fires once per press", () => {
    const onLongPress = vi.fn();
    const clock = fakeClock();
    const press = createLongPress({ onLongPress, ...clock });
    press.start(0, 0);
    clock.advance(5000);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});

describe("menu items", () => {
  const handlers = () => ({
    onSend: vi.fn(),
    onCopy: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  });

  it("are Send, Copy, Edit, Delete, Cancel in order", () => {
    expect(MENU_LABELS).toEqual(["Send", "Copy", "Edit", "Delete", "Cancel"]);
    const items = menuItems(handlers(), vi.fn());
    expect(items.map((i) => i.label)).toEqual([...MENU_LABELS]);
  });

  it("each action runs its handler, then closes the menu", () => {
    for (const label of ["Send", "Copy", "Edit", "Delete"]) {
      const h = handlers();
      const close = vi.fn();
      const item = menuItems(h, close).find((i) => i.label === label)!;
      item.run();
      const fn = { Send: h.onSend, Copy: h.onCopy, Edit: h.onEdit, Delete: h.onDelete }[
        label as "Send"
      ];
      expect(fn, label).toHaveBeenCalledTimes(1);
      expect(close, label).toHaveBeenCalledTimes(1);
    }
  });

  it("Cancel closes without running an action", () => {
    const h = handlers();
    const close = vi.fn();
    menuItems(h, close).find((i) => i.label === "Cancel")!.run();
    expect(close).toHaveBeenCalledTimes(1);
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  it("Send is greyed with This phone on, and does nothing", () => {
    const h = handlers();
    const close = vi.fn();
    const send = menuItems(h, close, { sendDisabled: true }).find((i) => i.label === "Send")!;
    expect(send.disabled).toBe(true);
    const others = menuItems(h, close, { sendDisabled: true }).filter((i) => i.label !== "Send");
    expect(others.every((i) => !i.disabled)).toBe(true);
  });
});

describe("first-open hint", () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    return {
      data,
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
  };

  it("says to hold an entry for options", () => {
    expect(HINT_TEXT).toBe("Hold an entry for options");
  });

  it("shows until it has been marked seen", () => {
    const s = store();
    expect(shouldShowHint(s)).toBe(true);
    markHintSeen(s);
    expect(s.data[HINT_KEY]).toBe("1");
    expect(shouldShowHint(s)).toBe(false);
  });

  it("is hidden, not thrown, when storage is missing or refuses", () => {
    expect(shouldShowHint(undefined)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(shouldShowHint(broken)).toBe(false);
    expect(() => markHintSeen(broken)).not.toThrow();
  });
});
