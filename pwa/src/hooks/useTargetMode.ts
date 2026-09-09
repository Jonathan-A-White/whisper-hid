import { useCallback, useEffect, useState } from "react";
import { getTarget, putTarget } from "../lib/api";
import type {
  NewlineMode,
  Settings,
  TargetInfo,
  TargetMode,
  TargetState,
} from "../types";

/**
 * The target app mode — which app the keystrokes are going to (Claude Code,
 * Codex, or a plain text field).
 *
 * It lives on the Whisper server (PUT /target) rather than in PWA settings:
 * the server needs it too, to name the right assistant in the "prompt"
 * cleanup style and to seed the glossary, and keeping one copy avoids the
 * two drifting apart. `newlineMode` is the server's mapping from target to
 * keystrokes, which every /type call carries to the HID service, and
 * `submitNewlineMode` is the same for the deliberate Enter that submits.
 *
 * A server older than 1.9.0 has no /target: `available` stays false, the
 * pill hides, and sends fall back to a plain Enter. One older than 1.9.1
 * has no submit mode, which is also a plain Enter.
 */
export function useTargetMode(
  settings: Settings,
  updateSettings: (partial: Partial<Settings>) => void
) {
  const [target, setTargetState] = useState<TargetMode | null>(null);
  const [targets, setTargets] = useState<TargetInfo[]>([]);
  const [newlineMode, setNewlineMode] = useState<NewlineMode>("enter");
  const [submitNewlineMode, setSubmitNewlineMode] = useState<NewlineMode>("enter");

  const apply = useCallback((state: TargetState) => {
    setTargetState(state.target);
    setNewlineMode(state.newline_mode);
    setSubmitNewlineMode(state.submit_newline_mode ?? "enter");
    setTargets(state.targets);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getTarget()
      .then(async (state) => {
        if (cancelled) return;
        // One-time migration: a phone that had the old "Claude Code
        // newlines (clipboard)" checkbox on was already dictating at Claude
        // Code, so adopt that as its target instead of silently reverting
        // to plain Enter. Runs once, even if the user later picks another
        // target.
        if (settings.claudeCodeNewlines && !settings.targetMigrated) {
          updateSettings({ targetMigrated: true, claudeCodeNewlines: undefined });
          if (state.target === "plain") {
            try {
              const migrated = await putTarget("claude");
              if (!cancelled) apply(migrated);
              return;
            } catch {
              // fall through to whatever the server reported
            }
          }
        }
        apply(state);
      })
      .catch(() => {
        if (!cancelled) setTargetState(null);
      });
    return () => {
      cancelled = true;
    };
    // Runs once on mount; the migration inputs are read from the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTarget = useCallback(
    async (next: TargetMode) => {
      const previous = target;
      const previousNewline = newlineMode;
      const previousSubmit = submitNewlineMode;
      // Optimistic so the pill responds instantly; reverted on failure.
      const info = targets.find((t) => t.name === next);
      setTargetState(next);
      setNewlineMode(info?.newline_mode ?? previousNewline);
      setSubmitNewlineMode(info?.submit_newline_mode ?? "enter");
      try {
        apply(await putTarget(next));
      } catch {
        setTargetState(previous);
        setNewlineMode(previousNewline);
        setSubmitNewlineMode(previousSubmit);
      }
    },
    [target, newlineMode, submitNewlineMode, targets, apply]
  );

  return {
    /** null while loading, or when the server is too old to have /target */
    target,
    targets,
    newlineMode,
    /** how the deliberate "submit" newline is typed for this target */
    submitNewlineMode,
    available: target !== null,
    setTarget,
  };
}
