import type { SendTo } from "../types";

interface PhoneModeToggleProps {
  sendTo: SendTo;
  onChange: (sendTo: SendTo) => void;
}

/**
 * Quick pill for keeping a dictation on this phone: with it on, nothing goes
 * over Bluetooth; the text is copied and offered with Copy / Share buttons.
 */
export function PhoneModeToggle({ sendTo, onChange }: PhoneModeToggleProps) {
  const on = sendTo === "phone";
  return (
    <div className="mt-2 flex flex-col items-center">
      <button
        onClick={() => onChange(on ? "computer" : "phone")}
        className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
          on
            ? "bg-sky-600 text-white"
            : "bg-gray-800 text-gray-500 hover:bg-gray-700"
        }`}
      >
        📱 This phone {on ? "on" : "off"}
      </button>
      {on && (
        <p className="mt-1 text-xs text-gray-500 max-w-xs text-center">
          Dictation is copied here, not sent over Bluetooth
        </p>
      )}
    </div>
  );
}
