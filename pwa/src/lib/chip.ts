/**
 * The Talk screen's control chips (target, This phone, Zoom mode, Type
 * clipboard) share one shape and one resting style; only the accent of a chip
 * that is on differs. The chips sit in a two-column grid owned by TalkView.
 */
const SHAPE =
  "w-full py-2 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-1.5";

const RESTING = "bg-gray-800 text-gray-300 hover:bg-gray-700";

const ACCENTS = {
  blue: "bg-sky-600 text-white",
  violet: "bg-violet-600 text-white",
} as const;

export type ChipAccent = keyof typeof ACCENTS;

/** Classes for a chip; pass an accent when the chip is on, none at rest. */
export function chipClass(accent?: ChipAccent): string {
  return `${SHAPE} ${accent ? ACCENTS[accent] : RESTING}`;
}

/** A helper line under the chips: one line, centred, grey, after every chip. */
export const CHIP_NOTE_CLASS =
  "order-last col-span-2 text-center text-xs text-gray-500";
