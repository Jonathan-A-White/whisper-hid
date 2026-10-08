import type { SendTo } from "../types";
import { copyToClipboard, deliveryFor, type ClipboardLike } from "./delivery";

/**
 * What the entry options menu's Send, Copy, Edit and Delete do. Pure logic,
 * shared by History and the Talk screen's last transcript.
 */

/** Send types over the Bluetooth keyboard, so it has nothing to do while
 *  "This phone" is on. */
export function sendDisabledFor(sendTo: SendTo | undefined): boolean {
  return deliveryFor(sendTo) === "phone";
}

export interface SendEntryOptions {
  sendTo?: SendTo;
  hid: { sendText: (text: string) => Promise<boolean> };
}

/** Type the entry's text over HID. In "This phone" mode nothing is typed. */
export async function sendEntry(
  text: string,
  { sendTo, hid }: SendEntryOptions
): Promise<{ sent: boolean }> {
  if (sendDisabledFor(sendTo)) return { sent: false };
  return { sent: await hid.sendText(text) };
}

/** Copy the entry's text. Never throws; a refused copy is `copied: false`. */
export async function copyEntry(
  text: string,
  clipboard: ClipboardLike | undefined
): Promise<{ copied: boolean }> {
  return { copied: await copyToClipboard(text, clipboard) };
}

/** What Edit opens: the inline editor for this entry, holding its text. */
export function editEntry(entry: { id: string; text: string }): {
  editingId: string;
  editText: string;
} {
  return { editingId: entry.id, editText: entry.text };
}

/** Remove the entry. */
export async function deleteEntry(
  id: string,
  store: { deleteEntry: (id: string) => Promise<void> }
): Promise<void> {
  await store.deleteEntry(id);
}
