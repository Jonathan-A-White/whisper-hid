import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HidStatus } from "../types";
import { StatusBar } from "./StatusBar";

function render(hidStatus: Partial<HidStatus> | null, hidReachable = true): string {
  return renderToStaticMarkup(
    createElement(StatusBar, {
      hidStatus: hidStatus as HidStatus | null,
      hidReachable,
      whisperStatus: null,
      whisperError: null,
      onRestart: vi.fn(),
      onShowDebug: vi.fn(),
      chrome: "menu",
    }),
  );
}

const BANNER_TEXT = "Bluetooth keyboard not set up";

describe("StatusBar banner", () => {
  it("idle (HID reachable): says the keyboard is not set up, with Restart HID and View Debug Log", () => {
    const html = render({ service: "running", bluetooth: "idle" });
    expect(html).toContain(BANNER_TEXT);
    expect(html).toContain("Restart HID");
    expect(html).toContain("View Debug Log");
  });

  it("idle and Android is not answering: says so in plain words, with Restart HID", () => {
    const html = render({ service: "running", bluetooth: "idle", registration_problem: "no_answer" });
    expect(html).toContain("Android isn&#x27;t answering. Restart the phone, then open Whisper HID.");
    expect(html).not.toContain(BANNER_TEXT);
    expect(html).toContain("Restart HID");
  });

  it("failed: still says why it stopped, with both buttons", () => {
    const html = render({ service: "running", bluetooth: "failed", failure_reason: "Bluetooth is off" });
    expect(html).toContain("Not connected — Bluetooth is off");
    expect(html).toContain("Restart HID");
    expect(html).toContain("View Debug Log");
  });

  it("registered: waiting for a computer, with a way out", () => {
    const html = render({ service: "running", bluetooth: "registered" });
    expect(html).toContain("Waiting for a computer");
    expect(html).toContain("Restart HID");
    expect(html).toContain("View Debug Log");
  });

  it("reconnecting: shows the retry and offers Restart HID", () => {
    const html = render({
      service: "running",
      bluetooth: "reconnecting",
      reconnect_attempt: 2,
      next_retry_seconds: 4,
    });
    expect(html).toContain("Reconnecting…");
    expect(html).toContain("Restart HID");
  });

  it("connected: no banner", () => {
    const html = render({ service: "running", bluetooth: "connected", device: "Laptop" });
    expect(html).not.toContain("Restart HID");
    expect(html).not.toContain(BANNER_TEXT);
  });

  it("HID service unreachable: the open-the-app hint, no Restart button", () => {
    const html = render(null, false);
    expect(html).toContain("HID Service not running.");
    expect(html).not.toContain("Restart HID");
    expect(html).not.toContain(BANNER_TEXT);
  });
});
