import type { SendTo } from "../types";

/** Where a finished dictation goes: the Bluetooth keyboard, or this phone. */
export type Delivery = "hid" | "phone";

/** The one place the "This phone" switch is read. */
export function deliveryFor(sendTo: SendTo | undefined): Delivery {
  return sendTo === "phone" ? "phone" : "hid";
}

export interface ClipboardLike {
  writeText: (text: string) => Promise<void>;
}

export interface ShareLike {
  share?: (data: { text: string }) => Promise<void>;
}

/** Copy to the clipboard. Never throws: false when it was refused (e.g. the
 *  page is not focused, so there is no permission) or there is no API. */
export async function copyToClipboard(
  text: string,
  clipboard: ClipboardLike | undefined
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether Web Share exists here; Share is hidden where it does not. */
export function canShare(nav: ShareLike | undefined): boolean {
  return typeof nav?.share === "function";
}

/** Open the share sheet. False when unavailable or the user cancelled. */
export async function shareText(
  text: string,
  nav: ShareLike | undefined
): Promise<boolean> {
  if (!nav || typeof nav.share !== "function") return false;
  try {
    await nav.share({ text });
    return true;
  } catch {
    return false;
  }
}

export interface DeliverOptions {
  sendTo?: SendTo;
  newlineAfterEnd?: boolean;
  hid: {
    sendText: (text: string) => Promise<boolean>;
    sendNewline: () => Promise<void>;
  };
  clipboard: ClipboardLike | undefined;
}

export type DeliverResult =
  | { via: "hid" }
  | { via: "phone"; copied: boolean };

/**
 * Deliver a finished dictation. Computer: typed over HID as always. Phone:
 * nothing goes over Bluetooth; the text is copied at once, no tap needed
 * (Chrome allows it for a focused page), and the caller shows Copy / Share.
 */
export async function deliver(
  text: string,
  { sendTo, newlineAfterEnd, hid, clipboard }: DeliverOptions
): Promise<DeliverResult> {
  if (deliveryFor(sendTo) === "phone") {
    return { via: "phone", copied: await copyToClipboard(text, clipboard) };
  }
  await hid.sendText(text);
  if (newlineAfterEnd) await hid.sendNewline();
  return { via: "hid" };
}
