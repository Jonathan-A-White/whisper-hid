import { describe, expect, it } from "vitest";
import talk from "./TalkView.tsx?raw";
import history from "./HistoryView.tsx?raw";
import { HISTORY_ACTION_LABELS } from "./HistoryActions";

// There are no render tests for screens, so this checks the source: the Talk
// screen's front message is the store's entry, and its actions are the
// long-press menu History uses.

describe("TalkView front message", () => {
  it("uses the same options menu as History, and no inline row", () => {
    expect(talk).toContain('from "./EntryMenu"');
    expect(talk).toContain("<EntryMenu");
    expect(talk).not.toContain("<HistoryActions");
    expect(history).toContain('from "./EntryMenu"');
    expect(history).toContain("<EntryMenu");
    expect(history).not.toContain("<HistoryActions");
    expect(talk).toContain("<EntryWords");
    expect(history).toContain("<EntryWords");
    expect(HISTORY_ACTION_LABELS).toEqual(["Send", "Copy", "Edit", "Delete"]);
  });
  it("wires all four actions through the shared logic", () => {
    for (const fn of ["sendEntry", "copyEntry", "editEntry", "deleteEntry"]) {
      expect(talk, fn).toContain(fn);
      expect(history, fn).toContain(fn);
    }
  });
  it("renders the store's entry by id, with no copy of its own", () => {
    expect(talk).toContain("frontEntry(");
    expect(talk).toContain("store.allEntries");
    expect(talk).not.toContain("phoneText");
    expect(talk).not.toContain("setLastText");
    expect(talk).not.toContain("<PhoneResult");
  });
  it("edits and deletes go to the store", () => {
    expect(talk).toContain("store.updateEntry");
    expect(talk).toMatch(/deleteEntry\([^)]*store/);
  });
  it("shares the inline editor with History", () => {
    expect(talk).toContain("<EntryEditor");
    expect(history).toContain("<EntryEditor");
  });
});
