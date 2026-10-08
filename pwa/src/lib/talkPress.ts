// The Talk bar's press logic, as a pure state machine (no React, no timers).
// A press held for LATCH_MS or longer is a hold: letting go stops the dictation.
// A press released sooner is a tap: it leaves the recording on ("latched"), and the
// next tap stops it. TalkView feeds it presses and releases with the time of each.

/** A press released in under this many ms is a tap that latches the recording on. */
export const LATCH_MS = 350;

export type PressPhase =
  | "idle" // not recording
  | "held" // finger down, recording
  | "latched" // recording stays on after a quick tap
  | "tapStop"; // finger down again on a latched recording; letting go stops it

export interface PressState {
  phase: PressPhase;
  /** When the current press began (ms, any monotonic clock); 0 when none. */
  pressedAt: number;
}

/** What TalkView must do now. */
export type PressAction = "start" | "stop" | "none";

export interface PressStep {
  state: PressState;
  action: PressAction;
}

export const IDLE: PressState = { phase: "idle", pressedAt: 0 };

/** Finger (or Space/Enter) goes down at `nowMs`. */
export function press(state: PressState, nowMs: number): PressStep {
  switch (state.phase) {
    case "idle":
      return { state: { phase: "held", pressedAt: nowMs }, action: "start" };
    case "latched":
      return { state: { phase: "tapStop", pressedAt: nowMs }, action: "none" };
    default:
      // already down: a repeated press changes nothing
      return { state, action: "none" };
  }
}

/** Finger comes up normally at `nowMs`. */
export function release(state: PressState, nowMs: number): PressStep {
  switch (state.phase) {
    case "held":
      return nowMs - state.pressedAt < LATCH_MS
        ? { state: { phase: "latched", pressedAt: 0 }, action: "none" }
        : { state: IDLE, action: "stop" };
    case "tapStop":
      return { state: IDLE, action: "stop" };
    default:
      return { state, action: "none" };
  }
}

/** The press was cancelled (pointercancel): whatever the length, recording stops. */
export function cancel(state: PressState): PressStep {
  if (state.phase === "held" || state.phase === "tapStop") {
    return { state: IDLE, action: "stop" };
  }
  return { state, action: "none" };
}

/** What the recording failed to start / was ended elsewhere: back to idle. */
export function reset(): PressState {
  return IDLE;
}

export interface TalkLabelInput {
  phase: PressPhase;
  /** True once /transcribe/start has answered. */
  micOpen: boolean;
  /** True while /transcribe/stop runs. */
  transcribing: boolean;
  /** "This phone" is on: the text is kept here, not typed on the computer. */
  phoneMode: boolean;
}

export interface TalkLabel {
  label: string;
  /** Small second line, shown when there is one. */
  sub?: string;
}

/** The words on the bar for each state. */
export function talkLabel(input: TalkLabelInput): TalkLabel {
  if (input.transcribing) {
    return { label: input.phoneMode ? "Transcribing…" : "Typing…" };
  }
  switch (input.phase) {
    case "idle":
      return { label: "Hold to talk", sub: "tap to keep it on" };
    case "held":
      if (!input.micOpen) return { label: "Starting the mic…" };
      return { label: input.phoneMode ? "Release to send" : "Release to type" };
    default:
      // latched, or a second tap going down to stop
      if (!input.micOpen) return { label: "Starting the mic…" };
      return { label: "Tap to stop" };
  }
}
