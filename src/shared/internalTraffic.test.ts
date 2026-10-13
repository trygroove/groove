import { beforeEach, describe, expect, it } from "vitest";
import { hostileStorage, memoryStorage } from "../testing/storage";
import {
  INTERNAL_TRAFFIC_STORAGE_KEY,
  isInternalTraffic,
  markInternalTraffic,
  parseInternalTrafficParam,
  syncInternalTraffic,
} from "./internalTraffic";

describe("markInternalTraffic", () => {
  it("persists the flag so a later load reads as internal from the start", () => {
    const storage = memoryStorage();
    markInternalTraffic(storage);
    expect(storage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBe("true");
    expect(syncInternalTraffic({ search: "" }, storage)).toBe(true);
  });

  it("is cleared by ?internal=0 like a flag set from the URL", () => {
    const storage = memoryStorage();
    markInternalTraffic(storage);
    expect(syncInternalTraffic({ search: "?internal=0" }, storage)).toBe(false);
    expect(isInternalTraffic(storage)).toBe(false);
  });

  it("never throws when storage does", () => {
    expect(() => markInternalTraffic(hostileStorage())).not.toThrow();
    expect(() => markInternalTraffic(null)).not.toThrow();
  });
});

describe("parseInternalTrafficParam", () => {
  it("treats a missing param as no claim", () => {
    expect(parseInternalTrafficParam(null)).toBeUndefined();
  });

  it.each(["1", "true", "TRUE", " true "])("parses %j as true", (value) => {
    expect(parseInternalTrafficParam(value)).toBe(true);
  });

  it.each(["0", "false", "FALSE"])("parses %j as false", (value) => {
    expect(parseInternalTrafficParam(value)).toBe(false);
  });

  it("treats an unrecognized value as no claim rather than guessing", () => {
    expect(parseInternalTrafficParam("yes")).toBeUndefined();
  });
});

describe("isInternalTraffic / syncInternalTraffic", () => {
  // Inject an isolated store rather than jsdom's ambient `localStorage`: it can
  // leak between tests, and in some Node/vitest environments the ambient global
  // lacks a working `clear()`. See `src/testing/storage.ts`.
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("defaults to false with nothing persisted and no query claim", () => {
    expect(isInternalTraffic(storage)).toBe(false);
    expect(syncInternalTraffic({ search: "" }, storage)).toBe(false);
  });

  it("persists internal=1 so it survives a later load with no param", () => {
    expect(syncInternalTraffic({ search: "?internal=1" }, storage)).toBe(true);
    expect(storage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBe("true");

    // A later navigation with no query param at all still reads as internal.
    expect(syncInternalTraffic({ search: "" }, storage)).toBe(true);
  });

  it("internal=0 clears a previously persisted flag", () => {
    syncInternalTraffic({ search: "?internal=1" }, storage);
    expect(isInternalTraffic(storage)).toBe(true);

    expect(syncInternalTraffic({ search: "?internal=0" }, storage)).toBe(false);
    expect(storage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBeNull();
    expect(isInternalTraffic(storage)).toBe(false);
  });

  it("fails closed if storage throws rather than surfacing an error", () => {
    const throwingStorage: Storage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
      clear: () => {},
      key: () => null,
      length: 0,
    };

    expect(isInternalTraffic(throwingStorage)).toBe(false);
    expect(() =>
      syncInternalTraffic({ search: "?internal=1" }, throwingStorage),
    ).not.toThrow();
  });
});

// #75: "block site data" makes merely reading `window.localStorage` throw. The
// default storage used to be a bare `= localStorage` parameter, evaluated
// outside every `try`, so `App` threw on load and never left its loading screen.
describe("with site data blocked", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Site data is blocked", "SecurityError");
      },
    });
    return () => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
    };
  });

  it("reads and syncs the flag without throwing, failing closed", () => {
    expect(isInternalTraffic()).toBe(false);
    expect(syncInternalTraffic({ search: "" })).toBe(false);
    // The URL's claim still holds for this load; it just is not persisted.
    expect(syncInternalTraffic({ search: "?internal=1" })).toBe(true);
  });
});
