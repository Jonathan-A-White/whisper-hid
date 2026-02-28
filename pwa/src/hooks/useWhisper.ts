import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeStart, transcribeStop, whisperStatus } from "../lib/api";
import type { WhisperStatus } from "../types";

export function useWhisper() {
  const [status, setStatus] = useState<WhisperStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Poll whisper server status every 3 seconds
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await whisperStatus();
        setStatus(data);
        setError(null);
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

  const stopRecording = useCallback(async (): Promise<string | null> => {
    try {
      setTranscribing(true);
      const result = await transcribeStop();
      setRecording(false);
      setTranscribing(false);
      if (result.text !== undefined) {
        return result.text as string;
      }
      setError(result.error || "Transcription failed");
      return null;
    } catch {
      setRecording(false);
      setTranscribing(false);
      setError("Failed to stop recording");
      return null;
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
