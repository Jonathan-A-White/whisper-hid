import type { CleanupTiming } from "../types";

/** The timing record for one dictation. Only a dictation that went through
 *  Cleanup has one: with Cleanup off the server sends no cleanup time and
 *  nothing is recorded. */
export function buildTiming(
  whisperMs: number | null | undefined,
  cleanupMs: number | null | undefined,
): CleanupTiming | undefined {
  if (whisperMs == null || cleanupMs == null) return undefined;
  return { whisperMs, cleanupMs, totalMs: whisperMs + cleanupMs };
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** The small grey line on a History entry, or null when it has no timing. */
export function timingLine(timing: CleanupTiming | undefined): string | null {
  if (!timing) return null;
  return `whisper ${seconds(timing.whisperMs)} s + cleanup ${seconds(timing.cleanupMs)} s`;
}

export interface TimingAverages {
  count: number;
  whisperMs: number;
  cleanupMs: number;
  totalMs: number;
}

/** Averages over the entries that have a timing record; null when none do. */
export function averageTimings(
  entries: { timing?: CleanupTiming }[],
): TimingAverages | null {
  const timings = entries.flatMap((e) => (e.timing ? [e.timing] : []));
  if (timings.length === 0) return null;
  const mean = (pick: (t: CleanupTiming) => number) =>
    timings.reduce((sum, t) => sum + pick(t), 0) / timings.length;
  return {
    count: timings.length,
    whisperMs: mean((t) => t.whisperMs),
    cleanupMs: mean((t) => t.cleanupMs),
    totalMs: mean((t) => t.totalMs),
  };
}

export function formatAverages(avg: TimingAverages): string {
  const n = `${avg.count} dictation${avg.count === 1 ? "" : "s"}`;
  return `Average of ${n}: whisper ${seconds(avg.whisperMs)} s + cleanup ${seconds(avg.cleanupMs)} s = ${seconds(avg.totalMs)} s`;
}
