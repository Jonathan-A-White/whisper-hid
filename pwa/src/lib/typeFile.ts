/**
 * Type a file: a UTF-8 text file is typed as it is, chunk by chunk, through
 * the HID service; any other file is typed as base64 between a header and a
 * footer (typeBinary.ts), a picture compressed first (compressImage.ts).
 * Pure logic here; TypeFileButton wires it to the browser.
 */
import {
  compressToBudget,
  compressedName,
  compressionSummary,
  sniffImage,
  type CompressionInfo,
  type ImageKind,
  type ImageSource,
} from "./compressImage";
import { typedBinaryText } from "./typeBinary";

export type DecodedFile = { ok: true; text: string } | { ok: false };

/**
 * The file's text, or `ok: false` when it is not text: bytes that are not
 * valid UTF-8, or NUL bytes (valid UTF-8, but no text file has them). The
 * byte order mark and line endings are kept, so the text is the file.
 */
export function decodeTextFile(bytes: Uint8Array): DecodedFile {
  if (bytes.includes(0)) return { ok: false };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
    return { ok: true, text };
  } catch {
    return { ok: false };
  }
}

/** Characters per /type request: small enough for a progress bar that moves. */
export const TYPE_FILE_CHUNK_CHARS = 200;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * Cut text into pieces of at most `max` UTF-16 units, in order, without ever
 * cutting inside a surrogate pair (an emoji) or between the CR and LF of a
 * line ending.
 */
export function chunkText(text: string, max = TYPE_FILE_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const before = text.charCodeAt(end - 1);
      const joinsNext =
        isHigh(before) || (before === 0x0d && text.charCodeAt(end) === 0x0a);
      // step back so the pair goes whole into the next chunk; a chunk limit
      // too small for one character takes the character anyway
      if (joinsNext) end = end - 1 > start ? end - 1 : end + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

const SHIFTED = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:"<>?');

/**
 * HID reports the service sends for `text`: a key-down and a release per
 * character, plus one more for a shifted character (the modifier goes first,
 * alone). Matches HidKeyMapper.buildReports for ASCII; other text is close.
 */
export function countReports(text: string): number {
  let reports = 0;
  for (const ch of text) reports += SHIFTED.has(ch) ? 3 : 2;
  return reports;
}

/** How long one report takes on the link. */
export interface TypingRate {
  msPerReport: number;
}

/**
 * Before anything has been typed: the service waits the keystroke delay after
 * each report and sendReport itself costs about 1 ms (its own log shows
 * T/M = delay + 1).
 */
export function initialRate(delayMs: number): TypingRate {
  return { msPerReport: delayMs + 1 };
}

/** The pace actually seen: `reports` typed in `ms`; null when nothing to go on. */
export function measuredRate(reports: number, ms: number): TypingRate | null {
  if (reports <= 0 || ms <= 0) return null;
  return { msPerReport: ms / reports };
}

export function estimateSeconds(text: string, rate: TypingRate): number {
  return (countReports(text) * rate.msPerReport) / 1000;
}

export function formatDuration(seconds: number): string {
  if (seconds < 1) return "under a second";
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return sec ? `${min} min ${sec} s` : `${min} min`;
  }
  const h = Math.floor(total / 3600);
  const min = Math.round((total % 3600) / 60);
  return min ? `${h} h ${min} min` : `${h} h`;
}

export interface TypeFileProgress {
  typedChars: number;
  totalChars: number;
  remainingSeconds: number;
}

export interface TypeFileDeps {
  text: string;
  /** the Keystroke delay setting, for the estimate before any pace is measured */
  delayMs: number;
  chunkChars?: number;
  /** hand one chunk to the HID service; throws when it cannot */
  sendChunk: (chunk: string) => Promise<void>;
  /** resolves when the service has finished typing what it was handed */
  waitTyped: (chunk: string) => Promise<void>;
  now: () => number;
  isCancelled: () => boolean;
  onProgress: (progress: TypeFileProgress) => void;
}

export type TypeFileResult =
  | { status: "done" }
  | { status: "cancelled"; typedChars: number }
  | { status: "failed"; typedChars: number; error: string };

/**
 * Send the text chunk by chunk, each one only after the last was typed, so a
 * Cancel takes effect before the next chunk goes out. The time left comes from
 * the delay setting at first, then from the pace measured on the chunks typed
 * (the first is left out: it pays for waking the link).
 */
