import { useEffect, useState } from "react";
import type { ModelInfo, Settings, TargetInfo } from "../types";
import { whisperStatus, hidStatus, hidKeepLinkWarm, getModels, getWhisperSettings, putWhisperSettings } from "../lib/api";
import { WordCorrections } from "./WordCorrections";
import { SymbolReplacements } from "./SymbolReplacements";
import { CleanupSettings } from "./CleanupSettings";
import { CleanupToggle } from "./CleanupToggle";
import { SymbolModeToggle } from "./SymbolModeToggle";
import { TypeClipboardButton } from "./TypeClipboardButton";

/**
 * What the delay has to clear is the receiving *application*, and they
 * differ by a lot. Same laptop, same link, same 500-character paste:
 * vim in a terminal took 10ms (91 reports/s) with the text byte-identical,
 * while Windows 11 Notepad — which spell-checks and re-formats on every
 * keystroke — needed 40ms (24/s) and lost ~7% of the text at 20ms (48/s).
 * So there is no single safe number to warn against; this is only the
 * threshold below which the hint about slow editors is worth showing.
 */
const HEAVY_EDITOR_HINT_BELOW_MS = 40;

/**
 * Characters per second at a given delay. The stream costs ~2.1 reports per
 * character (a key-down and a release, plus a modifier report on shifted
 * ones) and sendReport itself measures ~1ms, so the delay is nearly the
 * whole cost.
 */
function typingCharsPerSec(delayMs: number): string {
  const perReportMs = delayMs + 1;
  return (1000 / perReportMs / 2.11).toFixed(delayMs >= 10 ? 0 : 1);
}

interface SettingsViewProps {
  settings: Settings;
  onUpdate: (partial: Partial<Settings>) => void;
  onShowSetup: () => void;
  /**
   * Open the debug log. Its only other entry point is the status banner's
   * "View Debug Log" button, which appears solely when Bluetooth has failed
   * — so the logs were unreachable in exactly the case you usually want
   * them: typing works but the text arrives wrong.
   */
  onShowDebug: () => void;
  /** Active target app, or null on a server without /target */
  target: TargetInfo | null;
  /** For Type clipboard */
  hid: {
    sendText: (text: string) => Promise<boolean>;
    sendNewline: () => Promise<void>;
  };
  store: { addEntry: (text: string) => Promise<unknown> };
}

