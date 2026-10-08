import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import banner from "./UpdateBanner.tsx?raw";

describe("UpdateBanner placement", () => {
  it("sits at the top of the app, above the status bar and the Talk screen", () => {
    const b = app.indexOf("<UpdateBanner");
    expect(b).toBeGreaterThan(-1);
    expect(b).toBeLessThan(app.indexOf("<StatusBar"));
    expect(b).toBeLessThan(app.indexOf("<main"));
  });

  it("says the two things it says", () => {
    expect(banner).toContain("Update ready, tap to reload");
    expect(banner).toContain("Updating…");
  });
});
