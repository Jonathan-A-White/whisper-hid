import { describe, expect, it, vi } from "vitest";
import {
  chunkText,
  countReports,
  decodeTextFile,
  estimateSeconds,
  formatDuration,
  initialRate,
  measuredRate,
  typeFile,
  waitForIdle,
  type TypeFileDeps,
  type TypeFileProgress,
} from "./typeFile";

const enc = (s: string) => new TextEncoder().encode(s);

describe("decodeTextFile", () => {
  it("returns UTF-8 text as it is, line endings and all", () => {
    const text = "héllo\r\nwörld ✓ 🙂\n\ttabbed\n";
    expect(decodeTextFile(enc(text))).toEqual({ ok: true, text });
  });

  it("keeps a leading byte order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(decodeTextFile(bytes)).toEqual({ ok: true, text: "﻿hi" });
  });

  it("accepts an empty file as empty text", () => {
    expect(decodeTextFile(new Uint8Array())).toEqual({ ok: true, text: "" });
  });

  it("refuses bytes that are not valid UTF-8", () => {
    expect(decodeTextFile(new Uint8Array([0x68, 0xff, 0xfe, 0x69]))).toEqual({
      ok: false,
    });
    // a PNG header
    expect(
      decodeTextFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ).toEqual({ ok: false });
  });

  it("refuses a file with NUL bytes even though NUL is valid UTF-8", () => {
    expect(decodeTextFile(new Uint8Array([0x61, 0x00, 0x62]))).toEqual({
      ok: false,
    });
  });
});

describe("chunkText", () => {
  it("gives no chunks for no text and one chunk for short text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("short", 10)).toEqual(["short"]);
  });

  it("keeps order, loses nothing and repeats nothing", () => {
    const text = Array.from({ length: 1234 }, (_, i) => String.fromCharCode(33 + (i % 90))).join("");
    const chunks = chunkText(text, 100);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBe(13);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it("never splits a character that takes two UTF-16 units", () => {
    // 🙂 is a surrogate pair; a cut at 3 units would land inside the second
    const text = "ab🙂🙂🙂🙂cd🙂";
    for (let max = 2; max <= 6; max++) {
      const chunks = chunkText(text, max);
      expect(chunks.join("")).toBe(text);
      for (const c of chunks) {
        const first = c.charCodeAt(0);
        const last = c.charCodeAt(c.length - 1);
        expect(first >= 0xdc00 && first <= 0xdfff, `lone low surrogate starts ${JSON.stringify(c)}`).toBe(false);
        expect(last >= 0xd800 && last <= 0xdbff, `lone high surrogate ends ${JSON.stringify(c)}`).toBe(false);
      }
    }
  });

  it("round-trips multi-byte text through UTF-8 chunk by chunk", () => {
    const text = "日本語のテキスト, ünïcödé ✓ 🙂 مرحبا\n".repeat(20);
    const chunks = chunkText(text, 7);
    const bytes = chunks.flatMap((c) => Array.from(enc(c)));
    expect(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes))).toBe(text);
    // every chunk is itself valid text (no half characters)
    for (const c of chunks) expect(c).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("keeps a CRLF pair together", () => {
    const chunks = chunkText("abc\r\ndef\r\nghi", 4);
    expect(chunks.join("")).toBe("abc\r\ndef\r\nghi");
    for (const c of chunks) {
      expect(c.endsWith("\r") && !c.endsWith("\r\n")).toBe(false);
    }
  });
});

describe("estimate", () => {
  it("counts two reports for a plain character and three for a shifted one", () => {
    expect(countReports("abc")).toBe(6);
    expect(countReports("A")).toBe(3);
    expect(countReports("a?")).toBe(5);
    expect(countReports("")).toBe(0);
  });

  it("starts from the keystroke delay: one report takes delay + 1 ms", () => {
    expect(initialRate(10)).toEqual({ msPerReport: 11 });
    // 100 plain characters = 200 reports at 11 ms = 2.2 s
    expect(estimateSeconds("a".repeat(100), initialRate(10))).toBeCloseTo(2.2, 5);
  });

  it("uses the measured pace once there is one", () => {
    // 400 reports took 6000 ms
    expect(measuredRate(400, 6000)).toEqual({ msPerReport: 15 });
    expect(estimateSeconds("a".repeat(100), { msPerReport: 15 })).toBeCloseTo(3, 5);
    expect(measuredRate(0, 100)).toBeNull();
    expect(measuredRate(100, 0)).toBeNull();
  });

  it("formats a duration plainly", () => {
    expect(formatDuration(0.2)).toBe("under a second");
    expect(formatDuration(12.4)).toBe("12 s");
    expect(formatDuration(59.6)).toBe("1 min");
    expect(formatDuration(200)).toBe("3 min 20 s");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(3725)).toBe("1 h 2 min");
  });
});

