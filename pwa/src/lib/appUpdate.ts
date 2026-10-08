// A new build of the PWA waits behind the one in control until Jonathan taps (mw-kw96r9.4): the
// banner (components/UpdateBanner.tsx) shows while a worker is waiting, the tap posts
// {type:'SKIP_WAITING'} to it (the generated worker, registerType 'prompt') and the page reloads
// ONCE when the controller changes, only if he asked: a first install claiming the page, or
// another tab's update, never reloads this one. The app also asks the browser whether there is a
// new build on start, on return to the foreground and every 30 minutes.
import { useSyncExternalStore } from "react";

/** How often a running app asks whether a newer build is up. */
export const UPDATE_CHECK_EVERY_MS = 30 * 60_000;

/** How long a tap waits for the new worker to take over before the banner lets him tap again. */
export const TAKE_OVER_PATIENCE_MS = 10_000;

/** A chunk-load reload is not repeated within this long, so a broken deploy cannot loop. */
export const PRELOAD_RELOAD_GAP_MS = 10_000;
const PRELOAD_RELOAD_KEY = "whisper_preload_reload_at";

export type UpdateState = "none" | "ready" | "updating";

interface WorkerLike {
  state: ServiceWorkerState;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}

export interface UpdateContainer {
  controller: unknown;
  addEventListener(type: "controllerchange", listener: () => void): void;
  removeEventListener(type: "controllerchange", listener: () => void): void;
}

export interface UpdateRegistration {
  waiting: WorkerLike | null;
  installing: WorkerLike | null;
  update(): Promise<unknown>;
  addEventListener(type: "updatefound", listener: () => void): void;
  removeEventListener(type: "updatefound", listener: () => void): void;
}

/** The part of `document` the update check reads, injectable for tests. */
export interface VisibilitySource {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface AppUpdates {
  /** Tells the waiting worker to take over; the page reloads once it has. */
  apply(): void;
  /** Asks the browser now whether a newer build is up. */
  checkNow(): void;
  stop(): void;
}

let state: UpdateState = "none";
let active: AppUpdates | undefined;
const listeners = new Set<() => void>();

function setState(next: UpdateState): void {
  if (state === next) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

export function getUpdateState(): UpdateState {
  return state;
}

/** The banner's state: nothing waiting, a build ready to take, or the tap made and the worker taking over. */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => state
  );
}

/** The tap on the banner. */
export function applyUpdate(): void {
  active?.apply();
}

/** Watches `registration` for a waiting worker and looks for a newer build now, on return to the foreground and every 30 minutes. */
export function startAppUpdates(deps: {
  container: UpdateContainer;
  registration: UpdateRegistration;
  reload: () => void;
  doc?: VisibilitySource;
}): AppUpdates {
  const { container, registration, reload } = deps;
  const doc = deps.doc ?? document;
  active?.stop();
  let asked = false;
  let patience: ReturnType<typeof setTimeout> | undefined;

  const syncWaiting = () => {
    // The first worker ever has nothing to wait behind: it activates, and claims the page.
    if (registration.waiting && container.controller) {
      if (state === "none") setState("ready");
    } else if (!asked) setState("none");
  };

  const onFound = () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") syncWaiting();
    });
  };

  const onControllerChange = () => {
    if (!asked) return;
    asked = false;
    clearTimeout(patience);
    reload();
  };

  const checkNow = () => {
    // Offline, or the server is down: the next check tries again.
    void Promise.resolve(registration.update()).catch(() => undefined);
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") checkNow();
  };

  registration.addEventListener("updatefound", onFound);
  container.addEventListener("controllerchange", onControllerChange);
  doc.addEventListener("visibilitychange", onVisible);
  const every = setInterval(checkNow, UPDATE_CHECK_EVERY_MS);
  onFound();
  syncWaiting();
  checkNow();

  const updates: AppUpdates = {
    apply() {
      const worker = registration.waiting;
      if (state !== "ready" || !worker) return;
      asked = true;
      setState("updating");
      worker.postMessage({ type: "SKIP_WAITING" });
      clearTimeout(patience);
      patience = setTimeout(() => {
        asked = false;
        setState(registration.waiting ? "ready" : "none");
      }, TAKE_OVER_PATIENCE_MS);
    },
    checkNow,
    stop() {
      registration.removeEventListener("updatefound", onFound);
      container.removeEventListener("controllerchange", onControllerChange);
      doc.removeEventListener("visibilitychange", onVisible);
      clearInterval(every);
      clearTimeout(patience);
      if (active === updates) {
        active = undefined;
        asked = false;
        setState("none");
      }
    },
  };
  active = updates;
  return updates;
}

/**
 * A dynamic import that 404s because a new build replaced the old chunk names: Vite fires
 * `vite:preloadError`; reload to pick up the new build, but never twice within
 * PRELOAD_RELOAD_GAP_MS.
 */
export function installPreloadErrorReload(deps: {
  target: {
    addEventListener(
      type: "vite:preloadError",
      listener: (e: { preventDefault(): void }) => void
    ): void;
  };
  reload: () => void;
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  now?: () => number;
}): void {
  const now = deps.now ?? Date.now;
  deps.target.addEventListener("vite:preloadError", (e) => {
    e.preventDefault();
    const last = Number(deps.storage.getItem(PRELOAD_RELOAD_KEY) ?? 0);
    if (now() - last < PRELOAD_RELOAD_GAP_MS) return;
    deps.storage.setItem(PRELOAD_RELOAD_KEY, String(now()));
    deps.reload();
  });
}
