import { useCallback, useState } from "react";
import type { Settings, WhisperStatus } from "../types";
import type { TranscriptionResult } from "../hooks/useWhisper";
import { EditBuffer } from "./EditBuffer";

interface TalkViewProps {
  whisper: {
    recording: boolean;
    transcribing: boolean;
    status: WhisperStatus | null;
    startRecording: () => Promise<void>;
    stopRecording: () => Promise<TranscriptionResult>;
  };
  hid: {
    sendText: (text: string) => Promise<boolean>;
    status: { bluetooth: string; device?: string } | null;
    queue: { id: string; text: string; status: string }[];
  };
  store: {
    pinnedEntries: { id: string; text: string }[];
    addEntry: (text: string, stats?: { model?: string; speedRatio?: number; audioDuration?: number; processingMs?: number }) => Promise<unknown>;
  };
  settings: Settings;
}

interface TranscriptionStats {
  audioDuration: number; // seconds
  processingMs: number;
  speedRatio: number;
}

export function TalkView({ whisper, hid, store, settings }: TalkViewProps) {
  const [lastText, setLastText] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastStats, setLastStats] = useState<TranscriptionStats | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const [lastEntryStats, setLastEntryStats] = useState<{ model?: string; speedRatio?: number; audioDuration?: number; processingMs?: number } | null>(null);

  const handlePtt = useCallback(async () => {
    if (whisper.recording) {
      const { text, error, stats } = await whisper.stopRecording();
      if (text) {
        setLastError(null);
        setLastStats(stats ?? null);
        const entryStats = stats
          ? {
              model: whisper.status?.model,
              speedRatio: stats.speedRatio,
              audioDuration: stats.audioDuration,
              processingMs: stats.processingMs,
            }
          : undefined;
        if (settings.editBeforeSend) {
          setEditText(text);
          setLastEntryStats(entryStats ?? null);
        } else {
          setLastText(text);
          await store.addEntry(text, entryStats);
          await hid.sendText(text);
        }
      } else {
        setLastError(error);
        setLastStats(null);
      }
    } else {
      setLastError(null);
      await whisper.startRecording();
    }
  }, [whisper, hid, store, settings.editBeforeSend]);

  const handleSendEdit = useCallback(
    async (text: string) => {
      setEditText(null);
      setLastText(text);
      await store.addEntry(text, lastEntryStats ?? undefined);
      setLastEntryStats(null);
      await hid.sendText(text);
    },
    [hid, store, lastEntryStats]
  );

  const handlePinnedTap = useCallback(
    async (text: string) => {
      await hid.sendText(text);
    },
    [hid]
  );

  const isConnected = hid.status?.bluetooth === "connected";

  return (
    <div className="flex flex-col h-full p-6 overflow-hidden">
      {/* Pinned items — fixed at top, never scrolls away */}
      {store.pinnedEntries.length > 0 && (
        <div className="flex-shrink-0 w-full mb-4 overflow-x-auto">
          <div className="flex gap-2 pb-1">
            {store.pinnedEntries.map((entry) => (
              <button
                key={entry.id}
                onClick={() => handlePinnedTap(entry.text)}
                className="flex-shrink-0 px-3 py-1.5 bg-gray-800 text-gray-300 rounded-full text-sm hover:bg-gray-700 transition-colors"
              >
                {entry.text.length > 30
                  ? entry.text.slice(0, 30) + "..."
                  : entry.text}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scrollable content area */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center">
        {/* Edit buffer */}
        {editText !== null ? (
          <EditBuffer
            text={editText}
            onSend={handleSendEdit}
            onDiscard={() => setEditText(null)}
          />
        ) : (
          <>
            {/* PTT Button */}
            <button
              onClick={handlePtt}
              disabled={whisper.transcribing}
              className={`w-40 h-40 rounded-full font-bold text-lg transition-all ${
                whisper.transcribing
                  ? "bg-gray-700 text-gray-400 scale-100"
                  : whisper.recording
                    ? "bg-orange-500 text-white scale-105 animate-pulse"
                    : "bg-sky-600 text-white hover:bg-sky-500 active:scale-95"
              }`}
            >
              {whisper.transcribing
                ? "Processing..."
                : whisper.recording
                  ? "Stop"
                  : "Talk"}
            </button>

            {/* Connection indicator */}
            <p className="mt-4 text-sm text-gray-500">
              {isConnected
                ? `Connected to ${hid.status?.device}`
                : "Not connected"}
            </p>

            {/* Last transcription */}
            {lastText && !lastError && (
              <p className="mt-4 text-gray-400 text-sm max-w-xs text-center">
                Last: &quot;{lastText}&quot;
              </p>
            )}

            {/* Last transcription stats */}
            {lastStats && !lastError && (
              <p className="mt-1 text-gray-600 text-xs text-center">
                {lastStats.audioDuration.toFixed(1)}s audio,{" "}
                {(lastStats.processingMs / 1000).toFixed(1)}s processing
                {" \u2014 "}
                <span
                  className={
                    lastStats.speedRatio >= 1
                      ? "text-green-500"
                      : "text-yellow-500"
                  }
                >
                  {lastStats.speedRatio.toFixed(1)}x
                </span>
              </p>
            )}

            {/* Transcription error */}
            {lastError && (
              <p className="mt-4 text-red-400 text-sm max-w-xs text-center">
                {lastError}
              </p>
            )}

            {/* Queued items */}
            {hid.queue.length > 0 && (
              <div className="mt-4 w-full max-w-xs">
                {hid.queue.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 text-sm py-1"
                  >
                    <span
                      className={
                        item.status === "sent"
                          ? "text-green-400"
                          : item.status === "failed"
                            ? "text-red-400"
                            : "text-yellow-400"
                      }
                    >
                      {item.status === "sent"
                        ? "\u2713"
                        : item.status === "failed"
                          ? "\u2717"
                          : "\u23F3"}
                    </span>
                    <span className="text-gray-400 truncate">{item.text}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
