import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_CHECK_EVERY_MS,
  applyUpdate,
  getUpdateState,
  installPreloadErrorReload,
  startAppUpdates,
  type AppUpdates,
  type UpdateContainer,
  type UpdateRegistration,
} from "./appUpdate";

function fakeEnv(opts: { waiting?: boolean; controlled?: boolean } = {}) {
  const posted: unknown[] = [];
  const waiting = opts.waiting
    ? {
        state: "installed" as ServiceWorkerState,
        postMessage: (m: unknown) => void posted.push(m),
        addEventListener: () => {},
      }
    : null;
  const regListeners = new Set<() => void>();
  const registration = {
    waiting,
    installing: null,
    update: vi.fn(() => Promise.resolve()),
    addEventListener: (_t: string, l: () => void) => void regListeners.add(l),
    removeEventListener: (_t: string, l: () => void) =>
      void regListeners.delete(l),
  } as unknown as UpdateRegistration & { waiting: unknown };
  const ctrlListeners = new Set<() => void>();
  const container: UpdateContainer = {
    controller: opts.controlled === false ? null : {},
    addEventListener: (_t, l) => void ctrlListeners.add(l),
    removeEventListener: (_t, l) => void ctrlListeners.delete(l),
  };
  const visListeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_t: "visibilitychange", l: () => void) =>
      void visListeners.add(l),
    removeEventListener: (_t: "visibilitychange", l: () => void) =>
      void visListeners.delete(l),
  };
  return {
    posted,
    registration,
    container,
    doc,
    reload: vi.fn(),
    controllerChange: () => ctrlListeners.forEach((l) => l()),
    visibilityChange: () => visListeners.forEach((l) => l()),
  };
}

describe("app update", () => {
  let updates: AppUpdates | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    updates?.stop();
    updates = undefined;
    vi.useRealTimers();
  });

  function start(env: ReturnType<typeof fakeEnv>) {
    updates = startAppUpdates({
      container: env.container,
      registration: env.registration,
      reload: env.reload,
      doc: env.doc,
    });
    return updates;
  }

  it("shows the banner when a worker is waiting behind a controlling one", () => {
    start(fakeEnv({ waiting: true }));
    expect(getUpdateState()).toBe("ready");
  });

  it("shows nothing when no worker waits", () => {
    start(fakeEnv());
    expect(getUpdateState()).toBe("none");
  });

  it("shows nothing for the first install, which has no controller", () => {
    start(fakeEnv({ waiting: true, controlled: false }));
    expect(getUpdateState()).toBe("none");
  });

  it("posts SKIP_WAITING only on the tap", () => {
    const env = fakeEnv({ waiting: true });
    start(env);
    expect(env.posted).toEqual([]);
    applyUpdate();
    expect(env.posted).toEqual([{ type: "SKIP_WAITING" }]);
    expect(getUpdateState()).toBe("updating");
  });

  it("does not reload on a controller change nobody asked for", () => {
    const env = fakeEnv({ waiting: true });
    start(env);
    env.controllerChange();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("reloads once on the controller change after the tap", () => {
    const env = fakeEnv({ waiting: true });
    start(env);
    applyUpdate();
    env.controllerChange();
    env.controllerChange();
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it("asks for a new build on start, on return and every 30 minutes", async () => {
    const env = fakeEnv();
    start(env);
    expect(env.registration.update).toHaveBeenCalledTimes(1);

    env.visibilityChange();
    expect(env.registration.update).toHaveBeenCalledTimes(2);

    env.doc.visibilityState = "hidden";
    env.visibilityChange();
    expect(env.registration.update).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_EVERY_MS);
    expect(env.registration.update).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_EVERY_MS);
    expect(env.registration.update).toHaveBeenCalledTimes(4);
  });

  it("survives an update() that rejects while offline", async () => {
    const env = fakeEnv();
    (env.registration.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("offline")
    );
    start(env);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUpdateState()).toBe("none");
  });

  it("stops checking after stop()", async () => {
    const env = fakeEnv();
    start(env).stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_EVERY_MS * 2);
    expect(env.registration.update).toHaveBeenCalledTimes(1);
  });
});

describe("vite:preloadError reload", () => {
  function setup(stored: Record<string, string> = {}) {
    const listeners: Record<string, (e: { preventDefault(): void }) => void> =
      {};
    const target = {
      addEventListener: (t: string, l: (e: { preventDefault(): void }) => void) => {
        listeners[t] = l;
      },
    };
    const storage = {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => void (stored[k] = v),
    };
    const reload = vi.fn();
    installPreloadErrorReload({ target, reload, storage, now: () => 100_000 });
    const preventDefault = vi.fn();
    return { fire: () => listeners["vite:preloadError"]({ preventDefault }), reload, preventDefault };
  }

  it("reloads to pick up the new build", () => {
    const s = setup();
    s.fire();
    expect(s.preventDefault).toHaveBeenCalled();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload again right after a reload (no loop)", () => {
    const s = setup({ whisper_preload_reload_at: "95000" });
    s.fire();
    expect(s.reload).not.toHaveBeenCalled();
  });
});
