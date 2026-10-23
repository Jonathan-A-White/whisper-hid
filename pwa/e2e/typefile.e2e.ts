import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

// "Type a file" in a real Chromium against a fake HID service that records
// every /type request. The file typed must come back byte for byte.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    headers: CORS,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

interface FakeHid {
  typed: string[];
  stops: number;
}

/** A phone that types each /type request for `typeMs` before it is idle again. */
async function openApp(page: Page, typeMs = 150, settings: object = {}): Promise<FakeHid> {
  const hid: FakeHid = { typed: [], stops: 0 };
  let typingUntil = 0;
  await page.setViewportSize({ width: 412, height: 900 });
  await page.addInitScript((stored) => {
    localStorage.setItem("whisper_auth_token", "typefile-test");
    localStorage.setItem("entryMenuHintSeen", "1");
    localStorage.setItem("whisper_settings", JSON.stringify(stored));
  }, settings);
  await page.route("http://localhost:9876/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(route.request().url()).pathname;
    if (path === "/status")
      return json(route, { status: "ready", model: "parakeet-tdt-0.6b-v2", version: "1.0.0" });
    return route.abort("connectionrefused");
  });
  await page.route("http://localhost:9877/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(req.url()).pathname;
    if (path === "/status")
      return json(route, {
        service: "running",
        bluetooth: "connected",
        device: "PF46SGM4",
        typing: Date.now() < typingUntil,
      });
    if (path === "/type") {
      const body = JSON.parse(req.postData() ?? "{}");
      hid.typed.push(body.text + (body.append ?? ""));
      typingUntil = Date.now() + typeMs;
      return json(route, { ok: true });
    }
    if (path === "/stop") {
      hid.stops++;
      typingUntil = 0;
      return json(route, { ok: true });
    }
    return route.abort("connectionrefused");
  });
  await page.goto("/whisper-hid/");
  await expect(page.getByText("Connected to PF46SGM4")).toBeAttached();
  return hid;
}

const pick = (page: Page, name: string, buffer: Buffer) =>
  page.getByTestId("type-file-input").setInputFiles({ name, mimeType: "", buffer });

test("a text file is typed in order and comes back byte for byte", async ({ page }) => {
  const hid = await openApp(page);
  // longer than one chunk, with accents, CJK, an emoji, tabs and CRLF
  const text = "Zażółć gęślą jaźń — 日本語 🙂\tcolumn\r\nline two\n".repeat(12);
  await page.getByRole("button", { name: /type a file/i }).waitFor();
  await pick(page, "notes.txt", Buffer.from(text, "utf8"));

  await expect(page.getByTestId("type-file-estimate")).toContainText(
    `${text.length.toLocaleString("en-US")} characters`
  );
  await expect(page.getByTestId("type-file-estimate")).toContainText("to type");
  expect(hid.typed).toEqual([]); // nothing is typed until he says so

  await page.getByRole("button", { name: "Type it" }).click();
  await expect(page.getByTestId("type-file-progress")).toBeVisible();
  await expect(page.getByTestId("type-file-status")).toContainText("left");
  await expect(page.getByTestId("type-file-note")).toContainText("Typed notes.txt", {
    timeout: 20_000,
  });

  expect(hid.typed.length).toBeGreaterThan(1);
  expect(Buffer.from(hid.typed.join(""), "utf8").equals(Buffer.from(text, "utf8"))).toBe(true);
});

test("Cancel stops typing between chunks", async ({ page }) => {
  const hid = await openApp(page, 400);
  const text = "abcdefghij".repeat(100); // 5 chunks
  await pick(page, "long.txt", Buffer.from(text));
  await page.getByRole("button", { name: "Type it" }).click();
  await expect(page.getByTestId("type-file-progress")).toBeVisible();
  await expect.poll(() => hid.typed.length).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("type-file-note")).toContainText("Stopped");
  expect(hid.stops).toBeGreaterThanOrEqual(1);
  const sentAtCancel = hid.typed.length;
  await page.waitForTimeout(1500);
  expect(hid.typed.length).toBe(sentAtCancel);
  expect(hid.typed.length).toBeLessThan(5);
  expect(text.startsWith(hid.typed.join(""))).toBe(true);
});

/** A real PNG: width x height pixels, each from pixel(x, y) as [r, g, b]. */
function makePng(width: number, height: number, pixel: (x: number, y: number) => number[]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const gradient = (x: number, y: number) => [x % 256, y % 256, (x + y) % 256];
let seed = 1;
const noise = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed >> 16;
};

/**
 * What the computer ends up with: the typed message saved as `<name>.b64.txt`,
 * then the header's own bash line run on it. Returns the rebuilt file and the
 * line's output (sha256sum -c prints "<name>: OK").
 */
