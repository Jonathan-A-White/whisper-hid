import { CHIP_NOTE_CLASS, chipClass } from "../lib/chip";
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
    <>
      <button
        onClick={() => onToggle(zoomMode)}
        disabled={noHeadset}
        className={
          zoomMode
            ? chipClass("violet")
            : `${chipClass()}${noHeadset ? " opacity-50 cursor-not-allowed" : ""}`
        }
      >
        🎧 Zoom mode {zoomMode ? "on" : "off"}
      </button>
      {noHeadset && (
        <p className={CHIP_NOTE_CLASS}>
          No headset on the phone
        </p>
      )}
      {zoomMode && (
        <p className={CHIP_NOTE_CLASS}>
          Headset mic released for your laptop — dictation uses the phone mic
        </p>
      )}
    </>
  );
}
