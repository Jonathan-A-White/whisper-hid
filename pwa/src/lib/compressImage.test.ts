import { describe, expect, it } from "vitest";
import {
  compressToBudget,
  compressedName,
  compressionLadder,
  compressionSummary,
  fitSize,
  sniffImage,
  type CompressionStep,
  type ImageSource,
} from "./compressImage";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];

describe("sniffImage", () => {
  it("knows a PNG and a JPEG by their first bytes, whatever the name says", () => {
    expect(sniffImage(new Uint8Array([...PNG, 1, 2, 3]))).toBe("png");
    expect(sniffImage(new Uint8Array([...JPEG, 0, 16]))).toBe("jpeg");
  });

  it("knows nothing else, and does not fail on short input", () => {
    expect(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF
    expect(sniffImage(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // PDF
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(new Uint8Array(PNG.slice(0, 5)))).toBeNull();
  });
});

describe("compressionLadder", () => {
  const long = (s: CompressionStep) => s.maxSide;

  it("starts at full size for a small JPEG and only ever shrinks", () => {
    const steps = compressionLadder("jpeg", 800, 600);
    expect(steps[0]).toMatchObject({ format: "jpeg", maxSide: 800 });
    for (const s of steps) expect(s.format).toBe("jpeg");
    for (let i = 1; i < steps.length; i++) {
      expect(long(steps[i])).toBeLessThan(long(steps[i - 1]));
      expect(steps[i].quality).toBeLessThanOrEqual(steps[i - 1].quality);
    }
    expect(long(steps[steps.length - 1])).toBe(64);
  });

  it("never scales a picture up and caps a big one", () => {
    const steps = compressionLadder("jpeg", 4000, 3000);
    expect(steps[0].maxSide).toBe(1600);
    expect(Math.max(...steps.map(long))).toBe(1600);
    expect(compressionLadder("jpeg", 40, 30)).toEqual([
      { format: "jpeg", maxSide: 40, quality: expect.any(Number) },
    ]);
  });

  it("keeps a PNG a PNG while it shrinks, then falls back to JPEG", () => {
    const steps = compressionLadder("png", 2000, 1000);
    const formats = steps.map((s) => s.format);
    expect(formats[0]).toBe("png");
    expect(formats).toContain("jpeg");
    // once it is a JPEG it stays one
    expect(formats.indexOf("jpeg")).toBe(formats.lastIndexOf("png") + 1);
    expect(steps.filter((s) => s.format === "png").every((s) => s.maxSide < 2000)).toBe(true);
  });
});

describe("fitSize", () => {
  it("keeps the proportions with the longest side at most maxSide", () => {
    expect(fitSize(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(300, 900, 90)).toEqual({ width: 30, height: 90 });
    expect(fitSize(100, 50, 400)).toEqual({ width: 100, height: 50 });
    expect(fitSize(1000, 1, 10)).toEqual({ width: 10, height: 1 });
  });
});

describe("compressedName", () => {
  it("keeps the name when the format stays and changes the ending when it does not", () => {
    expect(compressedName("shot.png", "png", "png")).toBe("shot.png");
    expect(compressedName("a.JPEG", "jpeg", "jpeg")).toBe("a.JPEG");
    expect(compressedName("shot.png", "png", "jpeg")).toBe("shot.jpg");
    expect(compressedName("shot", "png", "jpeg")).toBe("shot.jpg");
    expect(compressedName("my.big.png", "png", "jpeg")).toBe("my.big.jpg");
  });
});

/** A picture whose encoded size is a function of the step. */
function pictureOf(sizeOf: (s: CompressionStep) => number, width = 1000, height = 800) {
  const rendered: CompressionStep[] = [];
  let closed = 0;
  const source: ImageSource = {
    width,
    height,
    render: async (step) => {
      rendered.push(step);
      return new Uint8Array(sizeOf(step));
    },
    close: () => void closed++,
  };
  return { source, rendered, closed: () => closed };
}

// 1 byte = 1 second keeps the arithmetic plain
const seconds = async (bytes: Uint8Array) => bytes.length;

describe("compressToBudget", () => {
  it("stops at the first step that fits and does not render more", async () => {
    const pic = pictureOf((s) => s.maxSide); // 1000 -> 1000 s, 512 -> 512 s ...
    const result = await compressToBudget({
      source: pic.source,
      kind: "jpeg",
      budgetSeconds: 400,
      estimateSeconds: seconds,
      isCancelled: () => false,
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.fits).toBe(true);
    expect(result.bytes.length).toBe(384);
    expect(result.step.maxSide).toBe(384);
    expect(pic.rendered.map((s) => s.maxSide)).toEqual([1000, 768, 512, 384]);
    expect(pic.closed()).toBe(1);
  });

  it("gives the smallest it could make, marked as not fitting, when nothing fits", async () => {
    const pic = pictureOf((s) => s.maxSide * 100);
    const result = await compressToBudget({
      source: pic.source,
      kind: "jpeg",
      budgetSeconds: 10,
      estimateSeconds: seconds,
      isCancelled: () => false,
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.fits).toBe(false);
    expect(result.step.maxSide).toBe(64);
    expect(result.bytes.length).toBe(6400);
  });

  it("stops rendering when cancelled and lets the picture go", async () => {
    const pic = pictureOf((s) => s.maxSide * 100);
    let calls = 0;
    const result = await compressToBudget({
      source: pic.source,
      kind: "jpeg",
      budgetSeconds: 10,
      estimateSeconds: seconds,
      isCancelled: () => ++calls > 2,
    });
    expect(result).toEqual({ status: "cancelled" });
    expect(pic.rendered.length).toBeLessThan(4);
    expect(pic.closed()).toBe(1);
  });

  it("releases the picture when a render fails", async () => {
    const pic = pictureOf(() => 1);
    pic.source.render = async () => {
      throw new Error("canvas gone");
    };
    await expect(
      compressToBudget({
        source: pic.source,
        kind: "jpeg",
        budgetSeconds: 10,
        estimateSeconds: seconds,
        isCancelled: () => false,
      })
    ).rejects.toThrow("canvas gone");
    expect(pic.closed()).toBe(1);
  });
});

describe("compressionSummary", () => {
  it("says what was done in plain words", () => {
    expect(
      compressionSummary({
        fromName: "shot.png",
        fromBytes: 4 * 1024 * 1024,
        toBytes: 3 * 1024,
        format: "jpeg",
        maxSide: 192,
      })
    ).toBe("Made smaller to type faster: shot.png 4.0 MB to 3.0 KB (JPEG, longest side 192 px)");
  });
});
