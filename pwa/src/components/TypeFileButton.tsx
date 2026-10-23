import { useCallback, useRef, useState } from "react";
import type { HidStatus, NewlineMode } from "../types";
import { hidStatus, hidType } from "../lib/api";
import { CHIP_NOTE_CLASS, chipClass } from "../lib/chip";
import { compressionSummary, openBrowserImage } from "../lib/compressImage";
import {
  estimateSeconds,
  formatDuration,
  initialRate,
  prepareFile,
  typeFile,
  waitForIdle,
  type Prepared,
  type TypeFileProgress,
} from "../lib/typeFile";

interface TypeFileButtonProps {
  newlineMode: NewlineMode;
  /** the Keystroke delay setting */
  keystrokeDelay: number;
  /** the Typing time limit setting: longer than this asks first */
  budgetMinutes: number;
  hid: {
    status: HidStatus | null;
    stopTransmission: () => Promise<void>;
  };
}

type Ready = Extract<Prepared, { status: "ready" }>;

type Phase =
  | { name: "idle" }
  | { name: "preparing"; fileName: string }
  | { name: "ready"; file: Ready }
  | { name: "typing"; fileName: string; progress: TypeFileProgress }
  | { name: "stopped"; message: string };

const count = (n: number) => n.toLocaleString("en-US");

/**
 * "Type a file": pick a file and type it on the host: a UTF-8 text file as it
 * is, anything else as base64 with a header that says how to get it back, a
 * picture made smaller first. Shows the time it should take before it starts
 * and while it runs; a file over the Typing time limit asks first. Cancel
 * works while the file is being prepared, before it starts, and while it types
 * (it stops between chunks and cuts the one in flight short).
 */
export function TypeFileButton({
  newlineMode,
  keystrokeDelay,
  budgetMinutes,
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
      cancelledRef.current = false;
      setPhase({ name: "preparing", fileName: file.name });
      let prepared: Prepared;
      try {
        prepared = await prepareFile({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
          delayMs: keystrokeDelay,
          budgetSeconds: budgetMinutes * 60,
          openImage: openBrowserImage,
          isCancelled: () => cancelledRef.current,
        });
      } catch {
        setPhase({ name: "stopped", message: "Couldn't read that file" });
        return;
      }
      if (prepared.status === "cancelled") {
        setPhase({ name: "stopped", message: "Cancelled — nothing was typed" });
      } else if (prepared.status === "empty") {
        setPhase({ name: "stopped", message: "That file is empty" });
      } else {
        setPhase({ name: "ready", file: prepared });
      }
    },
    [hid.status?.bluetooth, keystrokeDelay, budgetMinutes]
  );

  const start = useCallback(
    async (file: Ready) => {
      cancelledRef.current = false;
      const delayMs = keystrokeDelay;
      const { fileName, text } = file;
      const binary = file.kind !== "text";
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
        onProgress: (progress) =>
          setPhase({ name: "typing", fileName, progress }),
      });
      if (result.status === "done") {
        setPhase({
          name: "stopped",
          message: binary
            ? `Typed ${fileName} as base64 (${count(text.length)} characters)`
            : `Typed ${fileName} (${count(text.length)} characters)`,
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

  // Cancel while the file is being read, hashed or made smaller: nothing has
  // been typed, so there is nothing to stop on the keyboard service
  const cancelPreparing = () => {
    cancelledRef.current = true;
  };

  const busy = phase.name === "typing" || phase.name === "preparing";

  return (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
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
      {phase.name === "preparing" && (
        <div
          data-testid="type-file-preparing"
          className="order-last col-span-2 rounded-xl border border-gray-700 bg-gray-900 p-3 text-sm text-gray-300"
        >
          <p className="truncate font-medium">Getting {phase.fileName} ready…</p>
          <p className="text-xs text-gray-400">
            Reading it and, for a picture, making it smaller to type faster.
          </p>
          <button
            onClick={cancelPreparing}
            className="mt-2 w-full rounded-xl bg-red-700 py-2 font-medium text-white"
          >
            Cancel
          </button>
        </div>
      )}
      {phase.name === "ready" && (
        <div
          data-testid="type-file-ready"
          className="order-last col-span-2 rounded-xl border border-gray-700 bg-gray-900 p-3 text-sm text-gray-300"
        >
          <p className="truncate font-medium">{phase.file.fileName}</p>
          {phase.file.kind !== "text" && (
            <p className="text-xs text-gray-400" data-testid="type-file-binary">
              Not a text file: it will be typed as base64, with a note at the top
              saying how to get the file back.
            </p>
          )}
          {phase.file.compression && (
            <p className="text-xs text-gray-400" data-testid="type-file-compressed">
              {compressionSummary(phase.file.compression)}
            </p>
          )}
          <p className="text-xs text-gray-400" data-testid="type-file-estimate">
            {count(phase.file.text.length)} characters — about{" "}
            {formatDuration(phase.file.seconds)} to type
          </p>
          {phase.file.overBudget && (
            <p className="text-xs text-amber-500" data-testid="type-file-over">
              That is longer than your {budgetMinutes}-minute limit (Settings,
              Typing time limit).
              {phase.file.kind === "picture" && " It is already as small as this app makes it."}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void start(phase.file)}
              className="flex-1 rounded-xl bg-sky-600 py-2 font-medium text-white"
            >
              {phase.file.overBudget ? "Type anyway" : "Type it"}
            </button>
            <button
              onClick={() => setPhase({ name: "idle" })}
              className="flex-1 rounded-xl bg-gray-800 py-2 font-medium text-gray-300"
            >
              {phase.file.overBudget ? "Cancel" : "Don't type"}
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