export async function typeFile(deps: TypeFileDeps): Promise<TypeFileResult> {
  const chunks = chunkText(deps.text, deps.chunkChars);
  const totalChars = deps.text.length;
  let rate = initialRate(deps.delayMs);
  let typedChars = 0;
  let measuredReports = 0;
  let measuredMs = 0;
  let remainingReports = countReports(deps.text);

  const report = () =>
    deps.onProgress({
      typedChars,
      totalChars,
      remainingSeconds: (remainingReports * rate.msPerReport) / 1000,
    });
  report();

  for (let i = 0; i < chunks.length; i++) {
    if (deps.isCancelled()) return { status: "cancelled", typedChars };
    const chunk = chunks[i];
    const started = deps.now();
    try {
      await deps.sendChunk(chunk);
      await deps.waitTyped(chunk);
    } catch (e) {
      return {
        status: "failed",
        typedChars,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (deps.isCancelled()) return { status: "cancelled", typedChars };
    typedChars += chunk.length;
    const chunkReports = countReports(chunk);
    remainingReports -= chunkReports;
    if (i > 0) {
      measuredReports += chunkReports;
      measuredMs += deps.now() - started;
      rate = measuredRate(measuredReports, measuredMs) ?? rate;
    }
    report();
  }
  return { status: "done" };
}

export interface WaitIdleDeps {
  /** the HID service's `typing` flag; undefined on an APK too old to report it */
  readTyping: () => Promise<boolean | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** how long the chunk should take, for a service that cannot say */
  expectedMs: number;
  pollMs?: number;
  graceMs?: number;
}

/**
 * Wait until the HID service has typed what it was handed. /type answers as
 * soon as the send is queued, and `typing` only turns true when the keystroke
 * thread picks it up, so false straight after the request does not mean done:
 * wait to see it go true then false, or for the grace period to pass (a chunk
 * short enough to finish between two polls is never seen typing).
 */
export async function waitForIdle(deps: WaitIdleDeps): Promise<void> {
  const pollMs = deps.pollMs ?? 100;
  const graceMs = deps.graceMs ?? 1500;
  const started = deps.now();
  let sawTyping = false;
  for (;;) {
    await deps.sleep(pollMs);
    const typing = await deps.readTyping();
    const waited = deps.now() - started;
    if (typing === undefined) {
      if (waited >= deps.expectedMs) return;
    } else if (typing) {
      sawTyping = true;
    } else if (sawTyping || waited >= graceMs) {
      return;
    }
  }
}

export interface PrepareDeps {
  name: string;
  bytes: Uint8Array;
  /** the Keystroke delay setting, for the typing estimate */
  delayMs: number;
  /** the most typing time that goes ahead without asking */
  budgetSeconds: number;
  /** open a picture for compression; throws when the browser cannot read it */
  openImage: (bytes: Uint8Array, kind: ImageKind) => Promise<ImageSource>;
  isCancelled: () => boolean;
}

export type Prepared =
  | { status: "empty" }
  | { status: "cancelled" }
  | {
      status: "ready";
      kind: "text" | "binary" | "picture";
      /** the name that will be typed: a PNG that became a JPEG is renamed */
      fileName: string;
      /** everything that will be typed */
      text: string;
      /** how long typing `text` should take */
      seconds: number;
      /** longer than the budget: ask before typing */
      overBudget: boolean;
      /** set when a picture was made smaller */
      compression?: CompressionInfo;
    };

/**
 * Turn a picked file into the text to type and say whether it needs asking
 * about. Text is typed as it is. Anything else is typed as base64 with its
 * header; a picture over the budget is first compressed, step by step, until
 * it fits (or as small as it gets, when it never does).
 */
export async function prepareFile(deps: PrepareDeps): Promise<Prepared> {
  const { name, bytes } = deps;
  if (deps.isCancelled()) return { status: "cancelled" };
  if (bytes.length === 0) return { status: "empty" };
  const rate = initialRate(deps.delayMs);
  const secondsFor = (text: string) => estimateSeconds(text, rate);

  const decoded = decodeTextFile(bytes);
  if (decoded.ok) {
    const seconds = secondsFor(decoded.text);
    return {
      status: "ready",
      kind: "text",
      fileName: name,
      text: decoded.text,
      seconds,
      overBudget: seconds > deps.budgetSeconds,
    };
  }

  const text = await typedBinaryText(name, bytes);
  const seconds = secondsFor(text);
  const kind = sniffImage(bytes);
  const asIs = (): Extract<Prepared, { status: "ready" }> => ({
    status: "ready",
    kind: kind ? "picture" : "binary",
    fileName: name,
    text,
    seconds,
    overBudget: seconds > deps.budgetSeconds,
  });
  if (!kind || seconds <= deps.budgetSeconds) return asIs();

  let source: ImageSource;
  try {
    source = await deps.openImage(bytes, kind);
  } catch {
    // not a picture the browser can read: type it like any other binary
    return { ...asIs(), kind: "binary" };
  }
  const infoFor = (toBytes: number, format: ImageKind, maxSide: number): CompressionInfo => ({
    fromName: name,
    fromBytes: bytes.length,
    toBytes,
    format,
    maxSide,
  });
  let result;
  try {
    result = await compressToBudget({
      source,
      kind,
      budgetSeconds: deps.budgetSeconds,
      isCancelled: deps.isCancelled,
      estimateSeconds: async (out, step) =>
        secondsFor(
          await typedBinaryText(
            compressedName(name, kind, step.format),
            out,
            compressionSummary(infoFor(out.length, step.format, step.maxSide))
          )
        ),
    });
  } catch {
    return { ...asIs(), kind: "binary" };
  }
  if (result.status === "cancelled") return { status: "cancelled" };
  // a "compression" that made it no smaller is not worth the change
  if (result.bytes.length >= bytes.length) return asIs();
  const fileName = compressedName(name, kind, result.step.format);
  const compression = infoFor(result.bytes.length, result.step.format, result.step.maxSide);
  const compressedText = await typedBinaryText(fileName, result.bytes, compressionSummary(compression));
  const compressedSeconds = secondsFor(compressedText);
  return {
    status: "ready",
    kind: "picture",
    fileName,
    text: compressedText,
    seconds: compressedSeconds,
    overBudget: compressedSeconds > deps.budgetSeconds,
    compression,
  };
}
