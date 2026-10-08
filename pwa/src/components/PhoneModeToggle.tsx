import { CHIP_NOTE_CLASS, chipClass } from "../lib/chip";
import type { SendTo } from "../types";

interface PhoneModeToggleProps {
  sendTo: SendTo;
  onChange: (sendTo: SendTo) => void;
}

/**
 * Quick chip for keeping a dictation on this phone: with it on, nothing goes
 * over Bluetooth; the text is copied and offered with Copy / Share buttons.
 */
export function PhoneModeToggle({ sendTo, onChange }: PhoneModeToggleProps) {
  const on = sendTo === "phone";
  return (
    <>
      <button
        onClick={() => onChange(on ? "computer" : "phone")}
        className={chipClass(on ? "violet" : undefined)}
      >
        📱 This phone {on ? "on" : "off"}
      </button>
      {on && (
        <p className={CHIP_NOTE_CLASS}>
          Dictation is copied here, not sent over Bluetooth
        </p>
      )}
    </>
  );
}
