import { describe, expect, it, vi } from "vitest";
import {
  copyEntry,
  deleteEntry,
  editEntry,
  sendEntry,
  sendDisabledFor,
} from "./historyActions";

describe("sendEntry", () => {
  it("computer mode types the entry's text over HID", async () => {
    const hid = { sendText: vi.fn(async () => true) };
    const result = await sendEntry("hello there", { sendTo: "computer", hid });
    expect(hid.sendText).toHaveBeenCalledWith("hello there");
    expect(result).toEqual({ sent: true });
  });
  it("an unset sendTo counts as computer mode", async () => {
    const hid = { sendText: vi.fn(async () => true) };
    await sendEntry("x", { sendTo: undefined, hid });
    expect(hid.sendText).toHaveBeenCalledWith("x");
  });
  it("reports not sent when HID refuses", async () => {
    const hid = { sendText: vi.fn(async () => false) };
    expect(await sendEntry("x", { sendTo: "computer", hid })).toEqual({ sent: false });
  });
  it("'This phone' mode types nothing", async () => {
    const hid = { sendText: vi.fn(async () => true) };
    const result = await sendEntry("x", { sendTo: "phone", hid });
    expect(hid.sendText).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: false });
  });
});

describe("sendDisabledFor", () => {
  it("Send is disabled only in 'This phone' mode", () => {
    expect(sendDisabledFor("phone")).toBe(true);
    expect(sendDisabledFor("computer")).toBe(false);
    expect(sendDisabledFor(undefined)).toBe(false);
  });
});

describe("copyEntry", () => {
  it("calls the clipboard with the entry's text", async () => {
    const writeText = vi.fn(async () => {});
    const result = await copyEntry("hello there", { writeText });
    expect(writeText).toHaveBeenCalledWith("hello there");
    expect(result).toEqual({ copied: true });
  });
  it("a throwing clipboard shows nothing (copied false, no throw)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("not focused"));
    expect(await copyEntry("t", { writeText })).toEqual({ copied: false });
  });
  it("no clipboard API shows nothing", async () => {
    expect(await copyEntry("t", undefined)).toEqual({ copied: false });
  });
});

describe("editEntry", () => {
  it("opens the editor for that entry, filled with its text", () => {
    expect(editEntry({ id: "a", text: "hello" })).toEqual({
      editingId: "a",
      editText: "hello",
    });
  });
});

describe("deleteEntry", () => {
  it("removes that entry through the store", async () => {
    const store = { deleteEntry: vi.fn(async () => {}) };
    await deleteEntry("a", store);
    expect(store.deleteEntry).toHaveBeenCalledWith("a");
  });
});
