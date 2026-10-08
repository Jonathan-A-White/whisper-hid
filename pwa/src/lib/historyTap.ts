import type { SendTo } from "../types";
import { copyToClipboard, deliveryFor, type ClipboardLike } from "./delivery";

export interface HistoryTapOptions {
  sendTo?: SendTo;
  hid: { sendText: (text: string) => Promise<boolean> };
  clipboard: ClipboardLike | undefined;
}

/**
 * A tap on a History entry's text. Copies it first (never throws; a refused
 * copy is just `copied: false`), then types it over HID as always, unless
 * "This phone" is on, when nothing is typed.
 */
export async function tapHistoryEntry(
  text: string,
  { sendTo, hid, clipboard }: HistoryTapOptions
): Promise<{ copied: boolean }> {
  const copied = await copyToClipboard(text, clipboard);
  if (deliveryFor(sendTo) !== "phone") await hid.sendText(text);
  return { copied };
}
