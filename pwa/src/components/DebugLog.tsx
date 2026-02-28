import { useEffect, useState } from "react";
import { hidLogs, whisperLogs } from "../lib/api";
import type { LogEntry } from "../types";

interface DebugLogProps {
  onClose: () => void;
}

export function DebugLog({ onClose }: DebugLogProps) {
  const [logs, setLogs] = useState<(LogEntry & { source: string })[]>([]);

  useEffect(() => {
    const fetchLogs = async () => {
      const combined: (LogEntry & { source: string })[] = [];
      try {
        const hidData = await hidLogs();
        for (const entry of hidData.logs || []) {
          combined.push({ ...entry, source: "hid" });
        }
      } catch {
        // HID service may be offline
      }
      try {
        const wspData = await whisperLogs();
        for (const entry of wspData.logs || []) {
          combined.push({ ...entry, source: "wsp" });
        }
      } catch {
        // Whisper server may be offline
      }
      combined.sort((a, b) => a.ts - b.ts);
      setLogs(combined);
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const handleCopy = () => {
    const text = logs
      .map((l) => `${formatTime(l.ts)} [${l.source}] ${l.msg}`)
      .join("\n");
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Debug Log</h2>
        <div className="flex gap-2">
          <button
            onClick={handleCopy}
            className="text-xs text-sky-400 px-2 py-1"
          >
            Copy
          </button>
          <button
            onClick={onClose}
            className="text-xs text-gray-400 px-2 py-1"
          >
            Close
          </button>
        </div>
      </div>

      <pre className="bg-gray-900 rounded p-3 text-xs text-gray-300 overflow-auto max-h-[70vh] font-mono">
        {logs.length === 0 ? (
          <span className="text-gray-500">No log entries</span>
        ) : (
          logs.map((l, i) => (
            <div key={i}>
              <span className="text-gray-500">{formatTime(l.ts)}</span>{" "}
              <span className="text-sky-400">[{l.source}]</span>{" "}
              {l.msg}
            </div>
          ))
        )}
      </pre>
    </div>
  );
}
