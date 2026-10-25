import type { TargetInfo, TargetMode } from "../types";

/**
 * The target a tap on the Talk screen's target pill switches to: the next
 * one in the server's catalog order, wrapping round. An unknown current
 * target counts as the first, so the tap lands on the second.
 */
export function nextTarget(targets: TargetInfo[], current: TargetMode): TargetInfo {
  const index = targets.findIndex((t) => t.name === current);
  return targets[(Math.max(index, 0) + 1) % targets.length];
}
