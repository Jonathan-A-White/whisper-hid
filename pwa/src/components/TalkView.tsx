import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type {
  HidStatus,
  NewlineMode,
  Settings,
  TargetInfo,
  TargetMode,
  WhisperStatus,
} from "../types";
import type { TranscriptionResult } from "../hooks/useWhisper";
import { applyVoiceEdit, transcribeLive } from "../lib/api";
import {
  liveBoxView,
  startLivePoller,
  type LiveView,
} from "../lib/livePoller";
import { deliver, deliveryFor } from "../lib/delivery";
import {
  copyEntry,
  deleteEntry,
  editEntry,
  sendDisabledFor,
  sendEntry,
} from "../lib/historyActions";
import { frontEntry } from "../lib/frontMessage";
import { EditBuffer, type VoiceEditState } from "./EditBuffer";
import { EntryEditor } from "./EntryEditor";
import { EntryMenu } from "./EntryMenu";
import { EntryWords } from "./EntryWords";
import { PhoneModeToggle } from "./PhoneModeToggle";
import {
  IDLE,
  cancel,
  press,
  release,
  talkLabel,
  type PressAction,
  type PressStep,
} from "../lib/talkPress";
import { TargetModeToggle } from "./TargetModeToggle";
import { TypeClipboardButton } from "./TypeClipboardButton";
import { ZoomModeToggle } from "./ZoomModeToggle";

interface TalkViewProps {
  whisper: {
    recording: boolean;
    transcribing: boolean;
    status: WhisperStatus | null;
    startRecording: () => Promise<boolean>;
    stopRecording: () => Promise<TranscriptionResult>;
  };
  hid: {
    sendText: (text: string) => Promise<boolean>;
    sendNewline: () => Promise<void>;
    stopTransmission: () => Promise<void>;
    status: HidStatus | null;
    queue: { id: string; text: string; status: string }[];
    setHeadsetMic: (enabled: boolean) => Promise<void>;
  };
  store: {
    pinnedEntries: { id: string; text: string }[];
    /** Every entry, unfiltered: the front message is one of these. */
    allEntries: { id: string; text: string }[];
    addEntry: (text: string, stats?: { model?: string; speedRatio?: number; audioDuration?: number; processingMs?: number }) => Promise<{ id: string } | undefined>;
    updateEntry: (id: string, text: string) => Promise<void>;
    deleteEntry: (id: string) => Promise<void>;
  };
  /** Target app mode — see useTargetMode */
  target: {
    target: TargetMode | null;
    targets: TargetInfo[];
    newlineMode: NewlineMode;
    setTarget: (target: TargetMode) => void;
  };
  settings: Settings;
  onUpdateSettings: (partial: Partial<Settings>) => void;
}

interface TranscriptionStats {
  audioDuration: number; // seconds
  processingMs: number;
  speedRatio: number;
}

