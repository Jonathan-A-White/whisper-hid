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
async function openApp(page: Page, typeMs = 150): Promise<FakeHid> {
  const hid: FakeHid = { typed: [], stops: 0 };
  let typingUntil = 0;
  await page.setViewportSize({ width: 412, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("whisper_auth_token", "typefile-test");
    localStorage.setItem("entryMenuHintSeen", "1");
  });
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

test("a binary file is refused with a plain message and nothing is typed", async ({ page }) => {
  const hid = await openApp(page);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
  await pick(page, "picture.png", png);
  await expect(page.getByTestId("type-file-note")).toContainText(/not text/i);
  await expect(page.getByTestId("type-file-note")).toContainText(/binary files/i);
  await expect(page.getByTestId("type-file-note")).toContainText(/not supported yet/i);
  expect(hid.typed).toEqual([]);
});
