import { describe, expect, it } from "vitest";
import source from "./SettingsView.tsx?raw";
import settingsSection from "./SettingsSection.tsx?raw";
import settingsRow from "./SettingsRow.tsx?raw";
import symbolModeToggle from "./SymbolModeToggle.tsx?raw";
import cleanupToggle from "./CleanupToggle.tsx?raw";
import cleanupSettings from "./CleanupSettings.tsx?raw";
import symbolReplacements from "./SymbolReplacements.tsx?raw";
import wordCorrections from "./WordCorrections.tsx?raw";

// There are no render tests for screens, so this checks the source: the six
// section headings in order, one shared switch row for every on/off, and that
// each existing setting is still wired to its handler.

const lines = source.split("\n");

function lineOf(needle: string): number {
  const at = lines.findIndex((line) => line.includes(needle));
  if (at < 0) throw new Error(`SettingsView.tsx has no line with ${needle}`);
  return at + 1;
}

const SECTIONS = [
  "Talk",
  "Typing",
  "Speech",
  "Cleanup",
  "Corrections and symbols",
  "About",
];

describe("SettingsView sections", () => {
  it("opens with the heading, then the six section headings in order", () => {
    const heading = lineOf(">Settings</h2>");
    const at = SECTIONS.map((name) => lineOf(`<SettingsSection title="${name}"`));
    expect(heading).toBeLessThan(at[0]);
    for (let i = 1; i < at.length; i++) expect(at[i - 1]).toBeLessThan(at[i]);
  });

  it("has exactly six sections", () => {
    expect(source.match(/<SettingsSection\b/g)).toHaveLength(SECTIONS.length);
  });

  it("holds Symbols and Cleanup in Talk, and no Type clipboard", () => {
    const talk = lineOf('<SettingsSection title="Talk"');
    const typing = lineOf('<SettingsSection title="Typing"');
    for (const control of ["<SymbolModeToggle", "<CleanupToggle"]) {
      const at = lineOf(control);
      expect(at, control).toBeGreaterThan(talk);
      expect(at, control).toBeLessThan(typing);
    }
    expect(source).not.toContain("TypeClipboardButton");
    expect(source).not.toContain("Type clipboard");
  });

  it("puts the version lines in About, at the foot", () => {
    const about = lineOf('<SettingsSection title="About"');
    expect(lineOf("__APP_VERSION__")).toBeGreaterThan(about);
    expect(lineOf("HID service")).toBeGreaterThan(about);
  });
});

describe("SettingsView switches", () => {
  it("has no raw checkbox inputs", () => {
    expect(source).not.toContain('type="checkbox"');
    for (const other of [symbolModeToggle, cleanupToggle, symbolReplacements]) {
      expect(other).not.toContain('type="checkbox"');
    }
  });

  it("uses the shared switch row for every on/off", () => {
    expect(source.match(/<SettingsSwitchRow\b/g)!.length).toBeGreaterThanOrEqual(6);
    expect(settingsRow).toContain('role="switch"');
    expect(symbolModeToggle).toContain("SettingsSwitchRow");
    expect(cleanupToggle).toContain("SettingsSwitchRow");
  });

  it("keeps every touch target at least 44px", () => {
    expect(settingsRow).toContain("min-h-[44px]");
    expect(settingsRow).toContain("min-w-[44px]");
  });

  it("binds the symbols setting to exactly one switch row", () => {
    // SettingsView and its children: the only switch on the setting is the
    // Talk card's SymbolModeToggle; the replacement list has none.
    const children = [
      source,
      symbolModeToggle,
      symbolReplacements,
      wordCorrections,
      cleanupToggle,
      cleanupSettings,
    ];
    const writers = children.filter((c) => /putSymbols\(\s*\{\s*enabled/.test(c));
    expect(writers).toEqual([symbolModeToggle]);
    expect(symbolModeToggle.match(/<SettingsSwitchRow\b/g)).toHaveLength(1);
    expect(symbolReplacements).not.toContain("SettingsSwitchRow");
    expect(symbolReplacements).not.toContain("Symbol mode");
    expect(symbolReplacements).not.toMatch(/config\.enabled/);
  });

  it("gives the delete buttons of both lists a 44px hit area", () => {
    for (const [name, list] of [
      ["WordCorrections", wordCorrections],
      ["SymbolReplacements", symbolReplacements],
    ] as const) {
      const button = list.match(/<button\s+onClick=\{\(\) => handleRemove[^>]*>/);
      expect(button, name).not.toBeNull();
      expect(button![0], name).toContain("min-h-[44px]");
      expect(button![0], name).toContain("min-w-[44px]");
    }
  });
});

describe("SettingsView settings are still wired", () => {
  it("reads and writes each stored setting", () => {
    for (const key of [
      "settings.editBeforeSend",
      "editBeforeSend:",
      "settings.appendNewline",
      "appendNewline:",
      "settings.appendSpace",
      "appendSpace:",
      "settings.newlineAfterEnd",
      "newlineAfterEnd:",
      "settings.keystrokeDelay",
      "keystrokeDelay:",
      "settings.language",
      "language:",
    ]) {
      expect(source, key).toContain(key);
    }
  });

  it("keeps the server-side handlers", () => {
    for (const call of [
      "hidKeepLinkWarm(",
      "putWhisperSettings({ noise_reduction",
      "mic_audio_source: source",
      "<CleanupSettings",
      "<WordCorrections",
      "<SymbolReplacements",
    ]) {
      expect(source, call).toContain(call);
    }
    expect(symbolModeToggle).toContain("putSymbols({ enabled");
    expect(cleanupToggle).toContain("putCleanup({ enabled");
    expect(cleanupToggle).toContain("putCleanup({ style");
    expect(cleanupSettings).toContain("putCleanup({ model");
  });

  it("keeps the two mutually exclusive newline/space switches exclusive", () => {
    expect(source).toContain("appendSpace: e ? false : settings.appendSpace");
    expect(source).toContain("appendNewline: e ? false : settings.appendNewline");
  });
});

describe("SettingsSection and SettingsRow", () => {
  it("section is a small uppercase heading above a rounded card", () => {
    expect(settingsSection).toContain("uppercase");
    expect(settingsSection).toContain("rounded-xl");
  });

  it("row shows a grey hint under the label and an 'i' for longer text", () => {
    expect(settingsRow).toContain("hint");
    expect(settingsRow).toContain("info");
    expect(settingsRow).toContain("aria-expanded");
  });
});