function makeDeps(text: string, over: Partial<TypeFileDeps> = {}) {
  let clock = 0;
  const sent: string[] = [];
  const progress: TypeFileProgress[] = [];
  const deps: TypeFileDeps = {
    text,
    chunkChars: 10,
    delayMs: 10,
    sendChunk: vi.fn(async (c: string) => {
      sent.push(c);
    }),
    // each report takes 20 ms on the pretend link
    waitTyped: vi.fn(async (c: string) => {
      clock += countReports(c) * 20;
    }),
    now: () => clock,
    isCancelled: () => false,
    onProgress: (p) => progress.push(p),
    ...over,
  };
  return { deps, sent, progress };
}

describe("typeFile", () => {
  it("types every chunk once, in order, and finishes", async () => {
    const text = "The quick brown fox jumps over the lazy dog. 🙂 ünï\n".repeat(3);
    const { deps, sent } = makeDeps(text);
    const result = await typeFile(deps);
    expect(result).toEqual({ status: "done" });
    expect(sent.join("")).toBe(text);
    expect(sent).toEqual(chunkText(text, 10));
  });

  it("does not send the next chunk until the last one was typed", async () => {
    const order: string[] = [];
    const { deps } = makeDeps("aaaaaaaaaabbbbbbbbbb", {
      sendChunk: async (c) => void order.push(`send ${c[0]}`),
      waitTyped: async (c) => void order.push(`typed ${c[0]}`),
    });
    await typeFile(deps);
    expect(order).toEqual(["send a", "typed a", "send b", "typed b"]);
  });

  it("reports progress after each chunk, with the time left", async () => {
    const { deps, progress } = makeDeps("a".repeat(30));
    await typeFile(deps);
    expect(progress[0]).toMatchObject({ typedChars: 0, totalChars: 30 });
    // before any typing: from delay 10 ms -> 11 ms/report, 60 reports
    expect(progress[0].remainingSeconds).toBeCloseTo(0.66, 5);
    const last = progress[progress.length - 1];
    expect(last).toMatchObject({ typedChars: 30, totalChars: 30, remainingSeconds: 0 });
    expect(progress.map((p) => p.typedChars)).toEqual([0, 10, 20, 30]);
  });

  it("re-estimates from the measured pace, ignoring the first chunk's warm-up", async () => {
    // first chunk is slow (link warming up), the rest run at 20 ms/report
    let clock = 0;
    let n = 0;
    const { deps, progress } = makeDeps("a".repeat(40), {
      now: () => clock,
      waitTyped: async (c) => {
        clock += n++ === 0 ? 5000 : countReports(c) * 20;
      },
    });
    await typeFile(deps);
    // after chunk 2 (20 reports in 400 ms): 40 reports left * 20 ms = 0.8 s
    expect(progress[2].typedChars).toBe(20);
    expect(progress[2].remainingSeconds).toBeCloseTo(0.8, 5);
  });

  it("stops between chunks when cancelled", async () => {
    let cancelled = false;
    const { deps, sent } = makeDeps("a".repeat(50), {
      onProgress: (p) => {
        if (p.typedChars === 20) cancelled = true;
      },
      isCancelled: () => cancelled,
    });
    const result = await typeFile(deps);
    expect(result).toEqual({ status: "cancelled", typedChars: 20 });
    expect(sent.join("")).toBe("a".repeat(20));
  });

  it("does not send anything when cancelled before the first chunk", async () => {
    const { deps, sent } = makeDeps("hello", { isCancelled: () => true });
    expect(await typeFile(deps)).toEqual({ status: "cancelled", typedChars: 0 });
    expect(sent).toEqual([]);
  });

  it("stops and says how far it got when a chunk fails", async () => {
    let calls = 0;
    const { deps } = makeDeps("a".repeat(50), {
      sendChunk: async () => {
        if (++calls === 3) throw new Error("boom");
      },
    });
    expect(await typeFile(deps)).toEqual({
      status: "failed",
      typedChars: 20,
      error: "boom",
    });
  });
});

describe("waitForIdle", () => {
  function clockDeps(readings: Array<boolean | undefined>, over = {}) {
    let clock = 0;
    let i = 0;
    return {
      readTyping: vi.fn(async () => readings[Math.min(i++, readings.length - 1)]),
      sleep: async (ms: number) => void (clock += ms),
      now: () => clock,
      expectedMs: 1000,
      ...over,
    };
  }

  it("waits for typing to start and then stop", async () => {
    const deps = clockDeps([false, true, true, false]);
    await waitForIdle(deps);
    // false at first is the request not yet picked up, not done
    expect(deps.readTyping).toHaveBeenCalledTimes(4);
  });

  it("gives up waiting for a chunk it never saw typing after the grace period", async () => {
    const deps = clockDeps([false]);
    await waitForIdle(deps);
    expect(deps.now()).toBe(1500);
  });

  it("waits the expected time on a service that does not report typing", async () => {
    const deps = clockDeps([undefined], { expectedMs: 800 });
    await waitForIdle(deps);
    expect(deps.now()).toBe(800);
  });
});
