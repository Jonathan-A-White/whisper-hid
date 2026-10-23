/** Plain words for the error code POST /connect answers a refused device pick with. */
export function connectErrorText(code: string | undefined): string {
  if (code === "not_registered") return "The keyboard isn't registered yet";
  return "Couldn't connect to that device";
}
