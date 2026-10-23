import { useCallback, useRef, useState } from "react";
import type { HidStatus, NewlineMode } from "../types";
import { hidStatus, hidType } from "../lib/api";
import { CHIP_NOTE_CLASS, chipClass } from "../lib/chip";
import {
  decodeTextFile,
  estimateSeconds,
  formatDuration,
  initialRate,
  typeFile,
  waitForIdle,
  type TypeFileProgress,
} from "../lib/typeFile";

interface TypeFileButtonProps {
  newlineMode: NewlineMode;
  /** the Keystroke delay setting */
  keystrokeDelay: number;
  hid: {
    status: HidStatus | null;
    stopTransmission: () => Promise<void>;
  };
}

type Phase =
  | { name: "idle" }
  | { name: "ready"; fileName: string; text: string }
  | { name: "typing"; fileName: string; progress: TypeFileProgress }
  | { name: "stopped"; message: string };

const BINARY_MESSAGE =
  "That file is not text. Typing binary files (pictures, PDFs, zips) is not supported yet — only plain text files for now.";

const count = (n: number) => n.toLocaleString("en-US");

/**
 * "Type a file": pick a UTF-8 text file and type it, as it is, on the host.
 * Shows the time it should take before it starts and while it runs, with a
 * Cancel that stops between chunks (and cuts the one in flight short).
 */
export function TypeFileButton({
  newlineMode,
  keystrokeDelay,
  hid,
}: TypeFileButtonProps) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  const handlePicked = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (hid.status?.bluetooth !== "connected") {
        setPhase({
          name: "stopped",
          message: "Not connected to a computer — connect first, then pick the file",
        });
        return;
      }
      let decoded;
      try {
        decoded = decodeTextFile(new Uint8Array(await file.arrayBuffer()));
      } catch {
        setPhase({ name: "stopped", message: "Couldn't read that file" });
        return;
      }
      if (!decoded.ok) {
        setPhase({ name: "stopped", message: BINARY_MESSAGE });
      } else if (decoded.text.length === 0) {
        setPhase({ name: "stopped", message: "That file is empty" });
      } else {
        setPhase({ name: "ready", fileName: file.name, text: decoded.text });
      }
    },
    [hid.status?.bluetooth]
  );

  const start = useCallback(
    async (fileName: string, text: string) => {
      cancelledRef.current = false;
      const delayMs = keystrokeDelay;
      const result = await typeFile({
        text,
        delayMs,
        sendChunk: async (chunk) => {
          await hidType(chunk, "", delayMs, newlineMode);
        },
        waitTyped: (chunk) =>
          waitForIdle({
            readTyping: async () => (await hidStatus()).typing,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            now: () => Date.now(),
            expectedMs: estimateSeconds(chunk, initialRate(delayMs)) * 1000,
          }),
        now: () => Date.now(),
        isCancelled: () => cancelledRef.current,
        onProgress: (progress) => setPhase({ name: "typing", fileName, progress }),
      });
      if (result.status === "done") {
        setPhase({
          name: "stopped",
          message: `Typed ${fileName} (${count(text.length)} characters)`,
        });
      } else if (result.status === "cancelled") {
        setPhase({
          name: "stopped",
          message: `Stopped — ${count(result.typedChars)} of ${count(text.length)} characters were typed`,
        });
      } else {
        const authFailed = result.error === "AUTH_FAILED";
        setPhase({
          name: "stopped",
          message: `${authFailed ? "The keyboard service refused the request — open Settings and sign in again" : "Typing failed"} after ${count(result.typedChars)} of ${count(text.length)} characters`,
        });
      }
    },
    [keystrokeDelay, newlineMode]
  );

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    await hid.stopTransmission();
  }, [hid]);

  const typing = phase.name === "typing";

  return (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={typing}
        className={`${chipClass()} disabled:opacity-50`}
      >
        📄 Type a file
      </button>
      {/* no `accept`: Android Chrome greys out files its filter does not know */}
      <input
        ref={inputRef}
        type="file"
        data-testid="type-file-input"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void handlePicked(file);
        }}
      />
      {phase.name === "stopped" && (
        <p data-testid="type-file-note" className={CHIP_NOTE_CLASS}>
          {phase.message}
        </p>
      )}
      {phase.name === "ready" && (
        <div
          data-testid="type-file-ready"
          className="order-last col-span-2 rounded-xl border border-gray-700 bg-gray-900 p-3 text-sm text-gray-300"
        >
          <p className="truncate font-medium">{phase.fileName}</p>
          <p className="text-xs text-gray-400" data-testid="type-file-estimate">
            {count(phase.text.length)} characters — about{" "}
            {formatDuration(
              estimateSeconds(phase.text, initialRate(keystrokeDelay))
            )}{" "}
            to type
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void start(phase.fileName, phase.text)}
              className="flex-1 rounded-xl bg-sky-600 py-2 font-medium text-white"
            >
              Type it
            </button>
            <button
              onClick={() => setPhase({ name: "idle" })}
              className="flex-1 rounded-xl bg-gray-800 py-2 font-medium text-gray-300"
            >
              Don't type
            </button>
          </div>
        </div>
      )}
      {phase.name === "typing" && (
        <div
          data-testid="type-file-progress"
          className="order-last col-span-2 rounded-xl border border-gray-700 bg-gray-900 p-3 text-sm text-gray-300"
        >
          <p className="truncate font-medium">Typing {phase.fileName}</p>
          <div className="mt-1 h-2 overflow-hidden rounded bg-gray-800">
            <div
              className="h-full bg-sky-600"
              style={{
                width: `${Math.round((phase.progress.typedChars / phase.progress.totalChars) * 100)}%`,
              }}
            />
          </div>
          <p className="mt-1 text-xs text-gray-400" data-testid="type-file-status">
            {count(phase.progress.typedChars)} of {count(phase.progress.totalChars)} characters
            {" — "}about {formatDuration(phase.progress.remainingSeconds)} left
          </p>
          <button
            onClick={() => void cancel()}
            className="mt-2 w-full rounded-xl bg-red-700 py-2 font-medium text-white"
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
