import { afterEach, describe, expect, it, vi } from "vitest";
import { hidConnect } from "./api";

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("hidConnect", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws the service's error code, so a refused pick is not taken for a connection", async () => {
    answer(503, { ok: false, error: "not_registered" });
    await expect(hidConnect("AA:BB")).rejects.toThrow("not_registered");
  });

  it("returns the body when the pick was accepted", async () => {
    answer(200, { ok: true, device: "Laptop" });
    await expect(hidConnect("AA:BB")).resolves.toMatchObject({ ok: true });
  });
});
