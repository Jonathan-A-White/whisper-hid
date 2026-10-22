import { describe, expect, it } from "vitest";
import source from "./TalkView.tsx?raw";
import words from "./EntryWords.tsx?raw";
import statusBar from "./StatusBar.tsx?raw";
import app from "../App.tsx?raw";
import tailwindConfig from "../../tailwind.config.js?raw";

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

  // A short window (split screen, about 380 CSS px tall): the Hold to talk bar
  // must stay whole and large, so the stats line, an EMPTY words box, the
  // header and the padding give way first. The toggles stay reachable in the
  // scroll area above the controls block. The rule is a Tailwind `short:`
  // variant, a raw height media query declared in tailwind.config.js.
  describe("in a short window", () => {
    const classOf = (needle: string, span = 12): string => {
      const at = lineOf(needle);
      const found = lines
        .slice(at - 1, at - 1 + span)
        .join("\n")
        .match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
      if (!found) throw new Error(`no className near ${needle}`);
      return found[1] ?? found[2];
    };

    it("defines `short` as a max-height media query of 520px", () => {
      expect(tailwindConfig).toMatch(
        /short:\s*\{\s*raw:\s*"\(max-height:\s*520px\)"\s*\}/
      );
    });

    it("hides the stats line", () => {
      const stats = lineOf("lastStats && !lastError");
      expect(lines[stats]).toContain("short:hidden");
    });

    it("hides the live words box while it is empty, and shows it with words", () => {
      expect(source).toMatch(/const boxEmpty = !box && !lastError/);
      const cls = classOf('data-testid="live-transcript"', 6);
      expect(cls).toContain("boxEmpty");
      expect(cls).toContain("short:hidden");
    });

    it("keeps the bar at least 72px tall and never shrunk", () => {
      const cls = classOf("rounded-3xl", 5);
      expect(cls).toMatch(/\bmin-h-\[72px\]/);
      expect(cls).toMatch(/\bshrink-0\b/);
      expect(cls).toMatch(/\bshort:h-20\b/);
    });

    it("tightens the controls block and the scroll area", () => {
      expect(classOf('data-testid="talk-controls"', 3)).toMatch(/short:p[tb]-/);
      expect(classOf("min-h-0 flex-1 overflow-y-auto", 1)).toMatch(
        /short:p[tb]-/
      );
    });

    it("keeps the toggles in the scroll area, reachable by scrolling", () => {
      expect(lineOf("grid-cols-2")).toBeGreaterThan(
        lineOf("min-h-0 flex-1 overflow-y-auto")
      );
      expect(classOf("min-h-0 flex-1 overflow-y-auto", 1)).toContain(
        "overflow-y-auto"
      );
    });

    it("compacts the header and the tab bar", () => {
      expect(statusBar).toMatch(/short:py-\d/);
      expect(app).toMatch(/short:py-\d/);
    });
  });

  // A very short window (his split-screen half, about 175 CSS px): the header,
  // the tab bar and the padding shrink to a line each, the bar keeps 60px or
  // more. The real check is the Playwright render (`npm run test:layout`,
  // e2e/layout.e2e.ts); this only pins that the classes it relies on exist.
  describe("in a very short window", () => {
    it("defines `tiny` as a max-height media query of 300px, after `short`", () => {
      expect(tailwindConfig).toMatch(
        /tiny:\s*\{\s*raw:\s*"\(max-height:\s*300px\)"\s*\}/
      );
      expect(tailwindConfig.indexOf("short:")).toBeLessThan(
        tailwindConfig.indexOf("tiny:")
      );
    });

    it("shrinks the header (and its status banner) and the tab bar", () => {
      expect(statusBar).toMatch(/tiny:py-/);
      expect(statusBar).toMatch(/tiny:hidden/);
      expect(app).toMatch(/tiny:py-/);
    });

    it("keeps the bar at 60px or more, never shrunk, and drops its hint line", () => {
      const at = lineOf("rounded-3xl");
      const cls = lines.slice(at - 1, at + 4).join("\n");
      expect(cls).toMatch(/\btiny:h-16\b/);
      expect(cls).toMatch(/\btiny:min-h-\[60px\]/);
      expect(source).toMatch(/opacity-80 tiny:hidden/);
    });

    it("tightens the controls block, the words box and the scroll area", () => {
      expect(source).toMatch(/short:pb-2 tiny:gap-1 tiny:pt-1 tiny:pb-1/);
      expect(source).toMatch(/tiny:max-h-10/);
      expect(source).toMatch(/short:pb-2 tiny:pt-1 tiny:pb-1/);
    });
  });

  // Below about 200px (his split screen without the address bar, and less):
  // only Hold to talk remains. The header and the tab bar are hidden, the
  // button fills the window, a side handle opens the menu and shows the status,
  // and the status line is drawn over the button. Rendered check: e2e/layout.e2e.ts.
  describe("in a bare window", () => {
    it("defines `bare` (200px) and `mic` (60px) after `tiny`", () => {
      expect(tailwindConfig).toMatch(
        /bare:\s*\{\s*raw:\s*"\(max-height:\s*200px\)"\s*\}/
      );
      expect(tailwindConfig).toMatch(
        /mic:\s*\{\s*raw:\s*"\(max-height:\s*60px\)"\s*\}/
      );
      const at = (s: string) => tailwindConfig.indexOf(`${s}: {`);
      expect(at("tiny")).toBeLessThan(at("bare"));
      expect(at("bare")).toBeLessThan(at("mic"));
    });

    it("hides the header and the tab bar while collapsed", () => {
      expect(statusBar).toMatch(/bare:data-\[chrome=collapsed\]:hidden/);
      expect(app).toMatch(/data-chrome=/);
      expect(app).toMatch(/bare:data-\[chrome=collapsed\]:hidden/);
    });

    it("scales the button with the window and keeps 40px, the label going at 60px", () => {
      const at = lineOf("rounded-3xl");
      const cls = lines.slice(at - 1, at + 4).join("\n");
      expect(cls).toMatch(/\bbare:flex-1\b/);
      expect(cls).toMatch(/\bbare:min-h-\[40px\]/);
      expect(source).toMatch(/mic:hidden/);
    });

    it("draws the status line over the button, not as its own row", () => {
      const at = lineOf('data-testid="live-transcript"');
      const cls = lines.slice(at - 1, at + 6).join("\n");
      expect(cls).toMatch(/\bbare:absolute\b/);
      expect(cls).toMatch(/\bbare:pointer-events-none\b/);
    });

    it("has a handle with the status as its title, opening the menu", () => {
      expect(source).toContain('data-testid="menu-handle"');
      expect(source).toContain("collapsedStatus(");
    });
  });

  it("keeps no cut-off action row on the card", () => {
    expect(source).not.toContain("<HistoryActions");
  });

  it("does not let a long press select the card's words", () => {
    expect(source).toContain("<EntryWords");
    expect(words).toContain("select-none");
  });
});
