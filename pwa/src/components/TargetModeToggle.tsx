import type { TargetInfo, TargetMode } from "../types";

interface TargetModeToggleProps {
  target: TargetMode | null;
  targets: TargetInfo[];
  onSelect: (target: TargetMode) => void;
}

const ICONS: Record<TargetMode, string> = {
  plain: "📝",
  claude: "🤖",
  codex: "🧠",
};

/**
 * Target app pill for the Talk screen: which app is receiving the
 * keystrokes. It decides how line breaks are typed (Claude Code's "\" +
 * Enter, Codex's Ctrl+J, or a real Enter) and which assistant the "prompt"
 * cleanup style writes for — a wrong setting either submits the prompt
 * halfway through or litters it with stray backslashes, so it sits next to
 * the other per-dictation toggles rather than in Settings.
 *
 * Tapping cycles through the modes the server offers. Hidden when the
 * Whisper server is unreachable or too old to know about targets.
 */
export function TargetModeToggle({
  target,
  targets,
  onSelect,
}: TargetModeToggleProps) {
  if (!target || targets.length === 0) return null;

  const index = targets.findIndex((t) => t.name === target);
  const active = targets[index] ?? targets[0];
  const next = targets[(Math.max(index, 0) + 1) % targets.length];

  return (
    <button
      onClick={() => onSelect(next.name)}
      title={active.description}
      className={`mt-2 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
        target === "plain"
          ? "bg-gray-800 text-gray-500 hover:bg-gray-700"
          : "bg-sky-600 text-white"
      }`}
    >
      {ICONS[active.name] ?? "⌨️"} Typing to {active.label}
    </button>
  );
}
