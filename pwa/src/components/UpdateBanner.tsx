// 'Update ready, tap to reload' at the TOP of the app while a newer build waits (never over the
// Talk bar at the foot). The tap goes dead and says 'Updating…' until the page reloads.
import { applyUpdate, useUpdateState } from "../lib/appUpdate";

export function UpdateBanner() {
  const state = useUpdateState();
  if (state === "none") return null;
  const updating = state === "updating";
  return (
    <button
      type="button"
      onClick={applyUpdate}
      disabled={updating}
      className="flex w-full shrink-0 items-center justify-center bg-sky-600 px-3 py-3 text-base font-medium text-white disabled:opacity-70"
    >
      {updating ? "Updating…" : "Update ready, tap to reload"}
    </button>
  );
}
