import { describe, expect, it } from "vitest";
import { collapsedStatus } from "./collapsedStatus";

const READY = { status: "ready", model: "parakeet-tdt-0.6b-v2" } as const;
const CONNECTED = { service: "running", bluetooth: "connected", device: "Tesla" } as const;

describe("collapsedStatus", () => {
  it("names the model and the connection, both green, when all is well", () => {
    const s = collapsedStatus({
      whisperStatus: READY,
      whisperError: null,
      hidStatus: CONNECTED,
      hidReachable: true,
    });
    expect(s.model).toEqual({ dot: "green", text: "parakeet-tdt-0.6b-v2" });
    expect(s.link).toEqual({ dot: "green", text: "Tesla" });
    expect(s.title).toContain("parakeet-tdt-0.6b-v2");
    expect(s.title).toContain("Tesla");
  });

  it("shows the whisper error, or offline, with a red dot", () => {
    const base = { hidStatus: CONNECTED, hidReachable: true };
    expect(
      collapsedStatus({ ...base, whisperStatus: null, whisperError: "Whisper server offline" })
        .model
    ).toEqual({ dot: "red", text: "Whisper server offline" });
    expect(
      collapsedStatus({ ...base, whisperStatus: null, whisperError: null }).model
    ).toEqual({ dot: "red", text: "offline" });
  });

  it("reports a retrying link in yellow and an unreachable HID service in red", () => {
    const retry = collapsedStatus({
      whisperStatus: READY,
      whisperError: null,
      hidStatus: { service: "running", bluetooth: "reconnecting", reconnect_attempt: 3 },
      hidReachable: true,
    });
    expect(retry.link).toEqual({ dot: "yellow", text: "Retry 3" });
    const gone = collapsedStatus({
      whisperStatus: READY,
      whisperError: null,
      hidStatus: null,
      hidReachable: false,
    });
    expect(gone.link).toEqual({ dot: "red", text: "HID offline" });
  });

  it("says in the title that tapping opens History and Settings", () => {
    const s = collapsedStatus({
      whisperStatus: READY,
      whisperError: null,
      hidStatus: CONNECTED,
      hidReachable: true,
    });
    expect(s.title).toMatch(/History and Settings/);
  });
});
