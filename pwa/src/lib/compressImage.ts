/**
 * Compress a picture before it is typed. A keyboard types a few characters a
 * second, so a photo straight off a phone would take hours: shrink it step by
 * step (downscale, then lower the JPEG quality) until the typing estimate is
 * under the budget. The ladder, the search and the wording are pure; the
 * browser's canvas is behind ImageSource, so tests give it a stand-in.
 */
import { asciiName, formatBytes } from "./typeBinary";

export type ImageKind = "png" | "jpeg";

/** PNG or JPEG by the first bytes (a file's name and type can say anything). */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  return null;
}

export interface CompressionStep {
  format: ImageKind;
  /** longest side of the result, in pixels */
  maxSide: number;
  /** JPEG quality, 0 to 1; a PNG is lossless and ignores it */
  quality: number;
}

/** The sizes tried, largest first; nothing is made bigger than it is. */
const SIDES = [1600, 1024, 768, 512, 384, 256, 192, 128, 96, 64];
/** PNG keeps its pixels exactly down to here, then the JPEG steps take over. */
const PNG_SMALLEST = 256;

const jpegQuality = (side: number) =>
  side >= 768 ? 0.8 : side >= 384 ? 0.65 : side >= 192 ? 0.5 : 0.4;

/**
 * The steps to try for a picture, from the least change to the most. A JPEG
 * shrinks and loses quality as it goes. A PNG first shrinks and stays a PNG
 * (lossless, keeps transparency); if that is not enough it becomes a JPEG.
 */
export function compressionLadder(
  kind: ImageKind,
  width: number,
  height: number
): CompressionStep[] {
  const long = Math.max(width, height);
  const jpegSides = [...(long <= SIDES[0] ? [long] : []), ...SIDES.filter((s) => s < long)];
  const jpeg = jpegSides.map(
    (side): CompressionStep => ({ format: "jpeg", maxSide: side, quality: jpegQuality(side) })
  );
  if (kind === "jpeg") return jpeg;
  const png = SIDES.filter((s) => s < long && s >= PNG_SMALLEST).map(
    (side): CompressionStep => ({ format: "png", maxSide: side, quality: 1 })
  );
  return [...png, ...jpeg];
}

/** The size with the longest side cut to `maxSide`, same proportions, never upscaled. */
export function fitSize(
  width: number,
  height: number,
  maxSide: number
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxSide) return { width, height };
  const k = maxSide / long;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

/** The name after compression: the ending follows the format when it changed. */
export function compressedName(name: string, from: ImageKind, to: ImageKind): string {
  if (from === to) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${to === "jpeg" ? "jpg" : "png"}`;
}

/** An opened picture that can be drawn smaller and encoded. */
export interface ImageSource {
  width: number;
  height: number;
  render: (step: CompressionStep) => Promise<Uint8Array>;
  close: () => void;
}

export interface CompressDeps {
  source: ImageSource;
  kind: ImageKind;
  budgetSeconds: number;
  /** how long these bytes would take to type, as the message that carries them */
  estimateSeconds: (bytes: Uint8Array, step: CompressionStep) => Promise<number>;
  isCancelled: () => boolean;
}

export type CompressResult =
  | { status: "cancelled" }
  | {
      status: "done";
      bytes: Uint8Array;
      step: CompressionStep;
      seconds: number;
      /** false when even the smallest step is over the budget */
      fits: boolean;
    };

/**
 * Try the ladder in order and stop at the first step whose estimate is under
 * the budget. When none is, the smallest result found comes back, marked as
 * not fitting, and the caller asks before typing. The picture is closed on
 * every way out.
 */
export async function compressToBudget(deps: CompressDeps): Promise<CompressResult> {
  const { source } = deps;
  try {
    let best: Extract<CompressResult, { status: "done" }> | null = null;
    for (const step of compressionLadder(deps.kind, source.width, source.height)) {
      if (deps.isCancelled()) return { status: "cancelled" };
      const bytes = await source.render(step);
      const seconds = await deps.estimateSeconds(bytes, step);
      if (deps.isCancelled()) return { status: "cancelled" };
      const fits = seconds <= deps.budgetSeconds;
      if (!best || bytes.length < best.bytes.length) best = { status: "done", bytes, step, seconds, fits };
      if (fits) return { status: "done", bytes, step, seconds, fits };
    }
    if (!best) throw new Error("No way to make that picture smaller");
    return best;
  } finally {
    source.close();
  }
}

/** What was done to a picture, kept for the screen and the typed header. */
export interface CompressionInfo {
  fromName: string;
  fromBytes: number;
  toBytes: number;
  format: ImageKind;
  maxSide: number;
}

export function compressionSummary(c: CompressionInfo): string {
  return `Made smaller to type faster: ${asciiName(c.fromName)} ${formatBytes(c.fromBytes)} to ${formatBytes(c.toBytes)} (${c.format.toUpperCase()}, longest side ${c.maxSide} px)`;
}

/** Open a picture in the browser: decode once, then draw and encode on a canvas per step. */
export async function openBrowserImage(bytes: Uint8Array, kind: ImageKind): Promise<ImageSource> {
  const bitmap = await createImageBitmap(
    new Blob([bytes as BlobPart], { type: kind === "png" ? "image/png" : "image/jpeg" })
  );
  return {
    width: bitmap.width,
    height: bitmap.height,
    render: async (step) => {
      const { width, height } = fitSize(bitmap.width, bitmap.height, step.maxSide);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No canvas to draw on");
      if (step.format === "jpeg") {
        // a JPEG has no transparency: let it sit on white, not black
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, width, height);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, step.format === "png" ? "image/png" : "image/jpeg", step.quality)
      );
      if (!blob) throw new Error("The browser could not encode the picture");
      return new Uint8Array(await blob.arrayBuffer());
    },
    close: () => bitmap.close(),
  };
}
