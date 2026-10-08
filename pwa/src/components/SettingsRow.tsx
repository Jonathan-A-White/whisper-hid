import { useState, type ReactNode } from "react";

interface SettingsRowProps {
  label: string;
  /** One short grey line under the label */
  hint?: string;
  /** Longer explanation, shown inline when the 'i' beside the label is tapped */
  info?: string;
  /** Control at the right of the label */
  control?: ReactNode;
  /** Full-width content under the label and hint (slider, select, lists) */
  children?: ReactNode;
}

/** One row of a settings card: label, hint, and a control. */
export function SettingsRow({ label, hint, info, control, children }: SettingsRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-4 py-2 min-h-[44px]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-200">{label}</span>
            {info && (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-label={`What is ${label}?`}
                aria-expanded={open}
                className="flex items-center justify-center min-h-[44px] min-w-[44px] -my-2.5 -mx-2.5"
              >
                <span
                  className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold italic transition-colors ${
                    open ? "bg-sky-600 text-white" : "bg-gray-800 text-gray-400"
                  }`}
                >
                  i
                </span>
              </button>
            )}
          </div>
          {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {info && open && (
        <p className="mt-2 text-xs text-gray-400 bg-gray-800 rounded-lg px-3 py-2">{info}</p>
      )}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

interface SettingsSwitchRowProps {
  label: string;
  hint?: string;
  info?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Extra full-width content under the row (e.g. a style picker) */
  children?: ReactNode;
}

/** The one on/off style for all of Settings: a row with a switch at the right. */
export function SettingsSwitchRow({ label, hint, info, checked, onChange, children }: SettingsSwitchRowProps) {
  return (
    <SettingsRow
      label={label}
      hint={hint}
      info={info}
      control={
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          onClick={() => onChange(!checked)}
          className="flex items-center justify-center min-h-[44px] min-w-[44px]"
        >
          <span
            className={`relative block h-7 w-12 rounded-full transition-colors ${
              checked ? "bg-sky-500" : "bg-gray-700"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                checked ? "translate-x-5" : ""
              }`}
            />
          </span>
        </button>
      }
    >
      {children}
    </SettingsRow>
  );
}
