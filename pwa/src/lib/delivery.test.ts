import { describe, expect, it, vi } from "vitest";
import {
  canShare,
  copyToClipboard,
  deliver,
  deliveryFor,
  shareText,
} from "./delivery";

function makeHid() {
  return {
    sendText: vi.fn().mockResolvedValue(true),
    sendNewline: vi.fn().mockResolvedValue(undefined),
  };
}

describe("deliveryFor", () => {
  it("defaults to the computer when the setting is absent", () => {
    expect(deliveryFor(undefined)).toBe("hid");
  });
  it("sends to HID for computer and to the phone for phone", () => {
    expect(deliveryFor("computer")).toBe("hid");
    expect(deliveryFor("phone")).toBe("phone");
  });
});

describe("deliver", () => {
  it("phone mode: no HID send, copied at once with no tap", async () => {
    const hid = makeHid();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const result = await deliver("test one two", {
      sendTo: "phone",
      newlineAfterEnd: true,
      hid,
      clipboard: { writeText },
    });
    expect(hid.sendText).not.toHaveBeenCalled();
    expect(hid.sendNewline).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("test one two");
    expect(result).toEqual({ via: "phone", copied: true });
  });

  it("phone mode: a rejected writeText does not throw and reports not copied", async () => {
    const hid = makeHid();
    const writeText = vi.fn().mockRejectedValue(new Error("not focused"));
    const result = await deliver("hello", {
      sendTo: "phone",
      hid,
      clipboard: { writeText },
    });
    expect(result).toEqual({ via: "phone", copied: false });
    expect(hid.sendText).not.toHaveBeenCalled();
  });

  it("phone mode: no clipboard API at all reports not copied", async () => {
    const hid = makeHid();
    const result = await deliver("hello", {
      sendTo: "phone",
      hid,
      clipboard: undefined,
    });
    expect(result).toEqual({ via: "phone", copied: false });
  });

  it("computer mode: copies the text, then sends over HID as before, plus the newline when asked", async () => {
    const order: string[] = [];
    const hid = makeHid();
    hid.sendText.mockImplementation(async () => {
      order.push("type");
      return true;
    });
    const writeText = vi.fn().mockImplementation(async () => {
      order.push("copy");
    });
    const result = await deliver("hello", {
      sendTo: "computer",
      newlineAfterEnd: true,
      hid,
      clipboard: { writeText },
    });
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(hid.sendText).toHaveBeenCalledWith("hello");
    expect(hid.sendNewline).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["copy", "type"]);
    expect(result).toEqual({ via: "hid", copied: true });
  });

  it("computer mode: a clipboard that throws still types and reports not copied", async () => {
    const hid = makeHid();
    const writeText = vi.fn().mockRejectedValue(new Error("not focused"));
    const result = await deliver("hello", {
      sendTo: "computer",
      hid,
      clipboard: { writeText },
    });
    expect(hid.sendText).toHaveBeenCalledWith("hello");
    expect(result).toEqual({ via: "hid", copied: false });
  });

  it("computer mode: no clipboard API still types and reports not copied", async () => {
    const hid = makeHid();
    const result = await deliver("hello", { hid, clipboard: undefined });
    expect(hid.sendText).toHaveBeenCalledWith("hello");
    expect(result).toEqual({ via: "hid", copied: false });
  });

  it("the default (no sendTo) is the computer, no newline unless asked", async () => {
    const hid = makeHid();
    await deliver("hello", { hid, clipboard: { writeText: vi.fn() } });
    expect(hid.sendText).toHaveBeenCalledWith("hello");
    expect(hid.sendNewline).not.toHaveBeenCalled();
  });
});

describe("copyToClipboard / shareText / canShare", () => {
  it("copyToClipboard resolves true on success, false on rejection", async () => {
    expect(await copyToClipboard("x", { writeText: vi.fn().mockResolvedValue(undefined) })).toBe(true);
    expect(await copyToClipboard("x", { writeText: vi.fn().mockRejectedValue(new Error("no")) })).toBe(false);
  });

  it("canShare is true only when navigator.share exists", () => {
    expect(canShare({ share: vi.fn() })).toBe(true);
    expect(canShare({})).toBe(false);
    expect(canShare(undefined)).toBe(false);
  });

  it("shareText calls navigator.share with the text and swallows a cancel", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    expect(await shareText("hi", { share })).toBe(true);
    expect(share).toHaveBeenCalledWith({ text: "hi" });
    const cancelled = vi.fn().mockRejectedValue(new DOMException("x", "AbortError"));
    expect(await shareText("hi", { share: cancelled })).toBe(false);
    expect(await shareText("hi", {})).toBe(false);
  });
});
