import { describe, expect, it } from "vitest";
import { connectErrorText } from "./connectError";

describe("connectErrorText", () => {
  it("not_registered says the keyboard isn't registered yet", () => {
    expect(connectErrorText("not_registered")).toBe("The keyboard isn't registered yet");
  });

  it("an unknown code is not shown raw", () => {
    expect(connectErrorText("connect_failed")).toBe("Couldn't connect to that device");
    expect(connectErrorText(undefined)).toBe("Couldn't connect to that device");
  });
});
