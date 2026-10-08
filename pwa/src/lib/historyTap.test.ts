import { describe, expect, it, vi } from "vitest";
import { tapHistoryEntry } from "./historyTap";

function setup() {
  const calls: string[] = [];
  const hid = {
    sendText: vi.fn(async () => {
      calls.push("type");
      return true;
    }),
  };
  const writeText = vi.fn(async () => {
    calls.push("copy");
  });
  return { calls, hid, writeText };
}

describe("tapHistoryEntry", () => {
  it("computer mode: copies, then types the entry's text", async () => {
    const { calls, hid, writeText } = setup();
    const result = await tapHistoryEntry("hello there", {
      sendTo: "computer",
      hid,
      clipboard: { writeText },
    });
    expect(writeText).toHaveBeenCalledWith("hello there");
    expect(hid.sendText).toHaveBeenCalledWith("hello there");
    expect(calls).toEqual(["copy", "type"]);
    expect(result).toEqual({ copied: true });
  });

  it("an unset sendTo counts as computer mode", async () => {
    const { hid, writeText } = setup();
    await tapHistoryEntry("x", { sendTo: undefined, hid, clipboard: { writeText } });
    expect(hid.sendText).toHaveBeenCalledWith("x");
  });

  it("phone mode: copies and types nothing", async () => {
    const { hid, writeText } = setup();
    const result = await tapHistoryEntry("hello there", {
      sendTo: "phone",
      hid,
      clipboard: { writeText },
    });
    expect(writeText).toHaveBeenCalledWith("hello there");
    expect(hid.sendText).not.toHaveBeenCalled();
    expect(result).toEqual({ copied: true });
  });

  it("computer mode: a throwing clipboard still types, and reports not copied", async () => {
    const { hid } = setup();
    const writeText = vi.fn().mockRejectedValue(new Error("not focused"));
    const result = await tapHistoryEntry("hello there", {
      sendTo: "computer",
      hid,
      clipboard: { writeText },
    });
    expect(hid.sendText).toHaveBeenCalledWith("hello there");
    expect(result).toEqual({ copied: false });
  });

  it("phone mode: a refused copy reports not copied and types nothing", async () => {
    const { hid } = setup();
    const writeText = vi.fn().mockRejectedValue(new Error("no"));
    const result = await tapHistoryEntry("t", {
      sendTo: "phone",
      hid,
      clipboard: { writeText },
    });
    expect(hid.sendText).not.toHaveBeenCalled();
    expect(result).toEqual({ copied: false });
  });

  it("computer mode with no clipboard API still types", async () => {
    const { hid } = setup();
    const result = await tapHistoryEntry("t", {
      sendTo: "computer",
      hid,
      clipboard: undefined,
    });
    expect(hid.sendText).toHaveBeenCalledWith("t");
    expect(result).toEqual({ copied: false });
  });
});
