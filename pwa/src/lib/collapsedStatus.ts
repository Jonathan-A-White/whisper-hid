import type { HidStatus, WhisperStatus } from "../types";

export type Dot = "green" | "yellow" | "red";

export interface CollapsedStatus {
  model: { dot: Dot; text: string };
  link: { dot: Dot; text: string };
  /** both lines in one sentence, for the handle's title and accessible name */
  title: string;
}

/**
 * The header's two status dots (speech model, Bluetooth link) as plain data,
 * for the handle beside Hold to talk in a bare window where the header is gone.
 * Same colours and words as StatusBar.
 */
export function collapsedStatus(input: {
  whisperStatus: WhisperStatus | null;
  whisperError: string | null;
  hidStatus: HidStatus | null;
  hidReachable: boolean;
}): CollapsedStatus {
  const { whisperStatus, whisperError, hidStatus, hidReachable } = input;
  const ready = whisperStatus?.status === "ready";
  const model = {
    dot: (ready ? "green" : "red") as Dot,
    text: ready ? (whisperStatus?.model ?? "ready") : whisperError || "offline",
  };

  const bt = hidStatus?.bluetooth;
  const link = !hidReachable
    ? { dot: "red" as Dot, text: "HID offline" }
    : bt === "connected"
      ? { dot: "green" as Dot, text: hidStatus?.device ?? "connected" }
      : bt === "reconnecting"
        ? { dot: "yellow" as Dot, text: `Retry ${hidStatus?.reconnect_attempt}` }
        : { dot: "red" as Dot, text: bt || "idle" };

  return {
    model,
    link,
    title: `Model: ${model.text}. Connection: ${link.text}. Tap for History and Settings.`,
  };
}
