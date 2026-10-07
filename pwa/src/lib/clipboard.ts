import type { Settings, TargetMode } from "../types";

/**
 * The text "Type clipboard" sends for what is on the phone clipboard.
 *
 * In a CLI or shell target the line breaks survive: the HID service types
 * each one as that app's newline key (Claude's "\" + Enter, Codex's Ctrl+J,
 * a shell's real Enter), so a pasted script keeps its lines. With a plain
 * text target a "\n" would be a real Enter that submits mid-paste, so the
 * clipboard is flattened to one line unless the user has opted into newline
 * separators ("Add newline after each segment"). The decision is keyed on the
 * target, not on its newline mode: terminal types real Enters too, and must
 * never flatten.
 *
 * `target` is null when the server is too old to have /target, which types a
 * plain Enter and so is treated as plain.
 */
export function clipboardTextToType(
  clipboard: string,
  target: TargetMode | null,
  settings: Pick<Settings, "appendNewline">
): string {
  const text = clipboard.replace(/\r\n?/g, "\n").trim();
  const flatten = (target === null || target === "plain") && !settings.appendNewline;
  if (!flatten) return text;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}
