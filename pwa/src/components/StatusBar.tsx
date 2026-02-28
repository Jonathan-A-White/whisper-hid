import type { HidStatus, WhisperStatus } from "../types";

interface StatusBarProps {
  hidStatus: HidStatus | null;
  hidReachable: boolean;
  whisperStatus: WhisperStatus | null;
  whisperError: string | null;
  onRestart: () => void;
  onShowDebug: () => void;
}

export function StatusBar({
  hidStatus,
  hidReachable,
  whisperStatus,
  whisperError,
  onRestart,
  onShowDebug,
}: StatusBarProps) {
  const btState = hidStatus?.bluetooth;
  const showBanner =
    btState === "reconnecting" || btState === "failed" || !hidReachable;

  return (
    <div className="bg-gray-950 border-b border-gray-800 px-4 py-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-white">Whisper Keyboard</span>
        <div className="flex items-center gap-3">
          {/* Whisper status dot */}
          <span className="flex items-center gap-1">
            <span
              className={`w-2 h-2 rounded-full ${
                whisperStatus?.status === "ready"
                  ? "bg-green-400"
                  : "bg-red-400"
              }`}
            />
            <span className="text-gray-400 text-xs">
              {whisperStatus?.status === "ready"
                ? whisperStatus.model
                : whisperError || "offline"}
            </span>
          </span>
          {/* BT status dot */}
          <span className="flex items-center gap-1">
            <span
              className={`w-2 h-2 rounded-full ${
                btState === "connected"
                  ? "bg-green-400"
                  : btState === "reconnecting"
                    ? "bg-yellow-400"
                    : "bg-red-400"
              }`}
            />
            <span className="text-gray-400 text-xs">
              {!hidReachable
                ? "HID offline"
                : btState === "connected"
                  ? hidStatus?.device
                  : btState === "reconnecting"
                    ? `Retry ${hidStatus?.reconnect_attempt}`
                    : btState || "idle"}
            </span>
          </span>
        </div>
      </div>

      {showBanner && (
        <div className="mt-2 p-2 rounded bg-gray-900 text-sm">
          {!hidReachable ? (
            <div className="text-red-400">
              HID Service not running.{" "}
              <span className="text-gray-500">
                Open the Whisper HID app on your phone.
              </span>
            </div>
          ) : btState === "reconnecting" ? (
            <div className="text-yellow-400">
              Laptop disconnected — Reconnecting... (attempt{" "}
              {hidStatus?.reconnect_attempt} of {hidStatus?.reconnect_max})
            </div>
          ) : btState === "failed" ? (
            <div className="text-red-400">
              Connection failed — Auto-reconnect timed out
              <div className="mt-1 flex gap-2">
                <button
                  onClick={onRestart}
                  className="px-3 py-1 bg-sky-600 text-white rounded text-xs"
                >
                  Restart HID
                </button>
                <button
                  onClick={onShowDebug}
                  className="px-3 py-1 bg-gray-700 text-white rounded text-xs"
                >
                  View Debug Log
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
