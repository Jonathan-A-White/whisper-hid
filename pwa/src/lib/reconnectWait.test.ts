import { describe, expect, it } from "vitest";
import { downLongEnoughToCheckComputer, estimatedDownSeconds } from "./reconnectWait";

describe("reconnectWait", () => {
  it("follows the service's schedule: 60 s after five attempts, 30 s steps to five minutes", () => {
    expect(estimatedDownSeconds(5)).toBe(60);
    expect(estimatedDownSeconds(13)).toBe(300);
    expect(estimatedDownSeconds(14)).toBe(360);
  });

  it("attempt 11 is about four minutes, attempt 109 well past ten", () => {
    expect(estimatedDownSeconds(11)).toBe(240);
    expect(downLongEnoughToCheckComputer(11)).toBe(false);
    expect(downLongEnoughToCheckComputer(109)).toBe(true);
  });

  it("switches over just past ten minutes (attempt 18 is exactly ten, 19 is past)", () => {
    expect(downLongEnoughToCheckComputer(18)).toBe(false);
    expect(downLongEnoughToCheckComputer(19)).toBe(true);
  });

  it("an older APK that reports no attempt gets no extra line", () => {
    expect(downLongEnoughToCheckComputer(undefined)).toBe(false);
  });
});
