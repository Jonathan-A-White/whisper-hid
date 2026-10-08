import { describe, expect, it } from "vitest";
import { CLEANUP_INFO } from "./cleanupInfo";
import toggle from "../components/CleanupToggle.tsx?raw";
import settings from "../components/CleanupSettings.tsx?raw";
import row from "../components/SettingsRow.tsx?raw";

describe("CLEANUP_INFO", () => {
  it("names the transcript rewrite", () => {
    expect(CLEANUP_INFO).toMatch(/rewrites the finished transcript/i);
    expect(CLEANUP_INFO).toMatch(/ums/);
    expect(CLEANUP_INFO).toMatch(/punctuation/);
  });

  it("names the styles", () => {
    for (const style of ["commit message", "email", "bug report"]) {
      expect(CLEANUP_INFO).toContain(style);
    }
  });

  it("says it is off by default and adds a few seconds after Stop", () => {
    expect(CLEANUP_INFO).toContain("off by default");
    expect(CLEANUP_INFO).toMatch(/few seconds after Stop/);
  });

  it("says the same model powers Suggest corrections", () => {
    expect(CLEANUP_INFO).toContain("Suggest corrections");
  });
});

describe("info button placement", () => {
  it("CleanupToggle gives the shared text to its row's info button", () => {
    expect(toggle).toContain("info={CLEANUP_INFO}");
  });

  it("CleanupSettings gives the shared text to the row headed Speech cleanup model", () => {
    expect(settings).toContain("info={CLEANUP_INFO}");
    expect(settings).toContain('label="Speech cleanup model"');
  });

  it("the row's 'i' button toggles the text", () => {
    expect(row).toContain("aria-expanded");
    expect(row).toContain("setOpen");
  });
});
