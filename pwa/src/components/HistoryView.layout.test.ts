import { describe, expect, it } from "vitest";
import source from "./HistoryView.tsx?raw";
import wordsSource from "./EntryWords.tsx?raw";
import actionsSource from "./HistoryActions.tsx?raw";
import { HistoryActions, HISTORY_ACTION_LABELS } from "./HistoryActions";

// There are no render tests for screens, so this checks the source.

describe("HistoryView", () => {
  it("has no inline action row: the actions live in the long-press menu", () => {
    expect(source).not.toContain("<HistoryActions");
    expect(source).not.toContain("toggleActionRow");
    expect(source).toContain('from "./EntryMenu"');
    expect(source).toContain("<EntryMenu");
  });
  it("opens the menu by a long press on the words, and a tap does nothing", () => {
    expect(source).toContain("<EntryWords");
    expect(wordsSource).toContain("useLongPress");
    expect(source).not.toMatch(/onClick=\{\(\) => setOpenId/);
  });
  it("shows the one-time hint", () => {
    expect(source).toContain("HINT_TEXT");
    expect(source).toContain("shouldShowHint");
  });
  it("no longer carries the long-press or swipe handlers", () => {
    for (const gone of [
      "longPressFired",
      "LONG_PRESS_MS",
      "onTouchStart",
      "onTouchMove",
      "onTouchEnd",
      "swipedId",
      "DELETE_WIDTH",
      "translateX",
    ]) {
      expect(source).not.toContain(gone);
    }
  });
  it("still renders the star", () => {
    expect(source).toContain("togglePin");
    expect(source).toContain("\\u2605");
  });
});

describe("HistoryActions (inside the menu)", () => {
  it("is one exported component with the four labels in order", () => {
    expect(typeof HistoryActions).toBe("function");
    expect(HISTORY_ACTION_LABELS).toEqual(["Send", "Copy", "Edit", "Delete"]);
  });
  it("each button is at least 44 px", () => {
    expect(actionsSource).toContain("min-h-[44px]");
    expect(actionsSource).toContain("min-w-[44px]");
  });
});
