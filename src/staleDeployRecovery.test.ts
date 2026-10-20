import { describe, expect, it, vi } from "vitest";
import {
  installStaleDeployRecovery,
  RELOAD_GUARD_KEY,
  RELOAD_GUARD_WINDOW_MS,
} from "./staleDeployRecovery";

function setup(startMs = 1_000_000) {
  const target = new EventTarget();
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  let nowMs = startMs;
  const reload = vi.fn();
  const dispose = installStaleDeployRecovery({
    target,
    storage,
    now: () => nowMs,
    reload,
  });
  return {
    target,
    store,
    reload,
    dispose,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function preloadError() {
  const event = new Event("vite:preloadError", { cancelable: true });
  return event;
}

function rejection(reason: unknown) {
  const event = new Event("unhandledrejection", { cancelable: true });
  Object.assign(event, { reason });
  return event;
}

describe("installStaleDeployRecovery", () => {
  it("reloads once on a Vite preload error and swallows the event", () => {
    const { target, reload } = setup();
    const event = preloadError();
    target.dispatchEvent(event);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("reloads on a failed dynamic import that Vite did not wrap", () => {
    const { target, reload } = setup();
    target.dispatchEvent(
      rejection(
        new TypeError(
          "Failed to fetch dynamically imported module: https://x/assets/a-1.js",
        ),
      ),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("recognises the Firefox and Safari wordings", () => {
    for (const message of [
      "error loading dynamically imported module: https://x/a.js",
      "Importing a module script failed.",
    ]) {
      const { target, reload } = setup();
      target.dispatchEvent(rejection(new TypeError(message)));
      expect(reload).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores unrelated rejections", () => {
    const { target, reload } = setup();
    target.dispatchEvent(rejection(new Error("permission-denied")));
    target.dispatchEvent(rejection("nope"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not loop: a second failure right after a reload is left alone", () => {
    const { target, reload, advance, store } = setup();
    target.dispatchEvent(preloadError());
    expect(store.has(RELOAD_GUARD_KEY)).toBe(true);
    advance(RELOAD_GUARD_WINDOW_MS - 1);
    const again = preloadError();
    target.dispatchEvent(again);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(again.defaultPrevented).toBe(false);
  });

  it("recovers again after a later deploy in the same tab", () => {
    const { target, reload, advance } = setup();
    target.dispatchEvent(preloadError());
    advance(RELOAD_GUARD_WINDOW_MS + 1);
    target.dispatchEvent(preloadError());
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("stops listening once disposed", () => {
    const { target, reload, dispose } = setup();
    dispose();
    target.dispatchEvent(preloadError());
    expect(reload).not.toHaveBeenCalled();
  });
});
