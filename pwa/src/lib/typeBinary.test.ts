import { describe, expect, it } from "vitest";
import {
  BASE64_LINE_WIDTH,
  base64Lines,
  binaryBlock,
  formatBytes,
  safeFileName,
  sha256Hex,
  toBase64,
  typedBinaryText,
} from "./typeBinary";
import { chunkText, prepareFile, typeFile } from "./typeFile";
import type { ImageSource } from "./compressImage";

// Node-only modules are loaded by a variable name so tsc (no @types/node in
// this project) does not look for them; vitest runs in node.
const node = (name: string): Promise<any> => import(/* @vite-ignore */ name); // eslint-disable-line @typescript-eslint/no-explicit-any

const enc = (s: string) => new TextEncoder().encode(s);

/** Bytes that start like a PNG (signature + IHDR), `size` long: all sniffing needs. */
function fakePng(w: number, h: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, w);
  new DataView(out.buffer).setUint32(20, h);
  for (let i = 24; i < size; i++) out[i] = (i * 131 + 7) & 0xff;
  return out;
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const asBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe("base64", () => {
  it("encodes like the standard alphabet, with padding", () => {
    expect(toBase64(enc(""))).toBe("");
    expect(toBase64(enc("f"))).toBe("Zg==");
    expect(toBase64(enc("fo"))).toBe("Zm8=");
    expect(toBase64(enc("foo"))).toBe("Zm9v");
    expect(toBase64(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("+//+");
  });

  it("cuts the text into lines of a fixed width, the last one shorter", () => {
    const bytes = Uint8Array.from({ length: 200 }, (_, i) => (i * 37) & 0xff);
    const lines = base64Lines(bytes);
    expect(lines.join("")).toBe(asBase64(bytes));
    for (const l of lines.slice(0, -1)) expect(l.length).toBe(BASE64_LINE_WIDTH);
    expect(lines[lines.length - 1].length).toBeLessThanOrEqual(BASE64_LINE_WIDTH);
    expect(base64Lines(new Uint8Array())).toEqual([]);
  });
});

describe("sha256Hex and names", () => {
  it("hashes to lower-case hex", async () => {
    expect(await sha256Hex(enc("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("keeps a name that is safe in a shell and changes one that is not", () => {
    expect(safeFileName("photo-1.final_v2.png")).toBe("photo-1.final_v2.png");
    expect(safeFileName("my photo (1).png")).toBe("my_photo__1_.png");
    expect(safeFileName("it's $(rm -rf).png")).toBe("it_s___rm_-rf_.png");
    expect(safeFileName("-rf")).toBe("_rf");
    expect(safeFileName("...")).toBe("file");
    expect(safeFileName("日本語.png")).toBe("___.png");
  });

  it("says sizes plainly", () => {
    expect(formatBytes(11)).toBe("11 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  });
});

describe("the block that gets typed", () => {
  const bytes = enc("hello world"); // 11 bytes
  const sha = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

  it("pins the header, the base64 lines and the footer", () => {
    expect(binaryBlock({ name: "hello.bin", bytes, sha256: sha })).toBe(
      [
        "=== BINARY FILE, typed as base64 ===",
        "This is a binary file, not text. It was typed as base64 because a keyboard can only type text.",
        "file name: hello.bin",
        "size: 11 bytes",
        `sha256: ${sha}`,
        "The base64 is between the BEGIN BASE64 and END BASE64 lines below.",
        "To get the file back: save this whole message as hello.bin.b64.txt, then run ONE of these lines in the folder you saved it in. It writes hello.bin and checks its SHA-256 against the one above.",
        "bash:",
        `sed -n '/^-----BEGIN BASE64-----/,/^-----END BASE64-----/p' hello.bin.b64.txt | grep -v '^-----' | tr -d '\\r' | base64 -d > hello.bin && echo '${sha}  hello.bin' | sha256sum -c -`,
        "PowerShell:",
        `$t=[IO.File]::ReadAllText((Join-Path $PWD 'hello.bin.b64.txt')); $b=[Convert]::FromBase64String(($t -replace '(?sm)^.*?^-----BEGIN BASE64-----','' -replace '(?sm)^-----END BASE64-----.*$','')); [IO.File]::WriteAllBytes((Join-Path $PWD 'hello.bin'),$b); if((Get-FileHash 'hello.bin' -Algorithm SHA256).Hash -eq '${sha}'){'SHA-256 OK'}else{'SHA-256 MISMATCH'}`,
        "-----BEGIN BASE64-----",
        "aGVsbG8gd29ybGQ=",
        "-----END BASE64-----",
        "=== END OF BINARY FILE hello.bin ===",
        "",
      ].join("\n")
    );
  });

  it("is plain ASCII, so any keyboard layout types it as it is", () => {
    const block = binaryBlock({ name: "hello.bin", bytes, sha256: sha, note: "x" });
    expect(block).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("names the safe file name in the commands and the real one in the header", () => {
    const block = binaryBlock({ name: "my photo.png", bytes, sha256: sha });
    expect(block).toContain("file name: my photo.png");
    expect(block).toContain("save this whole message as my_photo.png.b64.txt");
    expect(block).not.toContain("'my photo.png'");
  });

  it("adds a line saying what was done to a picture", () => {
    const block = binaryBlock({
      name: "a.jpg",
      bytes,
      sha256: sha,
      note: "made smaller to type faster: from a.png (4.0 MB)",
    });
    expect(block).toContain("\nnote: made smaller to type faster: from a.png (4.0 MB)\n");
  });

  it("hashes the bytes it is given", async () => {
    const block = await typedBinaryText("hello.bin", bytes);
    expect(block).toContain(`sha256: ${sha}`);
  });
});

/** Run the header's bash line for real: rebuild the typed message and check it. */
async function rebuildWithBash(typed: string, name: string): Promise<{ file: Uint8Array; out: string }> {
  const fs = await node("node:fs");
  const os = await node("node:os");
  const path = await node("node:path");
  const cp = await node("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typebinary-"));
  try {
    fs.writeFileSync(path.join(dir, `${name}.b64.txt`), typed);
    const lines = typed.split("\n");
    const command = lines[lines.indexOf("bash:") + 1];
    const out = cp.execFileSync("bash", ["-c", command], { cwd: dir, encoding: "utf8" });
    return { file: new Uint8Array(fs.readFileSync(path.join(dir, name))), out };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * PowerShell is not installed here, so the header's PowerShell line is
 * followed step by step in JS: the same two -replace patterns, the same
 * base64 decoding (whitespace ignored), the same hash compare.
 */
async function rebuildLikePowerShell(typed: string): Promise<{ file: Uint8Array; hashOk: boolean }> {
  const lines = typed.split("\n");
  const command = lines[lines.indexOf("PowerShell:") + 1];
  const patterns = [...command.matchAll(/-replace '([^']*)',''/g)].map((m) => m[1]);
  expect(patterns.length).toBe(2);
  let body = typed;
  for (const p of patterns) {
    // .NET (?sm) is JS's s and m flags; the first -replace must not stop at the
    // marker named inside the command line itself, only at a line that starts with it
    body = body.replace(new RegExp(p.replace("(?sm)", ""), "sm"), "");
  }
  const file = fromBase64(body.replace(/[ \t\r\n]/g, ""));
  const expected = /-eq '([0-9a-f]{64})'/.exec(command)![1];
  return { file, hashOk: (await sha256Hex(file)).toLowerCase() === expected.toLowerCase() };
}

/** What the HID service receives: every /type body of a typeFile run, in order. */
async function typeThroughFakeHid(text: string): Promise<string> {
  const received: string[] = [];
  const result = await typeFile({
    text,
    delayMs: 10,
    sendChunk: async (c) => void received.push(c),
    waitTyped: async () => {},
    now: () => 0,
    isCancelled: () => false,
    onProgress: () => {},
  });
  expect(result).toEqual({ status: "done" });
  expect(received).toEqual(chunkText(text));
  return received.join("");
}

describe("a binary typed through the fake HID service comes back", () => {
  it("a small binary, rebuilt with the header's bash line and PowerShell line", async () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 91 + 13) & 0xff);
    bytes[10] = 0;
    const prepared = await prepareFile({
      name: "data.bin",
      bytes,
      delayMs: 5,
      budgetSeconds: 600,
      openImage: async () => {
        throw new Error("not a picture");
      },
      isCancelled: () => false,
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.kind).toBe("binary");
    expect(prepared.overBudget).toBe(false);

    const typed = await typeThroughFakeHid(prepared.text);
    const expectedSha = await sha256Hex(bytes);

    const bash = await rebuildWithBash(typed, "data.bin");
    expect(bytesEqual(bash.file, bytes)).toBe(true);
    expect(bash.out).toContain("data.bin: OK");

    const ps = await rebuildLikePowerShell(typed);
    expect(bytesEqual(ps.file, bytes)).toBe(true);
    expect(ps.hashOk).toBe(true);
    expect(typed).toContain(`sha256: ${expectedSha}`);
  });

  it("a PNG is compressed first, then rebuilt: the hash is the compressed file's", async () => {
    const png = fakePng(120, 120, 40_000);
    // a stand-in for the browser's canvas: output shrinks with the longest side
    const compressed = (maxSide: number) =>
      Uint8Array.from({ length: maxSide * 3 }, (_, i) => (i * 29 + maxSide) & 0xff);
    const renders: Array<{ format: string; maxSide: number }> = [];
    const source: ImageSource = {
      width: 120,
      height: 120,
      render: async (step) => {
        renders.push({ format: step.format, maxSide: step.maxSide });
        return compressed(step.maxSide);
      },
      close: () => {},
    };
    // 2 minutes at 10 ms: the original does not fit
    const prepared = await prepareFile({
      name: "shot.png",
      bytes: png,
      delayMs: 10,
      budgetSeconds: 120,
      openImage: async () => source,
      isCancelled: () => false,
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.kind).toBe("picture");
    expect(prepared.compression).toBeDefined();
    expect(prepared.overBudget).toBe(false);
    expect(prepared.seconds).toBeLessThan(120);
    expect(renders.length).toBeGreaterThan(0);

    const typed = await typeThroughFakeHid(prepared.text);
    const name = prepared.fileName;
    const sentBytes = compressed(prepared.compression!.maxSide);
    expect(prepared.compression!.toBytes).toBe(sentBytes.length);
    expect(prepared.compression!.fromBytes).toBe(png.length);

    const bash = await rebuildWithBash(typed, name);
    expect(bytesEqual(bash.file, sentBytes)).toBe(true);
    expect(bash.out).toContain(`${name}: OK`);
    const ps = await rebuildLikePowerShell(typed);
    expect(bytesEqual(ps.file, sentBytes)).toBe(true);
    expect(ps.hashOk).toBe(true);
    expect(typed).toContain(`sha256: ${await sha256Hex(sentBytes)}`);
    expect(typed).not.toContain(`sha256: ${await sha256Hex(png)}`);
  });
});
