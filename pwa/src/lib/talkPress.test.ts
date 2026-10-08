import { describe, expect, it } from "vitest";
import {
  IDLE,
  LATCH_MS,
  cancel,
  press,
  release,
  talkLabel,
  type PressState,
} from "./talkPress";

/** Runs a press at t0 and a release at t0 + heldMs. */
function tap(state: PressState, heldMs: number, t0 = 1000) {
  const down = press(state, t0);
  const up = release(down.state, t0 + heldMs);
  return { down, up };
}

describe("hold", () => {
  it("starts on press and stops on release after 1200 ms", () => {
    const { down, up } = tap(IDLE, 1200);
    expect(down.action).toBe("start");
    expect(down.state.phase).toBe("held");
    expect(up.action).toBe("stop");
    expect(up.state.phase).toBe("idle");
  });

  it("a release at exactly the latch time is still a hold", () => {
    expect(tap(IDLE, LATCH_MS).up.action).toBe("stop");
  });

  it("a repeated press while held (key repeat) does nothing", () => {
    const down = press(IDLE, 0);
    const again = press(down.state, 30);
    expect(again.action).toBe("none");
    expect(again.state).toBe(down.state);
  });

  it("pointercancel while held stops, even for a short press", () => {
    const down = press(IDLE, 0);
    const c = cancel(down.state);
    expect(c.action).toBe("stop");
    expect(c.state.phase).toBe("idle");
  });
});

describe("latch", () => {
  it("a press released at 200 ms leaves the recording on", () => {
    const { up } = tap(IDLE, 200);
    expect(up.action).toBe("none");
    expect(up.state.phase).toBe("latched");
  });

  it("a second press and release stops", () => {
    const first = tap(IDLE, 200).up.state;
    const second = tap(first, 80, 5000);
    expect(second.down.action).toBe("none");
    expect(second.down.state.phase).toBe("tapStop");
    expect(second.up.action).toBe("stop");
    expect(second.up.state.phase).toBe("idle");
  });

  it("the second tap stops however long it is held", () => {
    const first = tap(IDLE, 200).up.state;
    expect(tap(first, 3000, 5000).up.action).toBe("stop");
  });

  it("pointercancel on the stopping tap stops; on a latched recording it does nothing", () => {
    const latched = tap(IDLE, 200).up.state;
    expect(cancel(latched).action).toBe("none");
    expect(cancel(press(latched, 5000).state).action).toBe("stop");
  });
});

describe("stray events when idle", () => {
  it("release and cancel with nothing pressed do nothing", () => {
    expect(release(IDLE, 10).action).toBe("none");
    expect(cancel(IDLE).action).toBe("none");
  });
});

describe("labels", () => {
  const base = { micOpen: true, transcribing: false, phoneMode: false };

  it("idle: Hold to talk with the tap hint", () => {
    expect(talkLabel({ ...base, phase: "idle" })).toEqual({
      label: "Hold to talk",
      sub: "tap to keep it on",
    });
  });

  it("Starting the mic… until the server has answered", () => {
    expect(talkLabel({ ...base, phase: "held", micOpen: false }).label).toBe(
      "Starting the mic…"
    );
    expect(talkLabel({ ...base, phase: "latched", micOpen: false }).label).toBe(
      "Starting the mic…"
    );
  });

  it("held: Release to type, or Release to send on This phone", () => {
    expect(talkLabel({ ...base, phase: "held" }).label).toBe("Release to type");
    expect(talkLabel({ ...base, phase: "held", phoneMode: true }).label).toBe(
      "Release to send"
    );
  });

  it("latched: Tap to stop", () => {
    expect(talkLabel({ ...base, phase: "latched" }).label).toBe("Tap to stop");
    expect(talkLabel({ ...base, phase: "tapStop" }).label).toBe("Tap to stop");
  });

  it("while stopping: Typing…, or Transcribing… on This phone", () => {
    expect(
      talkLabel({ ...base, phase: "idle", transcribing: true }).label
    ).toBe("Typing…");
    expect(
      talkLabel({ ...base, phase: "idle", transcribing: true, phoneMode: true })
        .label
    ).toBe("Transcribing…");
  });
});
