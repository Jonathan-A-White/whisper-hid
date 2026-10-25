import { chipClass } from "../lib/chip";
import { nextTarget } from "../lib/targetCycle";
import type { TargetInfo, TargetMode } from "../types";

interface TargetModeToggleProps {
  target: TargetMode | null;
  targets: TargetInfo[];
  /** Why /target could not be read; shown instead of hiding the chip. */
  error?: string | null;
  /** Tapping the "Target unknown" chip asks again. */
  onRetry?: () => void;
  onSelect: (target: TargetMode) => void;
}

const ICONS: Record<TargetMode, string> = {
  plain: "📝",
  chat: "💬",
  claude: "🤖",
  codex: "🧠",
  terminal: "🖥️",
};

/**
 * Target app pill for the Talk screen: which app is receiving the
 * keystrokes. It decides how line breaks are typed (Claude Code's "\" +
 * Enter, Codex's Ctrl+J, a web chat box's Shift+Enter, or a real Enter, which a shell target also
 * keeps for every pasted line) and which assistant the "prompt"
 * cleanup style writes for — a wrong setting either submits the prompt
 * halfway through or litters it with stray backslashes, so it sits next to
 * the other per-dictation toggles rather than in Settings.
 *
 * Tapping cycles through the modes the server offers. When /target cannot
 * be read (server unreachable, too old, a bad reply) the chip says so:
 * "Target unknown: <reason>", and a tap tries again. It is hidden only
 * while the first answer is still on its way.
 */
export function TargetModeToggle({
  target,
  targets,
  error,
  onRetry,
  onSelect,
}: TargetModeToggleProps) {
  if (!target || targets.length === 0) {
    if (!error) return null;
    return (
      <button
        onClick={onRetry}
        title="Tap to try again"
        className={`${chipClass("amber")} min-w-0 col-span-2`}
      >
        ⚠️ Target unknown: {error}
      </button>
    );
  }

  const active = targets.find((t) => t.name === target) ?? targets[0];
  const next = nextTarget(targets, target);

  return (
    <button
      onClick={() => onSelect(next.name)}
      title={active.description}
      className={chipClass(target === "plain" ? undefined : "blue")}
    >
      {ICONS[active.name] ?? "⌨️"} Typing to {active.label}
    </button>
  );
}
