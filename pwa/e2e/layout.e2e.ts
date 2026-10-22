import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// The built PWA in a real Chromium at his split-screen sizes. The vitest layout
// tests only read class names from source; this one renders the page and asks
// the browser where the Hold to talk button really is and what is on top of it.
// Run it with `npm run test:layout` (builds dist/, serves it with vite preview).

const SHOTS = "layout-shots";
const WIDTH = 412;
const HEIGHTS = [240, 380, 900];
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
async function openApp(
  page: Page,
  width: number,
  height: number,
  extra: Record<string, unknown> = {}
) {
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
      // /status is faked (and whatever `extra` names); every other call fails
      // as if the endpoint were absent
      const path = new URL(req.url()).pathname;
      const body = path === "/status" ? status : extra[path];
      if (body === undefined) return route.abort("connectionrefused");
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: "application/json",
        body: JSON.stringify(body),
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
  await page.getByTestId("menu-handle").click(); // 175 is collapsed: open the menu
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
  await page.getByTestId("menu-handle").click();
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
  await page.getByTestId("menu-handle").click();
  await page.getByRole("button", { name: "settings", exact: true }).click();
  const firstRow = page.locator("main section").first().locator("xpath=./div/*[1]");
  await expect(firstRow).toBeAttached();
  await page.screenshot({ path: `${SHOTS}/settings-${WIDTH}x175.png` });
  await expectReachable(page, firstRow, "Settings first row");
});

// ---------------------------------------------------------------------------
// Bare windows (under 200px tall: his split screen, and less): only Hold to
// talk remains. No header, no tab bar; the button fills the window with a 4px
// margin; a small handle beside it shows the status and opens the menu.

const MARGIN = 4;
const HANDLE = "menu-handle";
const handle = (page: Page) => page.getByTestId(HANDLE);

/** What is at (x, y): the Hold to talk button, or something that is not a control. */
function hitsButtonOrBackground(page: Page, x: number, y: number) {
  return holdToTalk(page).evaluate(
    (el, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      if (hit === null || el.contains(hit)) return true;
      return hit.closest("button, a, nav, input, select, textarea, header") === null;
    },
    { x, y }
  );
}

test("Bare, 412x175: only Hold to talk (and its handle) is on screen", async ({
  page,
}) => {
  const errors = await openApp(page, WIDTH, 175);
  const bar = holdToTalk(page);
  await expect(bar).toBeVisible();
  await expect(handle(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/bare-${WIDTH}x175.png` });

  // no header, no tab bar
  await expect(page.locator("nav")).toBeHidden();
  await expect(page.getByText("Whisper Keyboard", { exact: true })).toBeHidden();
  // the only visible buttons are Hold to talk and the handle beside it
  const visible: string[] = [];
  for (const b of await page.getByRole("button").all()) {
    if (await b.isVisible()) visible.push((await b.getAttribute("data-testid")) ?? "?");
  }
  expect(visible.sort()).toEqual([HANDLE, "talk-bar"]);

  // whole, with 8px or less above and below
  const b = await box(bar);
  expect(b.y, "margin above").toBeLessThanOrEqual(8);
  expect(175 - (b.y + b.height), "margin below").toBeLessThanOrEqual(8);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(WIDTH);

  // the top and bottom rows of the viewport hit the button or the background
  for (const y of [1, 2, 3, 175 - 2, 175 - 3, 175 - 4]) {
    for (let x = 0; x < WIDTH; x += 16) {
      expect(await hitsButtonOrBackground(page, x, y), `(${x}, ${y})`).toBe(true);
    }
  }
  // and nothing covers the button itself
  for (const [x, y] of [
    [b.x + b.width / 2, b.y + b.height / 2],
    [b.x + 20, b.y + 20],
    [b.x + b.width - 20, b.y + b.height - 20],
  ]) {
    expect(await topmostIsInside(page, bar, x, y)).toBe(true);
  }
  expect(errors).toEqual([]);
});

for (const height of [120, 90]) {
  test(`Bare, ${WIDTH}x${height}: the button fills the window and is whole`, async ({
    page,
  }) => {
    await openApp(page, WIDTH, height);
    const bar = holdToTalk(page);
    await expect(bar).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/bare-${WIDTH}x${height}.png` });
    const b = await box(bar);
    measured.push(`${WIDTH}x${height}: x=${b.x} y=${b.y} width=${b.width} height=${b.height}`);
    expect(b.y, "top").toBeGreaterThanOrEqual(0);
    expect(b.y, "margin above").toBeLessThanOrEqual(8);
    expect(height - (b.y + b.height), "margin below").toBeGreaterThanOrEqual(0);
    expect(height - (b.y + b.height), "margin below").toBeLessThanOrEqual(8);
    expect(b.height, "height is the window minus the margins").toBeGreaterThanOrEqual(
      height - 2 * MARGIN - 1
    );
    expect(b.x + b.width).toBeLessThanOrEqual(WIDTH);
    // the label is still there at these heights
    await expect(bar.getByText(/hold to talk/i)).toBeVisible();
  });
}

