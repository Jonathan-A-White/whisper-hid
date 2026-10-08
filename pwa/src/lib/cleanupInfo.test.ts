import { describe, expect, it } from "vitest";
import { CLEANUP_INFO } from "./cleanupInfo";
import toggle from "../components/CleanupToggle.tsx?raw";
import settings from "../components/CleanupSettings.tsx?raw";
import infoButton from "../components/CleanupInfo.tsx?raw";

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
  it("CleanupToggle renders the info button", () => {
    expect(toggle).toContain("<CleanupInfo");
  });

  it("CleanupSettings renders the info button beside its heading", () => {
    expect(settings).toContain("<CleanupInfo");
    expect(settings.indexOf("Speech cleanup model")).toBeLessThan(
      settings.indexOf("<CleanupInfo"),
    );
  });

  it("the button toggles the shared text", () => {
    expect(infoButton).toContain("CLEANUP_INFO");
    expect(infoButton).toContain("aria-expanded");
  });
});
