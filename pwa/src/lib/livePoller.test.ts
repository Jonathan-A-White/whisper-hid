import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORMAT_NOTE,
  LISTENING,
  POLL_MS,
  liveBoxView,
  startLivePoller,
  viewFromLive,
  type LiveReply,
  type LiveView,
} from "./livePoller";

function reply(over: Partial<LiveReply> = {}): LiveReply {
  return {
    recording: true,
    chunked: true,
    text: "",
    tail: "",
    seq: 0,
    ...over,
  };
}

/** A fetch whose answers the test settles by hand, so it can count requests. */
function manualFetch() {
  const pending: Array<{
    resolve: (r: LiveReply | null) => void;
    reject: (e: unknown) => void;
  }> = [];
  const fetchLive = vi.fn(
    () =>
      new Promise<LiveReply | null>((resolve, reject) => {
        pending.push({ resolve, reject });
      })
  );
  return { fetchLive, pending };
}

/** Let promise callbacks run without moving the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("viewFromLive", () => {
  it("shows Listening… before any words", () => {
    expect(viewFromLive(reply())).toEqual(LISTENING);
  });
  it("shows the committed text and the tentative tail separately", () => {
    expect(viewFromLive(reply({ text: "hello", tail: "wor", seq: 2 }))).toEqual({
      kind: "words",
      text: "hello",
      tail: "wor",
    });
  });
  it("explains itself when this phone's recording format cannot stream", () => {
    expect(viewFromLive(reply({ chunked: false }))).toEqual(FORMAT_NOTE);
  });
});

describe("startLivePoller", () => {
  it("renders text, then text and tail, as seq changes", async () => {
    const replies = [
      reply({ text: "hello", seq: 1 }),
      reply({ text: "hello", tail: "wor", seq: 2 }),
    ];
    const fetchLive = vi.fn(async () => replies.shift() ?? null);
    const views: LiveView[] = [];
    startLivePoller({ fetchLive, onView: (v) => views.push(v) });
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(views).toEqual([
      { kind: "words", text: "hello", tail: "" },
      { kind: "words", text: "hello", tail: "wor" },
    ]);
  });

  it("skips a reply whose seq has not changed", async () => {
    const fetchLive = vi.fn(async () => reply({ text: "same", seq: 5 }));
    const views: LiveView[] = [];
    startLivePoller({ fetchLive, onView: (v) => views.push(v) });
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetchLive.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(views).toHaveLength(1);
  });

  it("polls about every 700 ms", async () => {
    expect(POLL_MS).toBe(700);
    const fetchLive = vi.fn(async () => reply());
    startLivePoller({ fetchLive, onView: () => {} });
    await flush();
    expect(fetchLive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(fetchLive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchLive).toHaveBeenCalledTimes(2);
  });

  it("never has more than one request in flight", async () => {
    const { fetchLive, pending } = manualFetch();
    startLivePoller({ fetchLive, onView: () => {} });
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(fetchLive).toHaveBeenCalledTimes(1);
    pending[0].resolve(reply({ seq: 1, text: "a" }));
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchLive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(fetchLive).toHaveBeenCalledTimes(2);
  });

  it("stops on stop, and ignores a reply that lands afterwards", async () => {
    const { fetchLive, pending } = manualFetch();
    const views: LiveView[] = [];
    const poller = startLivePoller({ fetchLive, onView: (v) => views.push(v) });
    await flush();
    poller.stop();
    pending[0].resolve(reply({ seq: 1, text: "late" }));
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(views).toEqual([]);
    expect(fetchLive).toHaveBeenCalledTimes(1);
  });

  it("stops after 3 errors in a row", async () => {
    const fetchLive = vi.fn(async () => {
      throw new TypeError("network");
    });
    const onView = vi.fn();
    startLivePoller({ fetchLive, onView });
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(fetchLive).toHaveBeenCalledTimes(3);
    expect(onView).not.toHaveBeenCalled();
  });

  it("keeps going when errors are not 3 in a row", async () => {
    const script: Array<LiveReply | Error> = [
      new Error("x"),
      new Error("x"),
      reply({ seq: 1, text: "ok" }),
      new Error("x"),
      new Error("x"),
      reply({ seq: 2, text: "ok again" }),
    ];
    const fetchLive = vi.fn(async () => {
      const next = script.shift();
      if (next === undefined || next instanceof Error) throw next ?? new Error("end");
      return next;
    });
    const views: LiveView[] = [];
    startLivePoller({ fetchLive, onView: (v) => views.push(v) });
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(views.map((v) => (v.kind === "words" ? v.text : v.kind))).toEqual([
      "ok",
      "ok again",
    ]);
  });

  it("a 404 (older server) leaves Listening… and stops asking", async () => {
    const fetchLive = vi.fn(async () => null);
    const views: LiveView[] = [];
    startLivePoller({ fetchLive, onView: (v) => views.push(v) });
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(views).toEqual([LISTENING]);
    expect(fetchLive).toHaveBeenCalledTimes(1);
  });

  it("chunked:false shows the format note", async () => {
    const fetchLive = vi.fn(async () => reply({ chunked: false }));
    const views: LiveView[] = [];
    startLivePoller({ fetchLive, onView: (v) => views.push(v) });
    await flush();
    expect(views).toEqual([FORMAT_NOTE]);
    expect(FORMAT_NOTE).toEqual({ kind: "note", text: expect.any(String) });
    expect(FORMAT_NOTE.kind === "note" && FORMAT_NOTE.text).toBe(
      "Listening… (this phone's recording format cannot show words until you stop)"
    );
  });
});

describe("liveBoxView", () => {
  const words: LiveView = { kind: "words", text: "hello", tail: "wor" };
  it("shows the preview while recording", () => {
    expect(liveBoxView({ recording: true, preview: words, finalText: null })).toEqual(
      words
    );
  });
  it("shows Listening… while recording with no preview yet", () => {
    expect(liveBoxView({ recording: true, preview: null, finalText: null })).toEqual(
      LISTENING
    );
  });
  it("on stop, the final text replaces the preview", () => {
    expect(
      liveBoxView({ recording: false, preview: words, finalText: "Hello world." })
    ).toEqual({ kind: "final", text: "Hello world." });
  });
  it("shows nothing after a stop with no final text", () => {
    expect(
      liveBoxView({ recording: false, preview: words, finalText: null })
    ).toBeNull();
  });
});