test("Bare, 412x52: the label gives way to the mic alone, at 40px or more", async ({
  page,
}) => {
  await openApp(page, WIDTH, 52);
  const bar = holdToTalk(page);
  await expect(bar).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/bare-${WIDTH}x52.png` });
  const b = await box(bar);
  expect(b.height).toBeGreaterThanOrEqual(40);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height).toBeLessThanOrEqual(52);
  await expect(bar.getByText(/hold to talk/i)).toBeHidden();
  await expect(bar.locator("svg")).toBeVisible();
  // the button is still named for a screen reader
  await expect(bar).toHaveAccessibleName(/hold to talk/i);
});

for (const height of [175, 90]) {
  for (const phase of ["Listening…", "No speech detected"]) {
    test(`Bare, ${WIDTH}x${height}: '${phase}' is drawn over the button, which stays whole`, async ({
      page,
    }) => {
      await openApp(page, WIDTH, height, {
        "/transcribe/start": { status: "recording" },
        "/transcribe/stop": { text: "" },
        "/dictation": { connected: true },
      });
      // the label changes while recording, so find the button by its test id
      const bar = page.getByTestId("talk-bar");
      await expect(holdToTalk(page)).toBeVisible();
      await bar.click(); // a tap keeps the recording on
      const line = page.getByTestId("live-transcript");
      await expect(line).toHaveText("Listening…");
      if (phase !== "Listening…") {
        await bar.click(); // the second tap stops it: nothing was said
        await expect(line).toHaveText("No speech detected");
      }
      await page.screenshot({
        path: `${SHOTS}/bare-line-${phase.startsWith("L") ? "listening" : "nospeech"}-${WIDTH}x${height}.png`,
      });

      const b = await box(bar);
      const l = await box(line);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height, "bottom").toBeLessThanOrEqual(height);
      expect(b.height, "height").toBeGreaterThanOrEqual(height - 2 * MARGIN - 1);
      // the line sits inside the button's area, not in a row of its own
      expect(l.x).toBeGreaterThanOrEqual(b.x - 1);
      expect(l.y).toBeGreaterThanOrEqual(b.y - 1);
      expect(l.x + l.width).toBeLessThanOrEqual(b.x + b.width + 1);
      expect(l.y + l.height).toBeLessThanOrEqual(b.y + b.height + 1);
      // and the button's centre is still the button (the line takes no touches)
      expect(await topmostIsInside(page, bar, b.x + b.width / 2, b.y + b.height / 2)).toBe(true);
    });
  }
}

test("Bare, 412x175: the handle reads the status and opens History and Settings", async ({
  page,
}) => {
  await openApp(page, WIDTH, 175);
  const h = handle(page);
  await expect(h).toBeVisible();
  // the status (model and connection) is readable on the handle
  await expect(h).toHaveAttribute("title", /parakeet-tdt-0\.6b-v2/);
  await expect(h).toHaveAttribute("title", /PF46SGM4/);
  await expect(h).toHaveAccessibleName(/parakeet-tdt-0\.6b-v2.*PF46SGM4/);

  for (const tab of ["history", "settings"]) {
    await h.click();
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.getByText("Whisper Keyboard", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/bare-menu-${WIDTH}x175.png` });
    await page.getByRole("button", { name: tab, exact: true }).click();
    if (tab === "history") {
      await expectReachable(page, page.getByText("No transcriptions yet"), "History");
    } else {
      const firstRow = page.locator("main section").first().locator("xpath=./div/*[1]");
      await expectReachable(page, firstRow, "Settings first row");
    }
    // Talk is the way back to the bare button
    await page.getByRole("button", { name: "talk", exact: true }).click();
    await expect(page.locator("nav")).toBeHidden();
    await expect(holdToTalk(page)).toBeVisible();
  }
});

// Sweep: what the other tabs do at 90px
test("History, 412x90: the empty state is reachable", async ({ page }) => {
  await openApp(page, WIDTH, 90);
  await handle(page).click();
  await page.getByRole("button", { name: "history", exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/history-empty-${WIDTH}x90.png` });
  await expectReachable(page, page.getByText("No transcriptions yet"), "History at 90");
});

test("Settings, 412x90: the first row is reachable", async ({ page }) => {
  await openApp(page, WIDTH, 90);
  await handle(page).click();
  await page.getByRole("button", { name: "settings", exact: true }).click();
  const firstRow = page.locator("main section").first().locator("xpath=./div/*[1]");
  await page.screenshot({ path: `${SHOTS}/settings-${WIDTH}x90.png` });
  await expectReachable(page, firstRow, "Settings first row at 90");
});
