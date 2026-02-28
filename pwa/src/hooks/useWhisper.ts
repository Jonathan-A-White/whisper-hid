import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeStart, transcribeStop, whisperStatus } from "../lib/api";
import type { WhisperStatus } from "../types";

export interface TranscriptionResult {
  text: string | null;
  error: string | null;
}

export function useWhisper() {
  const [status, setStatus] = useState<WhisperStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  // Track whether we're in the middle of a transcription to avoid poll clearing errors
  const busyRef = useRef(false);

  // Poll whisper server status every 3 seconds
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await whisperStatus();
        setStatus(data);
        // Don't clear error while transcribing — stopRecording manages its own errors
        if (!busyRef.current) {
          setError(null);
        }
      } catch {
        setStatus(null);
        setError("Whisper server offline");
      }
    };
    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setRecording(true);
      setError(null);
      await transcribeStart();
    } catch {
      setRecording(false);
      setError("Failed to start recording");
    }
  }, []);

  const stopRecording =
    useCallback(async (): Promise<TranscriptionResult> => {
      busyRef.current = true;
      try {
        setTranscribing(true);
        setError(null);
        const result = await transcribeStop();
        setRecording(false);
        setTranscribing(false);
        busyRef.current = false;

        if (result.text !== undefined) {
          const text = (result.text as string).trim();
          if (text.length > 0) {
            return { text, error: null };
          }
          const msg = "No speech detected";
          setError(msg);
          return { text: null, error: msg };
        }

        const msg = result.error || "Transcription failed";
        setError(msg);
        return { text: null, error: msg };
      } catch (e) {
        setRecording(false);
        setTranscribing(false);
        busyRef.current = false;
        const msg =
          e instanceof TypeError
            ? "Cannot reach Whisper server (CORS or network error)"
            : "Failed to stop recording";
        setError(msg);
        return { text: null, error: msg };
      }
    }, []);

  return {
    status,
    recording,
    transcribing,
    error,
    startRecording,
    stopRecording,
  };
}
