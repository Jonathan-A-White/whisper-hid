/**
 * The Talk screen's front message is not a copy of the last dictation: it is
 * the store's own entry (the one History lists), found by id. So an edit or a
 * delete made in either place is the same change in the other.
 *
 * `frontId` is the id of the entry the last dictation added. When that entry
 * is deleted the front message is empty; it does not fall back to an older one.
 */
export function frontEntry<T extends { id: string }>(
  entries: readonly T[],
  frontId: string | null
): T | null {
  if (frontId === null) return null;
  return entries.find((e) => e.id === frontId) ?? null;
}
