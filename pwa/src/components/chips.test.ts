import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HidStatus, TargetInfo } from "../types";
import { TargetModeToggle } from "./TargetModeToggle";
import { PhoneModeToggle } from "./PhoneModeToggle";
import { ZoomModeToggle } from "./ZoomModeToggle";
import { TypeClipboardButton } from "./TypeClipboardButton";

// The four controls under "Connected to" are one even group: every chip has
// the same shape classes and differs from the others only in its accent.

const SHAPE = ["w-full", "py-2", "rounded-xl", "text-sm", "font-medium"];
const REST = ["bg-gray-800", "text-gray-300"];

const targets: TargetInfo[] = [
  { name: "plain", label: "Plain text", description: "", newline_mode: "enter" },
  { name: "claude", label: "Claude Code", description: "", newline_mode: "backslash_enter" },
];

function zoomStatus(enabled: boolean): HidStatus {
  return { headset_mic: { available: true, active: false, enabled } } as HidStatus;
}

function chipClasses(element: Parameters<typeof renderToStaticMarkup>[0]): string[] {
  const html = renderToStaticMarkup(element);
  const cls = html.match(/<button[^>]*class="([^"]*)"/)![1];
  return cls.split(/\s+/);
}

const noop = vi.fn();
const clipboard = createElement(TypeClipboardButton, {
  target: "plain",
  settings: { appendNewline: false, newlineAfterEnd: false },
  hid: { sendText: async () => true, sendNewline: async () => {} },
  store: { addEntry: async () => {} },
});

const resting = {
  target: chipClasses(
    createElement(TargetModeToggle, { target: "plain", targets, onSelect: noop })
  ),
  phone: chipClasses(
    createElement(PhoneModeToggle, { sendTo: "computer", onChange: noop })
  ),
  zoom: chipClasses(createElement(ZoomModeToggle, { status: zoomStatus(true), onToggle: noop })),
  clipboard: chipClasses(clipboard),
};

const on = {
  target: chipClasses(
    createElement(TargetModeToggle, { target: "claude", targets, onSelect: noop })
  ),
  phone: chipClasses(createElement(PhoneModeToggle, { sendTo: "phone", onChange: noop })),
  zoom: chipClasses(createElement(ZoomModeToggle, { status: zoomStatus(false), onToggle: noop })),
};

describe("Talk chips", () => {
  it("share the same width, height and shape classes, resting or on", () => {
    for (const [name, cls] of [...Object.entries(resting), ...Object.entries(on)]) {
      for (const c of SHAPE) expect(cls, name).toContain(c);
    }
  });

  it("rest in one style", () => {
    for (const [name, cls] of Object.entries(resting)) {
      for (const c of REST) expect(cls, name).toContain(c);
    }
  });

  it("differ only in the accent when on", () => {
    expect(on.target).toContain("bg-sky-600");
    expect(on.phone).toContain("bg-violet-600");
    expect(on.zoom).toContain("bg-violet-600");
    for (const cls of Object.values(on)) {
      for (const c of REST) expect(cls).not.toContain(c);
    }
    const shape = (cls: string[]) => cls.filter((c) => SHAPE.includes(c)).sort();
    const first = shape(on.target);
    for (const cls of [...Object.values(on), ...Object.values(resting)]) {
      expect(shape(cls)).toEqual(first);
    }
  });
});
