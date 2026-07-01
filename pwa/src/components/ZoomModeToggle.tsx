import type { HidStatus } from "../types";

interface ZoomModeToggleProps {
  status: HidStatus | null;
  onToggle: (headsetMicEnabled: boolean) => void;
}

/**
 * Quick pill for sharing the headset with a laptop. While the HID service
 * holds the headset's SCO mic link, the laptop can't open its own call-audio
 * channel, so Zoom gets no headset mic. Zoom mode ON releases the link
 * (dictation falls back to the phone's built-in mic) until toggled back off.
 * Hidden when no headset mic is present or the APK predates /headset-mic.
 */
export function ZoomModeToggle({ status, onToggle }: ZoomModeToggleProps) {
  const mic = status?.headset_mic;
  if (!mic || mic.enabled === undefined) return null;
  // Show while a headset is present, and always while Zoom mode is on so it
  // can be turned back off even if the headset drops off the phone's list.
  if (!mic.available && mic.enabled) return null;

  const zoomMode = !mic.enabled;

  return (
    <div className="mt-2 flex flex-col items-center">
      <button
        onClick={() => onToggle(zoomMode)}
        className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
          zoomMode
            ? "bg-violet-600 text-white"
            : "bg-gray-800 text-gray-500 hover:bg-gray-700"
        }`}
      >
        🎧 Zoom mode {zoomMode ? "on" : "off"}
      </button>
      {zoomMode && (
        <p className="mt-1 text-xs text-gray-500 max-w-xs text-center">
          Headset mic released for your laptop — dictation uses the phone mic
        </p>
      )}
    </div>
  );
}
