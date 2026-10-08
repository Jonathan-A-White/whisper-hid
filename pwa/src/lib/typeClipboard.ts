import type { Settings, TargetMode } from "../types";
import { clipboardTextToType } from "./clipboard";

export interface TypeClipboardDeps {
  readText: () => Promise<string>;
  /** null on a server too old to have /target */
  target: TargetMode | null;
  settings: Pick<Settings, "appendNewline" | "newlineAfterEnd">;
  addEntry: (text: string) => Promise<unknown>;
  sendText: (text: string) => Promise<boolean>;
  sendNewline: () => Promise<void>;
}

/** "blocked": the browser refused to read the clipboard; nothing was typed. */
export type TypeClipboardResult =
  | { status: "typed" }
  | { status: "empty" }
  | { status: "blocked" };

/**
 * Type the phone clipboard on the connected host — lets text composed in
 * another app (e.g. a prompt drafted in Claude) be delivered through the
 * same HID path as dictation, without riding on a dummy recording.
 */
export async function typeClipboard(
  deps: TypeClipboardDeps
): Promise<TypeClipboardResult> {
  let text: string;
  try {
    text = await deps.readText();
  } catch {
    return { status: "blocked" };
  }
  if (!text.trim()) return { status: "empty" };
  // Line breaks survive in every target but plain text (see
  // clipboardTextToType); "Newline after end of recording" alone decides
  // the final, deliberate Enter.
  text = clipboardTextToType(text, deps.target, deps.settings);
  await deps.addEntry(text);
  await deps.sendText(text);
  if (deps.settings.newlineAfterEnd) await deps.sendNewline();
  return { status: "typed" };
}
