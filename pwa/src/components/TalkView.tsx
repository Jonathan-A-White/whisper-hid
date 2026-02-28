import { useCallback, useState } from "react";
import type { Settings } from "../types";
import { EditBuffer } from "./EditBuffer";

interface TalkViewProps {
  whisper: {
    recording: boolean;
    transcribing: boolean;
    startRecording: () => Promise<void>;
    stopRecording: () => Promise<string | null>;
  };
  hid: {
    sendText: (text: string) => Promise<boolean>;
    status: { bluetooth: string; device?: string } | null;
    queue: { id: string; text: string; status: string }[];
  };
  store: {
    pinnedEntries: { id: string; text: string }[];
    addEntry: (text: string) => Promise<unknown>;
  };
  settings: Settings;
}

export function TalkView({ whisper, hid, store, settings }: TalkViewProps) {
  const [lastText, setLastText] = useState<string | null>(null);
  const [editText, setEditText] = useState<string | null>(null);

  const handlePtt = useCallback(async () => {
    if (whisper.recording) {
      const text = await whisper.stopRecording();
      if (text) {
        if (settings.editBeforeSend) {
          setEditText(text);
        } else {
          setLastText(text);
          await store.addEntry(text);
          await hid.sendText(text);
        }
      }
    } else {
      await whisper.startRecording();
    }
  }, [whisper, hid, store, settings.editBeforeSend]);

  const handleSendEdit = useCallback(
    async (text: string) => {
      setEditText(null);
      setLastText(text);
      await store.addEntry(text);
      await hid.sendText(text);
    },
    [hid, store]
  );

  const handlePinnedTap = useCallback(
    async (text: string) => {
      await hid.sendText(text);
    },
    [hid]
  );

  const isConnected = hid.status?.bluetooth === "connected";

  return (
    <div className="flex flex-col items-center justify-center p-6 min-h-[calc(100vh-8rem)]">
      {/* Pinned items */}
      {store.pinnedEntries.length > 0 && (
        <div className="w-full mb-6 overflow-x-auto">
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
          {lastText && (
            <p className="mt-4 text-gray-400 text-sm max-w-xs text-center">
              Last: &quot;{lastText}&quot;
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
  );
}
