import { describe, expect, it } from "vitest";
import source from "./TalkView.tsx?raw";
import words from "./EntryWords.tsx?raw";

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

  it("holds the four controls in one two-column grid, Stop typing above it", () => {
    const grid = lineOf("grid-cols-2");
    const end = lineOf("end of chip grid");
    expect(lineOf("Stop typing")).toBeLessThan(grid);
    for (const chip of [
      "<TargetModeToggle",
      "<PhoneModeToggle",
      "<ZoomModeToggle",
      "<TypeClipboardButton",
    ]) {
      expect(lineOf(chip), chip).toBeGreaterThan(grid);
      expect(lineOf(chip), chip).toBeLessThan(end);
    }
    expect(lines[grid - 1].match(/className="([^"]*)"/)![1]).toContain("grid ");
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

  // The last transcript card must render whole above the Hold to talk bar.
  // The bar's block is a sibling after the scroll area, not an overlay, so the
  // card (inside the scroll area) can never lie below the bar's top, provided:
  // the card is written inside the scroll area, the controls block is not
  // positioned over it, and the scroll area ends with room under the card.
  it("renders the last transcript card whole above the bar", () => {
    const scroll = lineOf("min-h-0 flex-1 overflow-y-auto");
    const card = lineOf('data-testid="front-message"');
    const controls = lineOf('data-testid="talk-controls"');
    expect(scroll).toBeLessThan(card);
    expect(card).toBeLessThan(controls);

    const controlsClass = lines
      .slice(controls - 1, controls + 3)
      .join("\n")
      .match(/className="([^"]*)"/)![1];
    for (const overlay of ["fixed", "absolute", "sticky"]) {
      expect(controlsClass.split(/\s+/), overlay).not.toContain(overlay);
    }
    expect(controlsClass).toContain("shrink-0");

    const scrollClass = lines[scroll - 1].match(/className="([^"]*)"/)![1];
    expect(scrollClass).toMatch(/\bpb-\d+\b/);
  });

  it("keeps no cut-off action row on the card", () => {
    expect(source).not.toContain("<HistoryActions");
  });

  it("does not let a long press select the card's words", () => {
    expect(source).toContain("<EntryWords");
    expect(words).toContain("select-none");
  });
});
