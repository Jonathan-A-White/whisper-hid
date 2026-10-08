import { describe, expect, it } from "vitest";
import source from "./TalkView.tsx?raw";

// The Talk screen is a full-height column: toggles in a scroll area on top,
// then a controls block at the foot holding the live words box and the bar,
// the bar last, just above the tab bar (under the thumb). There are no render
// tests for screens, so this checks the order the elements are written in.

const lines = source.split("\n");

function lineOf(needle: string): number {
  const at = lines.findIndex((line) => line.includes(needle));
  if (at < 0) throw new Error(`TalkView.tsx has no line with ${needle}`);
  return at + 1;
}

describe("TalkView layout", () => {
  const toggles = [
    "<TargetModeToggle",
    "<PhoneModeToggle",
    "<ZoomModeToggle",
    "Stop typing",
  ];

  it("puts the controls block after every toggle", () => {
    const controls = lineOf('data-testid="talk-controls"');
    for (const toggle of toggles) {
      expect(lineOf(toggle), toggle).toBeLessThan(controls);
    }
  });

  it("keeps the cooler switches off the Talk screen (they live in Settings)", () => {
    expect(source).not.toContain("<SymbolModeToggle");
    expect(source).not.toContain("<CleanupToggle");
  });

  it("puts Type clipboard right after Zoom mode, above the controls block", () => {
    const zoom = lineOf("<ZoomModeToggle");
    const clipboard = lineOf("<TypeClipboardButton");
    const controls = lineOf('data-testid="talk-controls"');
    expect(clipboard).toBeGreaterThan(zoom);
    expect(clipboard).toBeLessThan(controls);
  });

  it("puts the live words box, then the bar, inside the controls block", () => {
    const controls = lineOf('data-testid="talk-controls"');
    const live = lineOf('data-testid="live-transcript"');
    const bar = lineOf("rounded-3xl");
    expect(controls).toBeLessThan(live);
    expect(live).toBeLessThan(bar);
  });

  it("keeps the controls block at the foot, outside the scroll area", () => {
    expect(source).toMatch(
      /data-testid="talk-controls"[\s\S]*?className="[^"]*\bshrink-0\b[^"]*\bborder-t\b/
    );
    expect(lineOf("min-h-0 flex-1 overflow-y-auto")).toBeLessThan(
      lineOf('data-testid="talk-controls"')
    );
  });
});
