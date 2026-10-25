import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTarget } from "../lib/api";
import type { TargetInfo, TargetState } from "../types";
import { TargetModeToggle } from "./TargetModeToggle";

const TARGETS: TargetInfo[] = [
  { name: "plain", label: "Plain text", description: "Real Enter", newline_mode: "enter" },
  { name: "claude", label: "Claude Code", description: "Backslash Enter", newline_mode: "backslash_enter" },
];

const STATE: TargetState = {
  target: "claude",
  newline_mode: "backslash_enter",
  targets: TARGETS,
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** What the Talk screen shows for a /target call: the hook's job, with the real client. */
async function chipFor(fetchImpl: typeof fetch): Promise<string> {
  vi.stubGlobal("fetch", fetchImpl);
  let state: TargetState | null = null;
  let error: string | null = null;
  try {
    state = await getTarget();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return renderToStaticMarkup(
    createElement(TargetModeToggle, {
      target: state?.target ?? null,
      targets: state?.targets ?? [],
      error,
      onSelect: vi.fn(),
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("TargetModeToggle with the real /target client", () => {
  it("shows 'Typing to <label>' when /target answers", async () => {
    const html = await chipFor(async () => reply(200, STATE));
    expect(html).toContain("Typing to Claude Code");
    expect(html).not.toContain("Target unknown");
  });

  it("shows 'Target unknown: <reason>' when the server is too old (404)", async () => {
    const html = await chipFor(async () => reply(404, { error: "not_found" }));
    expect(html).toContain("Target unknown: ");
    expect(html).toContain("404");
  });

  it("shows 'Target unknown: <reason>' when the fetch itself fails", async () => {
    const html = await chipFor(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(html).toContain("Target unknown: ");
    expect(html).toContain("Failed to fetch");
  });

  it("shows 'Target unknown: <reason>' when the reply has no target list", async () => {
    const html = await chipFor(async () => reply(200, { target: "claude" }));
    expect(html).toContain("Target unknown: ");
  });

  it("shows nothing only while loading (no target, no error)", () => {
    const html = renderToStaticMarkup(
      createElement(TargetModeToggle, { target: null, targets: [], error: null, onSelect: vi.fn() })
    );
    expect(html).toBe("");
  });
});
