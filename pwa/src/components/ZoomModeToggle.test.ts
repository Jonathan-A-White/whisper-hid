import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HidStatus } from "../types";
import { ZoomModeToggle } from "./ZoomModeToggle";

const NO_HEADSET = "No headset on the phone";
const RELEASED = "Headset mic released for your laptop";

function render(headsetMic: unknown): string {
  const status = (headsetMic === undefined ? {} : { headset_mic: headsetMic }) as HidStatus;
  return renderToStaticMarkup(createElement(ZoomModeToggle, { status, onToggle: vi.fn() }));
}

function pill(html: string): string {
  return html.match(/<button[^>]*>/)?.[0] ?? "";
}

describe("ZoomModeToggle", () => {
  it("with no headset and Zoom mode off: stays, greyed, and says why", () => {
    const html = render({ available: false, active: false, enabled: true });
    expect(html).toContain("Zoom mode off");
    expect(pill(html)).toContain('disabled=""');
    expect(html).toContain(NO_HEADSET);
  });

  it("with a headset and Zoom mode off: tappable, no note", () => {
    const html = render({ available: true, active: false, enabled: true });
    expect(html).toContain("Zoom mode off");
    expect(pill(html)).not.toContain("disabled");
    expect(html).not.toContain(NO_HEADSET);
    expect(html).not.toContain(RELEASED);
  });

  it("with no headset and Zoom mode on: tappable so it can be turned off, shows the released note", () => {
    const html = render({ available: false, active: false, enabled: false });
    expect(html).toContain("Zoom mode on");
    expect(pill(html)).not.toContain("disabled");
    expect(html).toContain(RELEASED);
    expect(html).not.toContain(NO_HEADSET);
  });

  it("renders nothing when the APK reports no headset_mic or no enabled flag", () => {
    expect(render(undefined)).toBe("");
    expect(render({ available: true, active: false })).toBe("");
  });
});
