import { describe, expect, it } from "vitest";
import source from "./SettingsView.tsx?raw";

// There are no render tests for screens, so this checks the order the
// elements are written in: the 'Talk options' section sits at the top of
// Settings, under the heading, ahead of 'Edit before send'.

const lines = source.split("\n");

function lineOf(needle: string): number {
  const at = lines.findIndex((line) => line.includes(needle));
  if (at < 0) throw new Error(`SettingsView.tsx has no line with ${needle}`);
  return at + 1;
}

describe("SettingsView Talk options", () => {
  it("opens with the heading, then Talk options, then Edit before send", () => {
    const heading = lineOf(">Settings</h2>");
    const section = lineOf("Talk options");
    const edit = lineOf("Edit before send");
    expect(heading).toBeLessThan(section);
    expect(section).toBeLessThan(edit);
  });

  it("holds Symbols and Cleanup under Talk options, and no Type clipboard", () => {
    const section = lineOf("Talk options");
    const edit = lineOf("Edit before send");
    for (const control of ["<SymbolModeToggle", "<CleanupToggle"]) {
      const at = lineOf(control);
      expect(at, control).toBeGreaterThan(section);
      expect(at, control).toBeLessThan(edit);
    }
    expect(source).not.toContain("TypeClipboardButton");
    expect(source).not.toContain("Type clipboard");
  });
});
