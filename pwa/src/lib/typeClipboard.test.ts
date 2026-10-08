import { describe, expect, it, vi } from "vitest";
import { typeClipboard } from "./typeClipboard";

function deps(over: Partial<Parameters<typeof typeClipboard>[0]> = {}) {
  return {
    readText: vi.fn(async () => "hello\nworld"),
    target: "claude" as const,
    settings: { appendNewline: false, newlineAfterEnd: false },
    addEntry: vi.fn(async () => undefined),
    sendText: vi.fn(async () => true),
    sendNewline: vi.fn(async () => undefined),
    ...over,
  };
}

describe("typeClipboard", () => {
  it("records the clipboard in History and types it", async () => {
    const d = deps();
    expect(await typeClipboard(d)).toEqual({ status: "typed" });
    expect(d.addEntry).toHaveBeenCalledWith("hello\nworld");
    expect(d.sendText).toHaveBeenCalledWith("hello\nworld");
    expect(d.sendNewline).not.toHaveBeenCalled();
  });

  it("flattens for a plain target", async () => {
    const d = deps({ target: "plain" });
    await typeClipboard(d);
    expect(d.sendText).toHaveBeenCalledWith("hello world");
  });

  it("sends the final Enter when newline after end is on", async () => {
    const d = deps({ settings: { appendNewline: false, newlineAfterEnd: true } });
    await typeClipboard(d);
    expect(d.sendNewline).toHaveBeenCalledTimes(1);
  });

  it("reports an empty clipboard and types nothing", async () => {
    const d = deps({ readText: vi.fn(async () => "  \n ") });
    expect(await typeClipboard(d)).toEqual({ status: "empty" });
    expect(d.sendText).not.toHaveBeenCalled();
    expect(d.addEntry).not.toHaveBeenCalled();
  });

  it("reports a blocked clipboard read", async () => {
    const d = deps({
      readText: vi.fn(async () => {
        throw new Error("denied");
      }),
    });
    expect(await typeClipboard(d)).toEqual({ status: "blocked" });
    expect(d.sendText).not.toHaveBeenCalled();
  });
});
