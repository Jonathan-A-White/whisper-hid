import type { Settings } from "../types";

interface SettingsViewProps {
  settings: Settings;
  onUpdate: (partial: Partial<Settings>) => void;
}

export function SettingsView({ settings, onUpdate }: SettingsViewProps) {
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

      {/* Whisper model (display only) */}
      <div>
        <label className="text-sm text-gray-300 block mb-1">
          Whisper model (change via Termux)
        </label>
        <p className="text-sm text-gray-500 bg-gray-900 rounded px-3 py-2">
          {settings.whisperModel}
        </p>
      </div>

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

      <div className="pt-4 border-t border-gray-800">
        <p className="text-xs text-gray-600">
          Whisper Keyboard PWA v1.0. Settings are stored locally in your
          browser.
        </p>
      </div>
    </div>
  );
}
