import { describe, expect, it } from "vitest";
import { clipboardTextToType } from "./clipboard";

const script = "Get-Date\r\nGet-Process\n  Get-Service  \n";
const lines = "Get-Date\nGet-Process\n  Get-Service";

describe("clipboardTextToType", () => {
  it("terminal keeps every line break whatever appendNewline says", () => {
    expect(clipboardTextToType(script, "terminal", { appendNewline: false })).toBe(lines);
    expect(clipboardTextToType(script, "terminal", { appendNewline: true })).toBe(lines);
  });

  it("terminal keeps blank lines between commands", () => {
    expect(clipboardTextToType("a\n\nb", "terminal", { appendNewline: false })).toBe("a\n\nb");
  });

  it("plain with appendNewline off flattens to one line", () => {
    expect(clipboardTextToType(script, "plain", { appendNewline: false })).toBe(
      "Get-Date Get-Process Get-Service"
    );
  });

  it("plain with appendNewline on keeps line breaks", () => {
    expect(clipboardTextToType(script, "plain", { appendNewline: true })).toBe(lines);
  });

  it("an unknown target (old server) behaves like plain", () => {
    expect(clipboardTextToType(script, null, { appendNewline: false })).toBe(
      "Get-Date Get-Process Get-Service"
    );
  });

  it("claude and codex keep line breaks", () => {
    for (const target of ["claude", "codex"] as const) {
      expect(clipboardTextToType(script, target, { appendNewline: false })).toBe(lines);
    }
  });
});
