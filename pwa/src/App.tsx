import { useState } from "react";
import { hasToken } from "./lib/api";
import { useWhisper } from "./hooks/useWhisper";
import { useHidService } from "./hooks/useHidService";
import { useTranscriptStore } from "./hooks/useTranscriptStore";
import { StatusBar } from "./components/StatusBar";
import { TalkView } from "./components/TalkView";
import { HistoryView } from "./components/HistoryView";
import { SettingsView } from "./components/SettingsView";
import { DebugLog } from "./components/DebugLog";
import type { Tab, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem("whisper_settings");
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("talk");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showDebug, setShowDebug] = useState(false);

  const whisper = useWhisper();
  const hid = useHidService(settings);
  const store = useTranscriptStore();

  const updateSettings = (partial: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      localStorage.setItem("whisper_settings", JSON.stringify(next));
      return next;
    });
  };

  if (!hasToken()) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-8">
        <div className="text-center">
          <h1 className="text-xl font-bold text-white mb-4">
            Not Authenticated
          </h1>
          <p className="text-gray-400 mb-6">
            Open this app from the Whisper HID Service Android app to
            authenticate.
          </p>
          <p className="text-gray-500 text-sm">
            Tap &quot;Open Whisper Keyboard&quot; in the Android app to get a
            fresh auth token.
          </p>
        </div>
      </div>
    );
  }

  if (hid.authError) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-8">
        <div className="text-center">
          <h1 className="text-xl font-bold text-red-400 mb-4">
            Authentication Failed
          </h1>
          <p className="text-gray-400 mb-6">
            Your auth token is invalid or expired. The HID service may have
            restarted.
          </p>
          <p className="text-gray-500 text-sm">
            Re-open this app from the Whisper HID Service Android app to get a
            fresh token.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black flex flex-col">
      <StatusBar
        hidStatus={hid.status}
        hidReachable={hid.reachable}
        whisperStatus={whisper.status}
        whisperError={whisper.error}
        onRestart={hid.restart}
        onShowDebug={() => setShowDebug(true)}
      />

      <main className="flex-1 overflow-y-auto">
        {showDebug ? (
          <DebugLog onClose={() => setShowDebug(false)} />
        ) : tab === "talk" ? (
          <TalkView
            whisper={whisper}
            hid={hid}
            store={store}
            settings={settings}
          />
        ) : tab === "history" ? (
          <HistoryView store={store} hid={hid} />
        ) : (
          <SettingsView settings={settings} onUpdate={updateSettings} />
        )}
      </main>

      {!showDebug && (
        <nav className="flex border-t border-gray-800 bg-gray-950">
          {(["talk", "history", "settings"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-3 text-sm font-medium capitalize ${
                tab === t
                  ? "text-sky-400 border-t-2 border-sky-400"
                  : "text-gray-500"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
