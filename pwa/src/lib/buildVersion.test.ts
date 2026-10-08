import { describe, expect, it } from "vitest";
import { buildVersion } from "./buildVersion";

describe("buildVersion", () => {
  it("carries the UTC build time after the version", () => {
    const when = new Date("2026-10-08T16:31:59Z");
    expect(buildVersion("1.0.142+ab12cd3", when)).toBe(
      "1.0.142+ab12cd3 · 2026-10-08 16:31Z"
    );
  });

  it("is in UTC whatever the zone of the build machine", () => {
    const when = new Date("2026-01-02T00:05:00+05:00");
    expect(buildVersion("1.0.1+x", when)).toBe("1.0.1+x · 2026-01-01 19:05Z");
  });
});
