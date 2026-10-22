import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// The built PWA in a real Chromium at his split-screen sizes. The vitest layout
// tests only read class names from source; this one renders the page and asks
// the browser where the Hold to talk button really is and what is on top of it.
// Run it with `npm run test:layout` (builds dist/, serves it with vite preview).

const SHOTS = "layout-shots";
const WIDTH = 412;
const HEIGHTS = [175, 240, 380, 900];
const BAR_MIN_HEIGHT = 56;

mkdirSync(SHOTS, { recursive: true });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const HID_STATUS = {
  service: "running",
  bluetooth: "connected",
  device: "PF46SGM4",
  headset_mic: {
    available: true,
    active: false,
    enabled: true,
    keep_warm: false,
    dictating: false,
    device: "Headset",
  },
};
const WHISPER_STATUS = {
  status: "ready",
  model: "parakeet-tdt-0.6b-v2",
  version: "1.0.0",
};

/** Opens the app signed in (no setup wizard) against fake localhost servers. */
async function openApp(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("whisper_auth_token", "layout-test");
    localStorage.setItem("entryMenuHintSeen", "1");
  });
  for (const [port, status] of [
    [9876, WHISPER_STATUS],
    [9877, HID_STATUS],
  ] as const) {
    await page.route(`http://localhost:${port}/**`, (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: CORS });
      }
      // only /status is faked; every other call fails as if the endpoint were absent
      if (new URL(req.url()).pathname !== "/status") {
        return route.abort("connectionrefused");
      }
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: "application/json",
        body: JSON.stringify(status),
      });
    });
  }
  await page.goto("/whisper-hid/");
  return errors;
}

const holdToTalk = (page: Page) =>
  page.getByRole("button", { name: /hold to talk/i });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no bounding box");
  return b;
}

/** True when the element at (x, y) is `target` or inside it. */
function topmostIsInside(page: Page, target: Locator, x: number, y: number) {
  return target.evaluate(
    (el, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      return hit !== null && el.contains(hit);
    },
    { x, y }
  );
}

const measured: string[] = [];
test.afterAll(() => {
  console.log(`Hold to talk boxes (x, y, width, height):\n${measured.join("\n")}`);
});

for (const height of HEIGHTS) {
  test(`Talk, ${WIDTH}x${height}: Hold to talk is whole, uncovered and big enough`, async ({
    page,
  }) => {
    const errors = await openApp(page, WIDTH, height);
    const bar = holdToTalk(page);
    await expect(bar).toBeVisible();
    // the status poll has answered (header shows the device), so what is on
    // screen is the connected state he sees
    await expect(page.getByText("Connected to PF46SGM4")).toBeAttached();

    await page.screenshot({ path: `${SHOTS}/talk-${WIDTH}x${height}.png` });
    const b = await box(bar);
    measured.push(
      `${WIDTH}x${height}: x=${b.x} y=${b.y} width=${b.width} height=${b.height}`
    );

    // wholly inside the viewport
    expect(b.x, "left edge").toBeGreaterThanOrEqual(0);
    expect(b.y, "top edge").toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, "right edge").toBeLessThanOrEqual(WIDTH);
    expect(b.y + b.height, "bottom edge").toBeLessThanOrEqual(height);
    expect(b.height, "height").toBeGreaterThanOrEqual(BAR_MIN_HEIGHT);

    // nothing covers it: the centre and a point 4px inside each corner of the
    // button's own shape. The bar has rounded corners, and a hit test at the
    // square corner would miss the button itself and land on the block under
    // it, so each corner point also steps in past the curve (r * (1 - 1/sqrt 2)).
    const radius = await bar.evaluate((el) =>
      parseFloat(getComputedStyle(el).borderTopLeftRadius)
    );
    const inset = 4 + radius * (1 - Math.SQRT1_2);
    const points = {
      centre: [b.x + b.width / 2, b.y + b.height / 2],
      "top-left": [b.x + inset, b.y + inset],
      "top-right": [b.x + b.width - inset, b.y + inset],
      "bottom-left": [b.x + inset, b.y + b.height - inset],
      "bottom-right": [b.x + b.width - inset, b.y + b.height - inset],
    };
    for (const [name, [x, y]] of Object.entries(points)) {
      expect(await topmostIsInside(page, bar, x, y), `${name} is covered`).toBe(
        true
      );
    }
    expect(errors).toEqual([]);
  });
}

// Sweep: at his size the other tabs' first thing must be reachable by scrolling
// and not under the tab bar or the header.
async function expectReachable(page: Page, target: Locator, what: string) {
  await target.scrollIntoViewIfNeeded();
  const b = await box(target);
  const nav = await box(page.locator("nav"));
  const main = await box(page.locator("main"));
  // the part of the element between the header and the tab bar
  const top = Math.max(b.y, main.y);
  const bottom = Math.min(b.y + b.height, nav.y);
  expect(
    bottom - top,
    `${what}: visible between header and tab bar`
  ).toBeGreaterThanOrEqual(Math.min(b.height, 20));
  expect(
    await topmostIsInside(page, target, b.x + b.width / 2, (top + bottom) / 2),
    `${what} is covered`
  ).toBe(true);
}

test("History, 412x175: the empty state is reachable and not covered", async ({
  page,
}) => {
  await openApp(page, WIDTH, 175);
  await page.getByRole("button", { name: "history", exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/history-empty-${WIDTH}x175.png` });
  await expectReachable(
    page,
    page.getByText("No transcriptions yet"),
    "History empty state"
  );
});

test("History, 412x175: the newest entry is reachable and not covered", async ({
  page,
}) => {
  await openApp(page, WIDTH, 175);
  // seed one entry straight into the app's IndexedDB, then reload to load it
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("whisper-keyboard", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("transcripts", "readwrite");
          tx.objectStore("transcripts").add({
            id: "layout-1",
            text: "The newest dictation, ready to check.",
            timestamp: Date.now(),
            pinned: false,
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      })
  );
  await page.reload();
  await page.getByRole("button", { name: "history", exact: true }).click();
  const entry = page.getByText("The newest dictation, ready to check.");
  await expect(entry).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/history-entry-${WIDTH}x175.png` });
  await expectReachable(page, entry, "History newest entry");
});

test("Settings, 412x175: the first row is reachable and not covered", async ({
  page,
}) => {
  await openApp(page, WIDTH, 175);
  await page.getByRole("button", { name: "settings", exact: true }).click();
  const firstRow = page.locator("main section").first().locator("xpath=./div/*[1]");
  await expect(firstRow).toBeAttached();
  await page.screenshot({ path: `${SHOTS}/settings-${WIDTH}x175.png` });
  await expectReachable(page, firstRow, "Settings first row");
});
