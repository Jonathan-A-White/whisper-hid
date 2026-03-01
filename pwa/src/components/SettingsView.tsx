import { useEffect, useState } from "react";
import type { ModelInfo, Settings } from "../types";
import { whisperStatus, hidStatus, getModels, switchModel, getWhisperSettings, putWhisperSettings } from "../lib/api";
import { WordCorrections } from "./WordCorrections";
import { ModelBenchmark } from "./ModelBenchmark";

interface SettingsViewProps {
  settings: Settings;
  onUpdate: (partial: Partial<Settings>) => void;
}

export function SettingsView({ settings, onUpdate }: SettingsViewProps) {
  const [whisperVersion, setWhisperVersion] = useState<string | null>(null);
  const [hidVersion, setHidVersion] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [activeModel, setActiveModel] = useState<string>(settings.whisperModel);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [noiseReduction, setNoiseReduction] = useState(false);

  useEffect(() => {
    whisperStatus()
      .then((d) => {
        setWhisperVersion(d.version ?? null);
        if (d.model) {
          setActiveModel(d.model);
          onUpdate({ whisperModel: d.model });
        }
      })
      .catch(() => setWhisperVersion(null));
    hidStatus()
      .then((d) => setHidVersion(d.version ?? null))
      .catch(() => setHidVersion(null));
    getModels()
      .then((d) => setModels(d.models))
      .catch(() => setModels([]));
    getWhisperSettings()
      .then((s) => setNoiseReduction(s.noise_reduction))
      .catch(() => {});
  }, []);

  return (
    <div className="p-4 space-y-6">
      <h2 className="text-lg font-semibold text-white">Settings</h2>

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

      {/* Keystroke delay */}
      <div>
        <label className="text-sm text-gray-300 block mb-1">
          Keystroke delay: {settings.keystrokeDelay}ms
        </label>
        <input
          type="range"
          min={0}
          max={50}
          value={settings.keystrokeDelay}
          onChange={(e) =>
            onUpdate({ keystrokeDelay: parseInt(e.target.value) })
          }
          className="w-full accent-sky-500"
        />
      </div>

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

      {/* Whisper model selector */}
      <div>
        <label className="text-sm text-gray-300 block mb-1">
          Whisper model
        </label>
        {models.length > 0 ? (
          <>
            <select
              value={activeModel}
              disabled={modelSwitching}
              onChange={async (e) => {
                const name = e.target.value;
                setModelError(null);
                setModelSwitching(true);
                try {
                  await switchModel(name);
                  setActiveModel(name);
                  onUpdate({ whisperModel: name });
                  getModels()
                    .then((d) => setModels(d.models))
                    .catch(() => {});
                } catch (err) {
                  setModelError(
                    err instanceof Error ? err.message : "Failed to switch model"
                  );
                } finally {
                  setModelSwitching(false);
                }
              }}
              className="w-full bg-gray-900 text-white border border-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
            >
              {models
                .filter((m) => m.downloaded)
                .map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({m.size_mb} MB)
                  </option>
                ))}
            </select>
            {models.some((m) => !m.downloaded) && (
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-1">
                  Available to download via Termux:
                </p>
                <div className="space-y-1">
                  {models
                    .filter((m) => !m.downloaded)
                    .map((m) => (
                      <div
                        key={m.name}
                        className="flex items-center justify-between bg-gray-900 rounded px-3 py-1.5"
                      >
                        <div>
                          <span className="text-sm text-gray-400">
                            {m.name}
                          </span>
                          {m.description && (
                            <span className="text-xs text-gray-600 ml-2">
                              {m.description}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-gray-600 whitespace-nowrap ml-2">
                          ~{m.size_mb} MB
                        </span>
                      </div>
                    ))}
                </div>
                <p className="text-xs text-gray-600 mt-1.5">
                  Run: ./update-model.sh &lt;name&gt;
                </p>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-500 bg-gray-900 rounded px-3 py-2">
            {activeModel}
          </p>
        )}
        {modelSwitching && (
          <p className="text-xs text-sky-400 mt-1">Switching model...</p>
        )}
        {modelError && (
          <p className="text-xs text-red-400 mt-1">{modelError}</p>
        )}
      </div>

      {/* Model benchmark */}
      {models.length > 0 && (
        <div className="pt-4 border-t border-gray-800">
          <ModelBenchmark models={models} />
        </div>
      )}

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
