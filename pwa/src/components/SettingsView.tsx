import { useEffect, useState } from "react";
import type { CleanupTiming, ModelInfo, Settings, TargetInfo } from "../types";
import { whisperStatus, hidStatus, hidKeepLinkWarm, getModels, getWhisperSettings, putWhisperSettings } from "../lib/api";
import { WordCorrections } from "./WordCorrections";
import { SymbolReplacements } from "./SymbolReplacements";
import { CleanupSettings } from "./CleanupSettings";
import { CleanupToggle } from "./CleanupToggle";
import { SymbolModeToggle } from "./SymbolModeToggle";
import { SettingsSection } from "./SettingsSection";
import { SettingsRow, SettingsSwitchRow } from "./SettingsRow";

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
  /** Every History entry; the cleanup timing averages come from these */
  entries: { timing?: CleanupTiming }[];
}

export function SettingsView({ settings, onUpdate, onShowSetup, onShowDebug, target, entries }: SettingsViewProps) {
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

      <SettingsSection title="Talk">
        <SymbolModeToggle />
        <CleanupToggle target={target?.name ?? null} />
        <SettingsSwitchRow
          label="Edit before send"
          hint="Review and fix the text before it is typed."
          checked={settings.editBeforeSend}
          onChange={(e) => onUpdate({ editBeforeSend: e })}
        />
      </SettingsSection>

      <SettingsSection title="Typing">
        {/* Target app: set from the Talk screen, shown here for reference
            since it used to be the "Claude Code newlines" checkbox. */}
        {target && (
          <SettingsRow
            label={`Typing to: ${target.label}`}
            hint='Change it with the "Typing to" pill on the Talk screen.'
            info={`${target.description}. It also picks which assistant the "prompt" cleanup style writes for.`}
          />
        )}
        <SettingsSwitchRow
          label="Add newline after each segment"
          hint="A line break after every piece you dictate."
          checked={settings.appendNewline}
          onChange={(e) =>
            onUpdate({
              appendNewline: e,
              appendSpace: e ? false : settings.appendSpace,
            })
          }
        />
        <SettingsSwitchRow
          label="Add space between segments"
          hint="A space after every piece you dictate."
          checked={settings.appendSpace}
          onChange={(e) =>
            onUpdate({
              appendSpace: e,
              appendNewline: e ? false : settings.appendNewline,
            })
          }
        />
        <SettingsSwitchRow
          label="Newline after end of recording"
          hint="Press Enter when you stop, to send the line."
          checked={settings.newlineAfterEnd}
          onChange={(e) => onUpdate({ newlineAfterEnd: e })}
        />
        <SettingsRow
          label={`Keystroke delay: ${settings.keystrokeDelay}ms`}
          hint={`About ${typingCharsPerSec(settings.keystrokeDelay)} characters/sec.`}
          info="Pause between keystrokes. How low you can go depends on the app you're typing into, not the computer: a terminal is good down to 5ms, a heavier editor may need 40ms or more. Below that a terminal starts dropping whole clauses silently."
        >
          <input
            type="range"
            min={0}
            max={100}
            value={settings.keystrokeDelay}
            aria-label="Keystroke delay"
            onChange={(e) =>
              onUpdate({ keystrokeDelay: parseInt(e.target.value) })
            }
            className="w-full min-h-[44px] accent-sky-500"
          />
          {settings.keystrokeDelay < HEAVY_EDITOR_HINT_BELOW_MS && (
            <p className="text-xs text-amber-500 mt-1">
              If a long paste loses characters part-way through, raise this.
              Measured: vim in a terminal was perfect at 10ms, while Windows
              Notepad needed {HEAVY_EDITOR_HINT_BELOW_MS}ms and dropped ~7% of
              a paste at 20ms.
            </p>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Speech">
        {/* Speech model: Parakeet is the only engine, so there is nothing to pick */}
        <SettingsRow
          label="Speech model"
          hint={`Parakeet TDT 0.6B v2${
            speechModel?.downloaded ? ` (${speechModel.size_mb} MB)` : ""
          }. The only engine; it runs on this phone.`}
        >
          {speechModel && !speechModel.downloaded && (
            <p className="text-xs text-red-400">
              Not installed. In Termux run: ./update-model.sh parakeet
            </p>
          )}
        </SettingsRow>
        <SettingsRow label="Language">
          <select
            value={settings.language}
            aria-label="Language"
            onChange={(e) => onUpdate({ language: e.target.value })}
            className="w-full min-h-[44px] bg-gray-800 text-white border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="en">English</option>
            <option value="auto">Auto-detect</option>
          </select>
        </SettingsRow>
        <SettingsSwitchRow
          label="Noise reduction"
          hint="Filter background noise out of the recording."
          checked={noiseReduction}
          onChange={async (enabled) => {
            setNoiseReduction(enabled);
            try {
              const updated = await putWhisperSettings({ noise_reduction: enabled });
              setNoiseReduction(updated.noise_reduction);
            } catch {
              setNoiseReduction(!enabled);
            }
          }}
        />
        {keepLinkWarm !== null && (
          <SettingsSwitchRow
            label="Keep the headset link warm"
            hint="Starts the first word sooner, but silences other audio."
            info="Off: the headset's call link opens only while you dictate, so music, video and voice from other apps play normally on the headset the rest of the time. On: the link is held whenever the headset is connected, which starts the first word a moment sooner but silences other audio on a headset with a mic."
            checked={keepLinkWarm}
            onChange={async (on) => {
              setKeepLinkWarm(on);
              try {
                const updated = await hidKeepLinkWarm(on);
                setKeepLinkWarm(updated.keep_warm);
              } catch {
                setKeepLinkWarm(!on);
              }
            }}
          />
        )}
        {micSourceSelectable && (
          <SettingsRow
            label="Mic audio source"
            hint="Only for a headset that shows green but records the phone mic."
            info="Only change this if the headset dot is green but dictation still picks up the phone's own mic. Run the mic test in the setup guide after switching."
          >
            <select
              value={micSource}
              aria-label="Mic audio source"
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
              className="w-full min-h-[44px] bg-gray-800 text-white border border-gray-700 rounded px-3 py-2 text-sm"
            >
              <option value="mic">Default (built-in mic)</option>
              <option value="voice_communication">
                Voice communication (Bluetooth headset)
              </option>
              <option value="voice_recognition">Voice recognition (no AGC)</option>
              <option value="camcorder">Camcorder (rear mic)</option>
            </select>
            {micSourceError && (
              <p className="text-xs text-red-400 mt-1">{micSourceError}</p>
            )}
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection title="Cleanup">
        <CleanupSettings entries={entries} />
      </SettingsSection>

      <SettingsSection title="Corrections and symbols">
        <div className="px-4 py-3">
          <WordCorrections />
        </div>
        <div className="px-4 py-3">
          <SymbolReplacements />
        </div>
      </SettingsSection>

      <SettingsSection title="About">
        <SettingsRow
          label="Setup guide"
          hint="Checklist for a new phone or a broken component."
          control={
            <button
              onClick={onShowSetup}
              className="min-h-[44px] px-4 rounded-lg bg-gray-800 text-sky-400 text-sm font-medium"
            >
              Open
            </button>
          }
        />
        <SettingsRow
          label="Debug log"
          hint="Recent events from the HID service and Whisper server."
          info='After a paste, look for the "Typed N chars as M reports" line: it says how long the send took and whether the Bluetooth link kept up.'
          control={
            <button
              onClick={onShowDebug}
              className="min-h-[44px] px-4 rounded-lg bg-gray-800 text-sky-400 text-sm font-medium"
            >
              Open
            </button>
          }
        />
        <div className="px-4 py-3 space-y-1">
          <p className="text-xs text-gray-500">PWA v{__APP_VERSION__}</p>
          <p className="text-xs text-gray-500">
            Whisper server {whisperVersion ? `v${whisperVersion}` : "(not connected)"}
          </p>
          <p className="text-xs text-gray-500">
            HID service {hidVersion ? `v${hidVersion}` : "(not connected)"}
          </p>
          <p className="text-xs text-gray-600 pt-1">
            Settings are stored locally in your browser.
          </p>
        </div>
      </SettingsSection>
    </div>
  );
}
