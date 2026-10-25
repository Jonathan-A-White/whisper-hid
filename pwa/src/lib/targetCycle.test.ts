import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TargetInfo } from "../types";
import { TargetModeToggle } from "../components/TargetModeToggle";
import { nextTarget } from "./targetCycle";

const TARGETS: TargetInfo[] = [
  { name: "plain", label: "Plain text", description: "Real Enter", newline_mode: "enter" },
  { name: "chat", label: "Chat", description: "Shift+Enter", newline_mode: "shift_enter" },
  { name: "claude", label: "Claude Code", description: "Backslash Enter", newline_mode: "backslash_enter" },
  { name: "codex", label: "Codex", description: "Ctrl+J", newline_mode: "ctrl_j" },
  { name: "terminal", label: "Terminal", description: "Real Enter", newline_mode: "enter" },
];

describe("nextTarget", () => {
  it("cycles plain -> chat -> claude -> codex -> terminal -> plain", () => {
    const seen: string[] = [];
    let current = TARGETS[0].name;
    for (let i = 0; i < 5; i++) {
      current = nextTarget(TARGETS, current).name;
      seen.push(current);
    }
    expect(seen).toEqual(["chat", "claude", "codex", "terminal", "plain"]);
  });

  it("starts from the first entry when the current target is unknown", () => {
    expect(nextTarget(TARGETS, "emacs" as never).name).toBe("chat");
  });
});

describe("TargetModeToggle with the chat target", () => {
  it("shows 'Typing to Chat'", () => {
    const html = renderToStaticMarkup(
      createElement(TargetModeToggle, { target: "chat", targets: TARGETS, onSelect: vi.fn() })
    );
    expect(html).toContain("Typing to Chat");
  });
});