function rebuildWithHeaderBash(typed: string, name: string): { file: Buffer; out: string; sha: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "typefile-e2e-"));
  try {
    writeFileSync(path.join(dir, `${name}.b64.txt`), typed);
    const lines = typed.split("\n");
    const command = lines[lines.indexOf("bash:") + 1];
    const out = execFileSync("bash", ["-c", command], { cwd: dir, encoding: "utf8" });
    const sha = /^sha256: ([0-9a-f]{64})$/m.exec(typed)![1];
    return { file: readFileSync(path.join(dir, name)), out, sha };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a small binary is typed as base64 with a header, and the header's bash line rebuilds it", async ({ page }) => {
  const hid = await openApp(page);
  const bytes = Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 91 + 13) & 0xff));
  await pick(page, "data.bin", bytes);
  await expect(page.getByTestId("type-file-binary")).toContainText("base64");
  await expect(page.getByTestId("type-file-estimate")).toContainText("to type");
  await expect(page.getByTestId("type-file-over")).toHaveCount(0);
  expect(hid.typed).toEqual([]);

  await page.getByRole("button", { name: "Type it" }).click();
  await expect(page.getByTestId("type-file-note")).toContainText("Typed data.bin as base64", {
    timeout: 30_000,
  });

  const typed = hid.typed.join("");
  expect(typed).toContain("=== BINARY FILE, typed as base64 ===");
  expect(typed).toContain("file name: data.bin");
  expect(typed).toContain("size: 200 bytes");
  expect(typed).toContain(`sha256: ${createHash("sha256").update(bytes).digest("hex")}`);
  const rebuilt = rebuildWithHeaderBash(typed, "data.bin");
  expect(rebuilt.out).toContain("data.bin: OK");
  expect(rebuilt.file.equals(bytes)).toBe(true);
});

test("a picture is made smaller until it fits the time limit, then rebuilt: the hash is the compressed file's", async ({ page }) => {
  const hid = await openApp(page);
  const png = makePng(600, 600, gradient);
  expect(png.length).toBeGreaterThan(5_000); // far over 2 minutes of typing
  await pick(page, "shot.png", png);

  await expect(page.getByTestId("type-file-compressed")).toContainText("Made smaller to type faster: shot.png");
  await expect(page.getByTestId("type-file-estimate")).toContainText("to type");
  await expect(page.getByTestId("type-file-over")).toHaveCount(0);
  expect(hid.typed).toEqual([]);
  const shown = await page.getByTestId("type-file-estimate").textContent();
  const minutes = /about (?:(\d+) min)?\s*(?:(\d+) s)?/.exec(shown ?? "");
  expect(Number(minutes?.[1] ?? 0)).toBeLessThan(2);

  await page.getByRole("button", { name: "Type it" }).click();
  await expect(page.getByTestId("type-file-note")).toContainText("as base64", { timeout: 60_000 });

  const typed = hid.typed.join("");
  const name = /^file name: (.+)$/m.exec(typed)![1];
  expect(name).toMatch(/^shot\.(png|jpg)$/);
  const rebuilt = rebuildWithHeaderBash(typed, name);
  expect(rebuilt.out).toContain(`${name}: OK`);
  expect(rebuilt.file.length).toBeLessThan(png.length);
  expect(createHash("sha256").update(rebuilt.file).digest("hex")).toBe(rebuilt.sha);
  // still a picture the browser can open: PNG or JPEG signature
  const magic = rebuilt.file.subarray(0, 4).toString("hex");
  expect(["89504e47", "ffd8ffe0", "ffd8ffe1", "ffd8ffdb"]).toContain(magic);
});

test("a picture that cannot be made small enough asks: Type anyway or Cancel", async ({ page }) => {
  const hid = await openApp(page, 150, { typeBudgetMinutes: 1 });
  const png = makePng(300, 300, () => [noise(), noise(), noise()]);
  await pick(page, "noise.png", png);
  await expect(page.getByTestId("type-file-over")).toContainText("1-minute limit");
  await expect(page.getByTestId("type-file-compressed")).toBeVisible();
  expect(hid.typed).toEqual([]);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("type-file-ready")).toHaveCount(0);
  expect(hid.typed).toEqual([]);
});

test("another binary over the limit asks, and Type anyway types it", async ({ page }) => {
  const hid = await openApp(page, 150, { typeBudgetMinutes: 1 });
  const bytes = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 131 + 7) & 0xff));
  await pick(page, "doc.pdf", bytes);
  await expect(page.getByTestId("type-file-over")).toContainText("1-minute limit");
  expect(hid.typed).toEqual([]);
  await page.getByRole("button", { name: "Type anyway" }).click();
  await expect(page.getByTestId("type-file-note")).toContainText("Typed doc.pdf as base64", {
    timeout: 30_000,
  });
  const rebuilt = rebuildWithHeaderBash(hid.typed.join(""), "doc.pdf");
  expect(rebuilt.file.equals(bytes)).toBe(true);
});

test("Cancel stops a binary being typed between chunks", async ({ page }) => {
  const hid = await openApp(page, 400);
  await pick(page, "data.bin", Buffer.from(Array.from({ length: 1500 }, (_, i) => (i * 17) & 0xff)));
  await page.getByRole("button", { name: /type (it|anyway)/i }).click();
  await expect(page.getByTestId("type-file-progress")).toBeVisible();
  await expect.poll(() => hid.typed.length).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("type-file-note")).toContainText("Stopped");
  const sentAtCancel = hid.typed.length;
  await page.waitForTimeout(1500);
  expect(hid.typed.length).toBe(sentAtCancel);
});

test("Settings has the Typing time limit, 2 minutes to begin with", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await expect(page.getByText("Typing time limit: 2 min")).toBeVisible();
  await expect(page.getByRole("slider", { name: "Typing time limit" })).toHaveValue("2");
});
