import type { Credit } from "./credits";

// Pure checks behind credits.test.ts, so the test can feed them fake lists.
// A credit that names `packages` is a dependency credit and must still match a
// real dependency; a credit with none (an idea, a model, a service, a font)
// is exempt from that check by its kind.

/** Package ids a credit names that no dependency list (or `outsideLists`) has. */
export function staleCreditedPackages(
  credits: Credit[],
  dependencies: string[],
  outsideLists: string[] = []
): string[] {
  const live = new Set([...dependencies, ...outsideLists]);
  return credits.flatMap((c) => (c.packages ?? []).filter((id) => !live.has(id)));
}

/** Bundled font and data files (repo-relative paths) that no credit's `files` names. */
export function uncreditedFiles(credits: Credit[], shipped: string[]): string[] {
  const named = credits.flatMap((c) => c.files ?? []);
  return shipped.filter((f) => !named.some((n) => f === n || (n.endsWith("/") && f.startsWith(n))));
}