export function TalkView({
  whisper,
  hid,
  store,
  target,
  settings,
  onUpdateSettings,
}: TalkViewProps) {
  // The id of the entry the last dictation added. The front message renders
  // that entry from the store, so History and this screen never disagree.
  const [frontId, setFrontId] = useState<string | null>(null);
  const [frontEditText, setFrontEditText] = useState<string | null>(null);
  // The options menu a long press on the front message opens
  const [frontMenuOpen, setFrontMenuOpen] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastStats, setLastStats] = useState<TranscriptionStats | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const [lastEntryStats, setLastEntryStats] = useState<{ model?: string; speedRatio?: number; audioDuration?: number; processingMs?: number } | null>(null);
  const [voiceEditState, setVoiceEditState] = useState<VoiceEditState>("idle");
  const [voiceEditError, setVoiceEditError] = useState<string | null>(null);
  // The brief copy notice under the front message
  const [copyNotice, setCopyNotice] = useState<"copied" | "tap" | null>(null);
  const phoneMode = deliveryFor(settings.sendTo) === "phone";

  // The live words box: poll the server while a dictation records, and
  // scroll the box to its end as the words arrive.
  const [preview, setPreview] = useState<LiveView | null>(null);
  const liveBoxRef = useRef<HTMLDivElement>(null);
  const polling = whisper.recording && editText === null;
  useEffect(() => {
    if (!polling) return;
    setPreview(null);
    const poller = startLivePoller({
      fetchLive: transcribeLive,
      onView: setPreview,
    });
    return () => poller.stop();
  }, [polling]);
  useEffect(() => {
    const box = liveBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [preview]);

  useEffect(() => {
    if (copyNotice !== "copied") return;
    const t = setTimeout(() => setCopyNotice(null), 2000);
    return () => clearTimeout(t);
  }, [copyNotice]);

  // Send a finished dictation where the "This phone" switch says: typed on
  // the host over Bluetooth, or copied here (and kept for Copy / Share).
  const deliverText = useCallback(
    async (text: string) => {
      const result = await deliver(text, {
        sendTo: settings.sendTo,
        newlineAfterEnd: settings.newlineAfterEnd,
        hid,
        clipboard:
          typeof navigator === "undefined" ? undefined : navigator.clipboard,
      });
      if (result.via === "phone") {
        setCopyNotice(result.copied ? "copied" : "tap");
      } else {
        // Computer mode: typing is the main act, so a refused copy says nothing
        setCopyNotice(result.copied ? "copied" : null);
      }
    },
    [hid, settings.sendTo, settings.newlineAfterEnd]
  );

  const front = frontEntry(store.allEntries, frontId);

  const handleFrontCopy = useCallback(async (text: string) => {
    const { copied } = await copyEntry(text, navigator.clipboard);
    setCopyNotice(copied ? "copied" : "tap");
  }, []);

  const saveFrontEdit = useCallback(() => {
    if (front && frontEditText?.trim()) {
      void store.updateEntry(front.id, frontEditText);
    }
    setFrontEditText(null);
  }, [front, frontEditText, store]);

  // The hold/latch bar. talkPress decides what each press and release means;
  // this runs the answer. The press state lives in a ref (events arrive faster
  // than renders) and is mirrored in state for the label.
  const pressRef = useRef(IDLE);
  const [pressPhase, setPressPhase] = useState(pressRef.current.phase);
  const [micOpen, setMicOpen] = useState(false);
  // The /transcribe/start request in flight, so a stop that comes before it
  // answers waits for it instead of racing it.
  const startingRef = useRef<Promise<boolean> | null>(null);

  const finishDictation = useCallback(async () => {
    const { text, error, stats } = await whisper.stopRecording();
    if (text) {
      setLastError(null);
      setLastStats(stats ?? null);
      setFrontEditText(null);
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
        const added = await store.addEntry(text, entryStats);
        setFrontId(added?.id ?? null);
        await deliverText(text);
      }
    } else {
      setLastError(error);
      setLastStats(null);
    }
  }, [whisper, store, deliverText, settings.editBeforeSend]);

  const runAction = useCallback(
    async (action: PressAction) => {
      if (action === "start") {
        setLastError(null);
        setFrontId(null);
        setFrontEditText(null);
        setCopyNotice(null);
        const starting = whisper.startRecording();
        startingRef.current = starting;
        const ok = await starting;
        startingRef.current = null;
        if (ok) {
          setMicOpen(true);
        } else {
          pressRef.current = IDLE;
          setPressPhase(IDLE.phase);
        }
      } else if (action === "stop") {
        const starting = startingRef.current;
        if (starting && !(await starting)) return; // never started: nothing to stop
        setMicOpen(false);
        await finishDictation();
      }
    },
    [whisper, finishDictation]
  );

  const apply = useCallback(
    (step: PressStep) => {
      pressRef.current = step.state;
      setPressPhase(step.state.phase);
      if (step.action !== "none") void runAction(step.action);
    },
    [runAction]
  );

  const pressDown = () => apply(press(pressRef.current, performance.now()));
  const pressUp = () => apply(release(pressRef.current, performance.now()));
  const pressCancel = () => apply(cancel(pressRef.current));

  const onBarPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // a pointer that is already gone: the press still counts
    }
    pressDown();
  };
  const onBarKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) pressDown();
  };
  const onBarKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") pressUp();
  };

  const handleSendEdit = useCallback(
    async (text: string) => {
      setEditText(null);
      setVoiceEditState("idle");
      setVoiceEditError(null);
      const added = await store.addEntry(text, lastEntryStats ?? undefined);
      setFrontId(added?.id ?? null);
      setLastEntryStats(null);
      await deliverText(text);
    },
    [store, deliverText, lastEntryStats]
  );

  // Voice editing of the pending buffer: first tap records the spoken
  // instruction, second tap transcribes it and asks the cleanup LLM to apply
  // it to the buffer text. Any failure leaves the buffer unchanged.
  const handleVoiceEditToggle = useCallback(async () => {
    if (voiceEditState === "listening") {
      const { text: command, error } = await whisper.stopRecording();
      if (!command) {
        setVoiceEditState("idle");
        setVoiceEditError(error ?? "No instruction heard");
        return;
      }
      setVoiceEditState("applying");
      try {
        // editText can't be null while the buffer is shown
        const result = await applyVoiceEdit(editText ?? "", command);
        setEditText(result.text);
        setVoiceEditError(null);
      } catch (e) {
        setVoiceEditError(e instanceof Error ? e.message : "Edit failed");
      }
      setVoiceEditState("idle");
    } else if (voiceEditState === "idle") {
      setVoiceEditError(null);
      setVoiceEditState("listening");
      await whisper.startRecording();
    }
  }, [voiceEditState, whisper, editText]);

  const handlePinnedTap = useCallback(
    async (text: string) => {
      await hid.sendText(text);
    },
    [hid]
  );

  const isConnected = hid.status?.bluetooth === "connected";
  const box = liveBoxView({
    recording: whisper.recording,
    preview,
    finalText: null,
  });
  const bar = talkLabel({
    phase: pressPhase,
    micOpen,
    transcribing: whisper.transcribing,
    phoneMode,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Pinned items — fixed at top, never scrolls away */}
      {store.pinnedEntries.length > 0 && (
        <div className="flex-shrink-0 w-full px-6 pt-6 mb-4 overflow-x-auto">
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

      {/* Scrollable content area: the toggles and notes. The live words box
          and the Talk bar sit below it, at the foot of the screen, under the
          thumb. */}
      <div className="min-h-0 flex-1 overflow-y-auto flex flex-col items-center px-6 pt-6 pb-4">
        {/* Kill switch — stops in-progress typing on the host and releases any
            stuck (auto-repeating) key. Kept outside the edit-buffer branch so
            it's reachable in every screen state. */}
        {isConnected && (
          <div className="flex-shrink-0 w-full mb-2 flex justify-center">
            <button
              onClick={() => hid.stopTransmission()}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                hid.status?.typing
                  ? "bg-red-600 text-white animate-pulse hover:bg-red-500"
                  : "bg-gray-800 text-red-400 hover:bg-gray-700"
              }`}
            >
              ⏹ Stop typing
            </button>
          </div>
        )}

        {/* Edit buffer */}
        {editText !== null ? (
          <EditBuffer
            text={editText}
            onChange={setEditText}
            onSend={handleSendEdit}
            onDiscard={() => {
              setEditText(null);
              setVoiceEditState("idle");
              setVoiceEditError(null);
            }}
            voiceEdit={
              whisper.status?.cleanup_available || voiceEditState !== "idle"
                ? {
                    state: voiceEditState,
                    error: voiceEditError,
                    onToggle: handleVoiceEditToggle,
                  }
                : null
            }
          />
        ) : (
          <>
            {/* Connection indicator */}
            <p className="mt-4 text-sm text-gray-500">
              {isConnected
                ? `Connected to ${hid.status?.device}`
                : "Not connected"}
            </p>

            {/* Target app — decides how line breaks are typed */}
            <TargetModeToggle
              target={target.target}
              targets={target.targets}
              onSelect={target.setTarget}
            />

            {/* This phone: keep the dictation here (copy/share), not Bluetooth */}
            <PhoneModeToggle
              sendTo={settings.sendTo}
              onChange={(sendTo) => onUpdateSettings({ sendTo })}
            />

            {/* Zoom mode quick toggle — release headset mic to the laptop */}
            <ZoomModeToggle status={hid.status} onToggle={hid.setHeadsetMic} />

            {/* Type clipboard: types what is on the phone clipboard on the host */}
            <TypeClipboardButton
              target={target.target}
              settings={settings}
              hid={hid}
              store={store}
            />

            {/* Front message: the newest dictation's History entry, with
                the same action row. Gone when the entry is deleted. */}
            {front && !lastError && (
              <div
                data-testid="front-message"
                className="mt-4 w-full max-w-sm rounded border border-gray-700 bg-gray-900 p-3"
              >
                {frontEditText !== null ? (
                  <EntryEditor
                    text={frontEditText}
                    onChange={setFrontEditText}
                    onSave={saveFrontEdit}
                    onCancel={() => setFrontEditText(null)}
                  />
                ) : (
                  <>
                    <EntryWords
                      onLongPress={() => setFrontMenuOpen(true)}
                      className="text-sm text-white whitespace-pre-wrap break-words max-h-40 overflow-y-auto"
                    >
                      {front.text}
                    </EntryWords>
                    <p
                      className={`mt-1 h-4 text-xs ${
                        copyNotice === "copied"
                          ? "text-green-400"
                          : "text-yellow-400"
                      }`}
                    >
                      {copyNotice === "copied"
                        ? "Copied"
                        : copyNotice === "tap"
                          ? "Tap Copy"
                          : ""}
                    </p>
                    <EntryMenu
                      open={frontMenuOpen}
                      onClose={() => setFrontMenuOpen(false)}
                      sendDisabled={sendDisabledFor(settings.sendTo)}
                      onSend={() => sendEntry(front.text, { sendTo: settings.sendTo, hid })}
                      onCopy={() => handleFrontCopy(front.text)}
                      onEdit={() => setFrontEditText(editEntry(front).editText)}
                      onDelete={() => deleteEntry(front.id, store)}
                    />
                  </>
                )}
              </div>
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

      {/* Controls at the foot, directly above the tab bar: the live words box,
          then the Talk bar, last. Hidden while the edit buffer is open. */}
      {editText === null && (
        <div
          data-testid="talk-controls"
          className="flex shrink-0 flex-col items-center gap-3 border-t border-gray-800 bg-black px-4 pt-3 pb-4"
        >
          {/* Live words box: what the dictation is doing, then its result */}
          <div
            role="status"
            aria-live="polite"
            data-testid="live-transcript"
            ref={liveBoxRef}
            className="flex min-h-[3rem] max-h-40 w-full max-w-xl flex-col items-center justify-end overflow-y-auto text-center text-sm"
          >
            {box?.kind === "note" ? (
              <p className="text-gray-100">{box.text}</p>
            ) : box?.kind === "words" ? (
              <p className="text-gray-100">
                {box.text}
                {box.tail && (
                  <>
                    {box.text ? " " : ""}
                    <span className="text-muted">{box.tail}</span>
                  </>
                )}
              </p>
            ) : box?.kind === "listening" ? (
              <p className="text-gray-100">Listening…</p>
            ) : (
              <>
                {lastStats && !lastError && (
                  <p className="mt-1 text-gray-600 text-xs">
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
                {lastError && <p className="text-red-400">{lastError}</p>}
              </>
            )}
          </div>

          {/* Talk bar: hold to talk, or tap to keep it on */}
          <button
            type="button"
            disabled={whisper.transcribing}
            onPointerDown={onBarPointerDown}
            onPointerUp={pressUp}
            onPointerCancel={pressCancel}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={onBarKeyDown}
            onKeyUp={onBarKeyUp}
            className={`flex h-24 w-full max-w-xl touch-none select-none flex-col items-center justify-center gap-1 rounded-3xl text-base font-semibold transition-colors [-webkit-touch-callout:none] disabled:cursor-not-allowed disabled:opacity-45 ${
              pressPhase === "idle"
                ? "bg-accent text-accent-fg"
                : "bg-needs text-canvas animate-pulse"
            }`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="26"
              height="26"
              fill="currentColor"
            >
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
            </svg>
            <span>{bar.label}</span>
            {bar.sub && (
              <span className="text-xs font-normal opacity-80">{bar.sub}</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
