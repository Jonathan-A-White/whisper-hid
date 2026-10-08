import { describe, expect, it } from "vitest";
import source from "./HistoryView.tsx?raw";
import actionsSource from "./HistoryActions.tsx?raw";
import { HistoryActions, HISTORY_ACTION_LABELS } from "./HistoryActions";

// There are no render tests for screens, so this checks the source.

describe("HistoryView", () => {
  it("renders the shared action row", () => {
    expect(source).toContain('from "./HistoryActions"');
    expect(source).toContain("<HistoryActions");
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

describe("HistoryActions", () => {
  it("is one exported component with the four labels in order", () => {
    expect(typeof HistoryActions).toBe("function");
    expect(HISTORY_ACTION_LABELS).toEqual(["Send", "Copy", "Edit", "Delete"]);
  });
  it("each button is at least 44 px", () => {
    expect(actionsSource).toContain("min-h-[44px]");
    expect(actionsSource).toContain("min-w-[44px]");
  });
});
