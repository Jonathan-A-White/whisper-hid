import type { ReactNode } from "react";
import { useLongPress } from "../hooks/useLongPress";

interface EntryWordsProps {
  onLongPress: () => void;
  className?: string;
  children: ReactNode;
}

/** An entry's words. A long press opens the options menu; a tap does nothing.
 *  Text selection is off so the hold is not taken for a select. */
export function EntryWords({ onLongPress, className = "", children }: EntryWordsProps) {
  const handlers = useLongPress(onLongPress);
  return (
    <div
      {...handlers}
      className={`select-none [-webkit-touch-callout:none] ${className}`}
    >
      {children}
    </div>
  );
}
