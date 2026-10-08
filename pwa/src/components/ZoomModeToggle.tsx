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
 * Hidden only when the APK predates /headset-mic. With no headset on the
 * phone's list and Zoom mode off it stays, greyed, with a line saying why.
 */
export function ZoomModeToggle({ status, onToggle }: ZoomModeToggleProps) {
  const mic = status?.headset_mic;
  if (!mic || mic.enabled === undefined) return null;
  const zoomMode = !mic.enabled;
  // With no headset on the phone's list and Zoom mode off there is nothing to
  // release: keep the pill (a control he has used must not vanish) but grey it
  // and say why. With Zoom mode on it stays tappable so it can be turned off.
  const noHeadset = !mic.available && !zoomMode;

  return (
    <div className="mt-2 flex flex-col items-center">
      <button
        onClick={() => onToggle(zoomMode)}
        disabled={noHeadset}
        className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
          zoomMode
            ? "bg-violet-600 text-white"
            : noHeadset
              ? "bg-gray-800 text-gray-600 opacity-50 cursor-not-allowed"
              : "bg-gray-800 text-gray-500 hover:bg-gray-700"
        }`}
      >
        🎧 Zoom mode {zoomMode ? "on" : "off"}
      </button>
      {noHeadset && (
        <p className="mt-1 text-xs text-gray-500 max-w-xs text-center">
          No headset on the phone
        </p>
      )}
      {zoomMode && (
        <p className="mt-1 text-xs text-gray-500 max-w-xs text-center">
          Headset mic released for your laptop — dictation uses the phone mic
        </p>
      )}
    </div>
  );
}
