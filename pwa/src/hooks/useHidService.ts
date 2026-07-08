import { useCallback, useEffect, useRef, useState } from "react";
import {
  hidStatus,
  hidType,
  hidRestart,
  hidHeadsetMic,
  clearToken,
} from "../lib/api";
import type { HidStatus, QueuedText, Settings } from "../types";

export function useHidService(settings: Settings) {
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
        await hidType(text, getAppendString(), settings.keystrokeDelay);
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
    [status?.bluetooth, getAppendString, settings.keystrokeDelay]
  );

  const flushQueue = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;

    const pending = queue.filter((q) => q.status === "pending");
    for (const item of pending) {
      try {
        await hidType(item.text, getAppendString(), settings.keystrokeDelay);
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
  }, [queue, getAppendString, settings.keystrokeDelay]);

  const sendNewline = useCallback(async () => {
    if (status?.bluetooth !== "connected") return;
    try {
      await hidType("\n", "");
    } catch (e) {
      if (e instanceof Error && e.message === "AUTH_FAILED") {
        setAuthError(true);
        clearToken();
      }
    }
  }, [status?.bluetooth]);

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
    restart,
    setHeadsetMic,
  };
}
