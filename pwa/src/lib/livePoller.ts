// The Talk screen's live words box, as a pure poller (no React, no navigator).
// While a dictation records it asks the server's GET /transcribe/live for the
// words so far and hands the box a view to show. Timers and the request are
// injected so tests can drive them with a fake clock and fetch.

/** How long after one answer before the next request. */
export const POLL_MS = 700;
/** This many failures in a row and the poller gives up (the box keeps what it has). */
export const MAX_ERRORS = 3;

/** The server's GET /transcribe/live answer. */
export interface LiveReply {
  recording: boolean;
  chunked: boolean;
  /** Committed chunks' text. */
  text: string;
  /** Tentative transcription of the audio not yet committed. */
  tail: string;
  seq: number;
}

export type LiveView =
  | { kind: "listening" }
  | { kind: "note"; text: string }
  | { kind: "words"; text: string; tail: string }
  | { kind: "final"; text: string };

export const LISTENING: LiveView = { kind: "listening" };
export const FORMAT_NOTE: LiveView = {
  kind: "note",
  text: "Listening… (this phone's recording format cannot show words until you stop)",
};

export function viewFromLive(reply: LiveReply): LiveView {
  if (!reply.chunked) return FORMAT_NOTE;
  if (!reply.text && !reply.tail) return LISTENING;
  return { kind: "words", text: reply.text, tail: reply.tail };
}

export interface LivePollerDeps {
  /** One request. null = the server has no /transcribe/live (404). Throws on any other failure. */
  fetchLive: () => Promise<LiveReply | null>;
  /** Called with the view to show, only when seq (or chunked) changed. */
  onView: (view: LiveView) => void;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface LivePoller {
  stop: () => void;
}

/**
 * Starts polling at once. The next request is scheduled only after the last one
 * has answered, so there is never more than one in flight. Stops on stop(), on a
 * 404, and after MAX_ERRORS failures in a row.
 */
export function startLivePoller(deps: LivePollerDeps): LivePoller {
  const interval = deps.intervalMs ?? POLL_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let stopped = false;
  let timer: unknown = undefined;
  let errors = 0;
  let last: { seq: number; chunked: boolean } | null = null;

  const schedule = () => {
    if (!stopped) timer = setTimer(tick, interval);
  };

  const tick = async () => {
    timer = undefined;
    let reply: LiveReply | null;
    try {
      reply = await deps.fetchLive();
    } catch {
      if (stopped) return;
      errors += 1;
      if (errors >= MAX_ERRORS) stopped = true;
      else schedule();
      return;
    }
    if (stopped) return;
    errors = 0;
    if (reply === null) {
      // An older server: no live words, and nothing to keep asking about.
      stopped = true;
      deps.onView(LISTENING);
      return;
    }
    if (!last || last.seq !== reply.seq || last.chunked !== reply.chunked) {
      last = { seq: reply.seq, chunked: reply.chunked };
      deps.onView(viewFromLive(reply));
    }
    schedule();
  };

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}

/** What the box shows: the preview while recording, then the final text in its place. */
export function liveBoxView(state: {
  recording: boolean;
  preview: LiveView | null;
  finalText: string | null;
}): LiveView | null {
  if (state.recording) return state.preview ?? LISTENING;
  return state.finalText ? { kind: "final", text: state.finalText } : null;
}
