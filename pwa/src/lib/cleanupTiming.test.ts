import { describe, expect, it } from "vitest";
import {
  averageTimings,
  buildTiming,
  formatAverages,
  timingLine,
} from "./cleanupTiming";
import history from "../components/HistoryView.tsx?raw";
import settings from "../components/CleanupSettings.tsx?raw";
import talk from "../components/TalkView.tsx?raw";
import whisperHook from "../hooks/useWhisper.ts?raw";

describe("buildTiming", () => {
  it("with Cleanup on records transcription, cleanup and the total", () => {
    expect(buildTiming(2100, 3400)).toEqual({
      whisperMs: 2100,
      cleanupMs: 3400,
      totalMs: 5500,
    });
  });
  it("with Cleanup off (no cleanup time) records nothing", () => {
    expect(buildTiming(2100, undefined)).toBeUndefined();
    expect(buildTiming(2100, null)).toBeUndefined();
  });
  it("records nothing when the transcription time is missing", () => {
    expect(buildTiming(undefined, 3400)).toBeUndefined();
  });
  it("keeps a cleanup that took 0 ms", () => {
    expect(buildTiming(1000, 0)?.totalMs).toBe(1000);
  });
});

describe("timingLine", () => {
  it("shows 'whisper X s + cleanup Y s' to one decimal", () => {
    expect(timingLine({ whisperMs: 2100, cleanupMs: 3400, totalMs: 5500 })).toBe(
      "whisper 2.1 s + cleanup 3.4 s",
    );
  });
  it("shows no line for an entry without a timing record", () => {
    expect(timingLine(undefined)).toBeNull();
  });
});

describe("averageTimings", () => {
  it("averages the recorded timings and skips entries without one", () => {
    const avg = averageTimings([
      { timing: { whisperMs: 2000, cleanupMs: 3000, totalMs: 5000 } },
      { timing: { whisperMs: 4000, cleanupMs: 5000, totalMs: 9000 } },
      {},
    ]);
    expect(avg).toEqual({ count: 2, whisperMs: 3000, cleanupMs: 4000, totalMs: 7000 });
  });
  it("is null when there are none", () => {
    expect(averageTimings([])).toBeNull();
    expect(averageTimings([{}, {}])).toBeNull();
  });
});

describe("formatAverages", () => {
  it("reads as whisper, cleanup and total averages over N dictations", () => {
    const text = formatAverages({ count: 2, whisperMs: 3000, cleanupMs: 4000, totalMs: 7000 });
    expect(text).toBe("Average of 2 dictations: whisper 3.0 s + cleanup 4.0 s = 7.0 s");
  });
  it("uses the singular for one dictation", () => {
    expect(
      formatAverages({ count: 1, whisperMs: 2100, cleanupMs: 3400, totalMs: 5500 }),
    ).toContain("1 dictation:");
  });
});

describe("where it is shown", () => {
  it("History prints the line from the entry's timing, grey and small", () => {
    expect(history).toContain("timingLine(entry.timing)");
    expect(history).toContain("text-gray-500");
  });
  it("Settings shows the averages under the cleanup model row, hidden when none", () => {
    expect(settings).toContain("averageTimings(");
    expect(settings).toContain("formatAverages(");
    expect(settings).toMatch(/averages\s*&&/);
  });
  it("the dictation's timing comes from the server's cleanup_ms and reaches the entry", () => {
    expect(whisperHook).toContain("buildTiming(result.duration_ms, result.cleanup_ms)");
    expect(talk).toContain("timing: stats.timing");
  });
});