export function SettingsView({ settings, onUpdate, onShowSetup, onShowDebug, target, hid, store }: SettingsViewProps) {
  const [whisperVersion, setWhisperVersion] = useState<string | null>(null);
  const [hidVersion, setHidVersion] = useState<string | null>(null);
  const [speechModel, setSpeechModel] = useState<ModelInfo | null>(null);
  const [noiseReduction, setNoiseReduction] = useState(false);
  // null = the APK predates the setting, so the switch is hidden
  const [keepLinkWarm, setKeepLinkWarm] = useState<boolean | null>(null);
  const [micSource, setMicSource] = useState("mic");
  const [micSourceSelectable, setMicSourceSelectable] = useState(false);
  const [micSourceError, setMicSourceError] = useState<string | null>(null);

  useEffect(() => {
    whisperStatus()
      .then((d) => {
        setWhisperVersion(d.version ?? null);
        setMicSourceSelectable(d.mic_audio_source_selectable ?? false);
      })
      .catch(() => setWhisperVersion(null));
    hidStatus()
      .then((d) => {
        setHidVersion(d.version ?? null);
        setKeepLinkWarm(d.headset_mic?.keep_warm ?? null);
      })
      .catch(() => setHidVersion(null));
    getModels()
      .then((d) => setSpeechModel(d.models[0] ?? null))
      .catch(() => setSpeechModel(null));
    getWhisperSettings()
      .then((s) => {
        setNoiseReduction(s.noise_reduction);
        if (s.mic_audio_source) setMicSource(s.mic_audio_source);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="p-4 space-y-6">
      <h2 className="text-lg font-semibold text-white">Settings</h2>

      {/* Talk options: the switches used less often than the ones on Talk */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-300">Talk options</h3>
        <div className="flex flex-col items-start gap-1">
          <SymbolModeToggle />
          <CleanupToggle target={target?.name ?? null} />
          <TypeClipboardButton
            target={target?.name ?? null}
            settings={settings}
            hid={hid}
            store={store}
          />
        </div>
      </section>

      {/* Toggle: Edit before send */}
      <label className="flex items-center justify-between">
        <span className="text-sm text-gray-300">Edit before send</span>
        <input
          type="checkbox"
          checked={settings.editBeforeSend}
          onChange={(e) => onUpdate({ editBeforeSend: e.target.checked })}
          className="w-5 h-5 accent-sky-500"
        />
      </label>

      {/* Toggle: Append newline */}
      <label className="flex items-center justify-between">
        <span className="text-sm text-gray-300">
          Add newline after each segment
        </span>
        <input
          type="checkbox"
          checked={settings.appendNewline}
          onChange={(e) =>
            onUpdate({
              appendNewline: e.target.checked,
              appendSpace: e.target.checked ? false : settings.appendSpace,
            })
          }
          className="w-5 h-5 accent-sky-500"
        />
      </label>

      {/* Toggle: Append space */}
      <label className="flex items-center justify-between">
        <span className="text-sm text-gray-300">
          Add space between segments
        </span>
        <input
          type="checkbox"
          checked={settings.appendSpace}
          onChange={(e) =>
            onUpdate({
              appendSpace: e.target.checked,
              appendNewline: e.target.checked ? false : settings.appendNewline,
            })
          }
          className="w-5 h-5 accent-sky-500"
        />
      </label>

      {/* Toggle: Newline after end of recording */}
      <label className="flex items-center justify-between">
        <span className="text-sm text-gray-300">
          Newline after end of recording
        </span>
        <input
          type="checkbox"
          checked={settings.newlineAfterEnd}
          onChange={(e) => onUpdate({ newlineAfterEnd: e.target.checked })}
          className="w-5 h-5 accent-sky-500"
        />
      </label>

      {/* Target app — set from the Talk screen, shown here for reference
          since it used to be the "Claude Code newlines" checkbox. */}
      {target && (
        <div>
          <span className="text-sm text-gray-300">Typing to: {target.label}</span>
          <p className="text-xs text-gray-500 mt-1">
            {target.description}. Change it with the &quot;Typing to&quot; pill
            on the Talk screen — it also picks which assistant the
            &quot;prompt&quot; cleanup style writes for.
          </p>
        </div>
      )}

      {/* Keystroke delay */}
      <div>
        <label className="text-sm text-gray-300 block mb-1">
          Keystroke delay: {settings.keystrokeDelay}ms
          <span className="text-gray-500">
            {" — about "}
            {typingCharsPerSec(settings.keystrokeDelay)} characters/sec
          </span>
        </label>
        <input
          type="range"
          min={0}
          max={100}
          value={settings.keystrokeDelay}
          onChange={(e) =>
            onUpdate({ keystrokeDelay: parseInt(e.target.value) })
          }
          className="w-full accent-sky-500"
        />
        <p className="text-xs text-gray-500 mt-1">
          Pause between keystrokes. How low you can go depends on the app
          you're typing into, not the computer — a terminal is good down to
          5ms, a heavier editor may need 40ms or more. Below that a
          terminal starts dropping whole clauses silently.
        </p>
        {settings.keystrokeDelay < HEAVY_EDITOR_HINT_BELOW_MS && (
          <p className="text-xs text-amber-500 mt-1">
            If a long paste loses characters part-way through, raise this.
            Measured: vim in a terminal was perfect at 10ms, while Windows
            Notepad needed {HEAVY_EDITOR_HINT_BELOW_MS}ms and dropped ~7% of
            a paste at 20ms.
          </p>
        )}
      </div>

      {/* Toggle: Keep the headset link warm */}
      {keepLinkWarm !== null && (
        <div>
          <label className="flex items-center justify-between">
            <span className="text-sm text-gray-300">
              Keep the headset link warm
            </span>
            <input
              type="checkbox"
              checked={keepLinkWarm}
              onChange={async (e) => {
                const on = e.target.checked;
                setKeepLinkWarm(on);
                try {
                  const updated = await hidKeepLinkWarm(on);
                  setKeepLinkWarm(updated.keep_warm);
                } catch {
                  setKeepLinkWarm(!on);
                }
              }}
              className="w-5 h-5 accent-sky-500"
            />
          </label>
          <p className="text-xs text-gray-500 mt-1">
            Off: the headset's call link opens only while you dictate, so music,
            video and voice from other apps play normally on the headset the
            rest of the time. On: the link is held whenever the headset is
            connected, which starts the first word a moment sooner but silences
            other audio on a headset with a mic.
          </p>
        </div>
      )}

      {/* Toggle: Noise reduction */}
      <label className="flex items-center justify-between">
        <span className="text-sm text-gray-300">Noise reduction</span>
        <input
          type="checkbox"
          checked={noiseReduction}
          onChange={async (e) => {
            const enabled = e.target.checked;
            setNoiseReduction(enabled);
            try {
              const updated = await putWhisperSettings({ noise_reduction: enabled });
              setNoiseReduction(updated.noise_reduction);
            } catch {
              setNoiseReduction(!enabled);
            }
          }}
          className="w-5 h-5 accent-sky-500"
        />
      </label>

      {/* Mic audio source */}
      {micSourceSelectable && (
        <div>
          <label className="text-sm text-gray-300 block mb-1">
            Mic audio source
          </label>
          <select
            value={micSource}
            onChange={async (e) => {
              const source = e.target.value;
              const previous = micSource;
              setMicSource(source);
              setMicSourceError(null);
              try {
                const updated = await putWhisperSettings({
                  mic_audio_source: source,
                });
                setMicSource(updated.mic_audio_source);
              } catch (err) {
                setMicSource(previous);
                setMicSourceError(
                  err instanceof Error ? err.message : "Failed to switch source"
                );
              }
            }}
            className="w-full bg-gray-900 text-white border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="mic">Default (built-in mic)</option>
            <option value="voice_communication">
              Voice communication (Bluetooth headset)
            </option>
            <option value="voice_recognition">Voice recognition (no AGC)</option>
            <option value="camcorder">Camcorder (rear mic)</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Only change this if the headset dot is green but dictation still
            picks up the phone's own mic. Run the mic test in the setup guide
            after switching.
          </p>
          {micSourceError && (
            <p className="text-xs text-red-400 mt-1">{micSourceError}</p>
          )}
        </div>
      )}

      {/* Speech model: Parakeet is the only engine, so there is nothing to pick */}
      <div>
        <label className="text-sm text-gray-300 block mb-1">
          Speech model
        </label>
        <p className="text-sm text-gray-300 bg-gray-900 rounded px-3 py-2">
          Parakeet TDT 0.6B v2
          {speechModel?.downloaded && (
            <span className="text-xs text-gray-500 ml-2">
              ({speechModel.size_mb} MB)
            </span>
          )}
        </p>
        {speechModel && !speechModel.downloaded && (
          <p className="text-xs text-red-400 mt-1">
            Not installed. In Termux run: ./update-model.sh parakeet
          </p>
        )}
      </div>

      {/* Speech cleanup model selector */}
      <CleanupSettings />

      {/* Language */}
      <div>
        <label className="text-sm text-gray-300 block mb-1">Language</label>
        <select
          value={settings.language}
          onChange={(e) => onUpdate({ language: e.target.value })}
          className="w-full bg-gray-900 text-white border border-gray-700 rounded px-3 py-2 text-sm"
        >
          <option value="en">English</option>
          <option value="auto">Auto-detect</option>
        </select>
      </div>

      {/* Word corrections */}
      <div className="pt-4 border-t border-gray-800">
        <WordCorrections />
      </div>

      {/* Symbol replacements */}
      <div className="pt-4 border-t border-gray-800">
        <SymbolReplacements />
      </div>

      {/* Setup guide */}
      <div className="pt-4 border-t border-gray-800">
        <button
          onClick={onShowSetup}
          className="w-full py-2 rounded bg-gray-800 text-sky-400 text-sm font-medium"
        >
          Setup guide
        </button>
        <p className="text-xs text-gray-600 mt-1.5">
          Step-by-step checklist for setting up a new phone or fixing a
          broken component.
        </p>
      </div>

      {/* Debug log */}
      <div className="pt-4 border-t border-gray-800">
        <button
          onClick={onShowDebug}
          className="w-full py-2 rounded bg-gray-800 text-sky-400 text-sm font-medium"
        >
          Debug log
        </button>
        <p className="text-xs text-gray-600 mt-1.5">
          Recent events from the HID service and Whisper server. After a
          paste, look for the "Typed N chars as M reports" line — it says
          how long the send took and whether the Bluetooth link kept up.
        </p>
      </div>

      <div className="pt-4 border-t border-gray-800 space-y-1">
        <p className="text-xs text-gray-600">
          PWA v{__APP_VERSION__}
        </p>
        <p className="text-xs text-gray-600">
          Whisper server {whisperVersion ? `v${whisperVersion}` : "(not connected)"}
        </p>
        <p className="text-xs text-gray-600">
          HID service {hidVersion ? `v${hidVersion}` : "(not connected)"}
        </p>
        <p className="text-xs text-gray-700 mt-2">
          Settings are stored locally in your browser.
        </p>
      </div>
    </div>
  );
}
