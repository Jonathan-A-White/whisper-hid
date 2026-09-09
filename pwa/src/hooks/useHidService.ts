import { useCallback, useEffect, useRef, useState } from "react";
import {
  hidStatus,
  hidType,
  hidStop,
  hidRestart,
  hidHeadsetMic,
  clearToken,
} from "../lib/api";
import type { HidStatus, NewlineMode, QueuedText, Settings } from "../types";

/**
 * Quiet gap between the dictated text and the Enter that submits it.
 *
 * CLI composers group keystrokes that arrive in a burst into a "paste" and
 * treat an Enter close behind them as part of it — a newline, not a submit.
 * Codex CLI's window is 120ms after the last burst keystroke; dictation types
 * at a few ms per character, so without a gap the Enter always landed inside
 * it and the prompt sat there unsent. 250ms clears that window with room for
 * link jitter and is unnoticeable at the end of a dictation.
 *
 * The HID service does the waiting (`pre_delay_ms`), because only it knows
 * when the text actually finished typing — /type returns as soon as the send
 * is queued.
 */
const SUBMIT_SETTLE_MS = 250;

/**
 * @param newlineMode how a "\n" is typed on the host — comes from the active
 *   target app (see useTargetMode). Applies to every send, so multi-line
 *   text (a "prompt"-style cleanup with bullets, a pasted clipboard) doesn't
 *   submit itself line by line in a CLI composer.
 * @param submitNewlineMode how the deliberate final newline is typed — also
 *   per target, because "submit this prompt" is its own keystroke problem
 *   (see sendNewline).
 */
export function useHidService(
  settings: Settings,
  newlineMode: NewlineMode = "enter",
  submitNewlineMode: NewlineMode = "enter"
) {
  const [status, setStatus] = useState<HidStatus | null>(null);
  const [reachable, setReachable] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [queue, setQueue] = useState<QueuedText[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const flushingRef = useRef(false);

  // Poll HID service status every 3 seconds
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await hidStatus();
        setStatus(data);
        setReachable(true);
      } catch {
        setStatus(null);
        setReachable(false);
      }
    };
    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, []);

  // Flush queue when BT reconnects
  useEffect(() => {
    if (
      status?.bluetooth === "connected" &&
      queue.some((q) => q.status === "pending") &&
      !flushingRef.current
    ) {
      flushQueue();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.bluetooth, queue]);

  const getAppendString = useCallback((): string => {
    if (settings.appendNewline) return "\n";
    if (settings.appendSpace) return " ";
    return "";
  }, [settings.appendNewline, settings.appendSpace]);

  const sendText = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text.trim()) return false;

      const id = crypto.randomUUID();
      const entry: QueuedText = { id, text, status: "pending" };

      if (status?.bluetooth !== "connected") {
        // Queue for later
        setQueue((prev) => [...prev, entry]);
        return false;
      }

      try {
        await hidType(
          text,
          getAppendString(),
          settings.keystrokeDelay,
          newlineMode
        );
        return true;
      } catch (e) {
        if (e instanceof Error && e.message === "AUTH_FAILED") {
          setAuthError(true);
          clearToken();
        }
        // Queue failed sends for retry
        setQueue((prev) => [...prev, entry]);
        return false;
      }
    },
    [status?.bluetooth, getAppendString, settings.keystrokeDelay, newlineMode]
  );

  const flushQueue = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;

    const pending = queue.filter((q) => q.status === "pending");
    for (const item of pending) {
      try {
        await hidType(
          item.text,
          getAppendString(),
          settings.keystrokeDelay,
          newlineMode
        );
        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: "sent" } : q))
        );
      } catch (e) {
        if (e instanceof Error && e.message === "AUTH_FAILED") {
          setAuthError(true);
          clearToken();
          break;
        }
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id ? { ...q, status: "failed" } : q
          )
        );
      }
    }

    // Clean up sent items after a delay
    setTimeout(() => {
      setQueue((prev) => prev.filter((q) => q.status !== "sent"));
    }, 2000);

    flushingRef.current = false;
  }, [queue, getAppendString, settings.keystrokeDelay, newlineMode]);

  // Kill switch: stop in-progress typing on the phone (releases any stuck
  // key) and drop anything still queued client-side. Optimistically clears
  // the typing flag; the 3s status poll corrects any drift.
  const stopTransmission = useCallback(async () => {
    setQueue((prev) => prev.filter((q) => q.status !== "pending"));
    setStatus((prev) => (prev ? { ...prev, typing: false } : prev));
    try {
      await hidStop();
    } catch (e) {
      if (e instanceof Error && e.message === "AUTH_FAILED") {
        setAuthError(true);
        clearToken();
      }
    }
  }, []);

  // The deliberate Enter at the end of a dictation ("Newline after end of
  // recording"): never the target's soft newline — submitting the prompt is
  // the whole point of it. Two guards make it actually submit: the target's
  // submit mode (Codex needs End before the Enter to leave paste-burst
  // state), and SUBMIT_SETTLE_MS of silence after the text finished typing
  // so the keystroke doesn't look like the tail of a paste. See
  // SUBMIT_SETTLE_MS and BluetoothHidService.sendString.
  const sendNewline = useCallback(async () => {
    if (status?.bluetooth !== "connected") return;
    try {
      await hidType("\n", "", undefined, submitNewlineMode, SUBMIT_SETTLE_MS);
    } catch (e) {
      if (e instanceof Error && e.message === "AUTH_FAILED") {
        setAuthError(true);
        clearToken();
      }
    }
  }, [status?.bluetooth, submitNewlineMode]);

  const restart = useCallback(async () => {
    try {
      await hidRestart();
    } catch (e) {
      if (e instanceof Error && e.message === "AUTH_FAILED") {
        setAuthError(true);
        clearToken();
      }
    }
  }, []);

  // Toggle whether the HID service holds the headset's SCO mic link.
  // Optimistic update so the Zoom-mode pill responds instantly; the 3s
  // status poll corrects any drift (or reverts on failure).
  const setHeadsetMic = useCallback(async (enabled: boolean) => {
    setStatus((prev) =>
      prev?.headset_mic
        ? { ...prev, headset_mic: { ...prev.headset_mic, enabled } }
        : prev
    );
    try {
      await hidHeadsetMic(enabled);
    } catch (e) {
      if (e instanceof Error && e.message === "AUTH_FAILED") {
        setAuthError(true);
        clearToken();
      }
      setStatus((prev) =>
        prev?.headset_mic
          ? { ...prev, headset_mic: { ...prev.headset_mic, enabled: !enabled } }
          : prev
      );
    }
  }, []);

  return {
    status,
    reachable,
    authError,
    queue,
    sendText,
    sendNewline,
    stopTransmission,
    restart,
    setHeadsetMic,
  };
}
