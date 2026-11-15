// How long the phone's Bluetooth link has probably been down, worked out from
// the reconnect attempt number, for an older APK that does not report the
// seconds down itself (reconnect_down_seconds). Mirrors the schedule in app/.../ReconnectPolicy.kt: 2, 4, 8, 16, 30 s for the
// first five attempts, 30 s until five minutes have passed, then 60 s. Keep the
// two in step; an estimate is enough here, the banner only needs "a long time".

const EARLY_DELAYS_S = [2, 4, 8, 16, 30];
const SLOW_AFTER_S = 5 * 60;
const STEADY_DELAY_S = 30;
const SLOW_DELAY_S = 60;

/** After this long down, the banner also points at the computer. */
export const CHECK_COMPUTER_AFTER_S = 10 * 60;

/** Seconds from the drop to the start of attempt [attempt] (1-based). */
export function estimatedDownSeconds(attempt: number): number {
  let elapsed = 0;
  for (let a = 1; a <= attempt; a++) {
    elapsed +=
      elapsed >= SLOW_AFTER_S
        ? SLOW_DELAY_S
        : a <= EARLY_DELAYS_S.length
          ? EARLY_DELAYS_S[a - 1]
          : STEADY_DELAY_S;
  }
  return elapsed;
}

/**
 * Whether the banner should point at the computer. The service reports the
 * seconds the link has been down (reconnect_down_seconds); an older APK does
 * not, so then the attempt number is turned into an estimate.
 */
export function downLongEnoughToCheckComputer(
  attempt: number | undefined,
  downSeconds?: number,
): boolean {
  if (downSeconds !== undefined) return downSeconds > CHECK_COMPUTER_AFTER_S;
  return attempt !== undefined && estimatedDownSeconds(attempt) > CHECK_COMPUTER_AFTER_S;
}
