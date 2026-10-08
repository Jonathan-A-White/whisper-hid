import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EntryMenu } from "./EntryMenu";
import menuSource from "./EntryMenu.tsx?raw";

const props = {
  onSend: vi.fn(),
  onCopy: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onClose: vi.fn(),
};

function labelsIn(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
}

describe("EntryMenu", () => {
  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(createElement(EntryMenu, { ...props, open: false }))).toBe("");
  });

  it("when open lists Send, Copy, Edit, Delete, Cancel in order", () => {
    const html = renderToStaticMarkup(createElement(EntryMenu, { ...props, open: true }));
    expect(labelsIn(html)).toEqual(["Send", "Copy", "Edit", "Delete", "Cancel"]);
  });

  it("greys Send when sendDisabled", () => {
    const html = renderToStaticMarkup(
      createElement(EntryMenu, { ...props, open: true, sendDisabled: true })
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/);
  });

  it("is a bottom sheet over everything, closed by a tap outside, clear of the nav bar", () => {
    expect(menuSource).toContain("fixed inset-0");
    expect(menuSource).toContain("items-end");
    expect(menuSource).toContain("onClose");
    expect(menuSource).toContain("var(--bar-inset)");
    expect(menuSource).toContain("min-h-[44px]");
  });
});
