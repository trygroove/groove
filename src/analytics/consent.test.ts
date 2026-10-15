import { describe, expect, it, vi } from "vitest";
import { hostileStorage, memoryStorage } from "../testing/storage";
import {
  CONSENT_DEFAULT,
  CONSENT_FLAGS,
  CONSENT_STORAGE_KEY,
  ConsentStore,
} from "./consent";

describe("default state (DEC-009 owns the value, this owns the mechanism)", () => {
  it("uses the declared default when nothing is stored", () => {
    expect(new ConsentStore(memoryStorage()).current).toEqual(CONSENT_DEFAULT);
  });

  it("falls back to the default rather than throwing on corrupt storage", () => {
    const storage = memoryStorage();
    storage.setItem(CONSENT_STORAGE_KEY, "{not json");
    expect(new ConsentStore(storage).current).toEqual(CONSENT_DEFAULT);
  });

  it("fills a missing field from the default rather than dropping it", () => {
    const storage = memoryStorage();
    storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ productAnalytics: false }));
    const store = new ConsentStore(storage);
    expect(store.analyticsAllowed).toBe(false);
    expect(store.errorMonitoringAllowed).toBe(CONSENT_DEFAULT.errorMonitoring);
    // A preference written by a build that predates replay must not silently
    // come back as "replay declined" — or, worse, as "replay granted" when the
    // user had opted out of everything else. It takes the declared default.
    expect(store.sessionReplayAllowed).toBe(CONSENT_DEFAULT.sessionReplay);
  });

  it("rejects a non-boolean stored value per flag rather than trusting it", () => {
    const storage = memoryStorage();
    storage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ sessionReplay: "yes please", errorMonitoring: false }),
    );
    const store = new ConsentStore(storage);
    expect(store.sessionReplayAllowed).toBe(CONSENT_DEFAULT.sessionReplay);
    expect(store.errorMonitoringAllowed).toBe(false);
  });

  it("declares every flag in CONSENT_FLAGS, so parse and set cannot miss one", () => {
    // `parse`, `set`'s change detection, and `optOut` are all driven by this
    // list. A fourth processor added without extending it would be read back
    // as absent and would not trip a change notification.
    expect([...CONSENT_FLAGS].sort()).toEqual([
      "errorMonitoring",
      "productAnalytics",
      "sessionReplay",
    ]);
  });
});

describe("whether a preference was expressed (GRV-106)", () => {
  it("is false until the user makes a choice", () => {
    expect(new ConsentStore(memoryStorage()).preferenceExpressed).toBe(false);
  });

  it("is true once they do, and on every later load", () => {
    const storage = memoryStorage();
    const store = new ConsentStore(storage);
    store.optOut();
    expect(store.preferenceExpressed).toBe(true);
    store.optIn();
    expect(new ConsentStore(storage).preferenceExpressed).toBe(true);
  });

  it("is false on storage that throws", () => {
    expect(new ConsentStore(hostileStorage()).preferenceExpressed).toBe(false);
  });
});

describe("opting out", () => {
  it("turns every collection off in one action, replay included", () => {
    // ADR 0002 decision 4: replay is covered by the same single control, so a
    // user who declines telemetry is not recorded.
    const store = new ConsentStore(memoryStorage());
    store.optOut();
    expect(store.analyticsAllowed).toBe(false);
    expect(store.errorMonitoringAllowed).toBe(false);
    expect(store.sessionReplayAllowed).toBe(false);
  });

  it("opting back in restores every collection, replay included", () => {
    const store = new ConsentStore(memoryStorage());
    store.optOut();
    store.optIn();
    expect(store.sessionReplayAllowed).toBe(true);
    expect(store.analyticsAllowed).toBe(true);
    expect(store.errorMonitoringAllowed).toBe(true);
  });

  it("survives a reload", () => {
    const storage = memoryStorage();
    new ConsentStore(storage).optOut();
    const reloaded = new ConsentStore(storage);
    expect(reloaded.analyticsAllowed).toBe(false);
    expect(reloaded.sessionReplayAllowed).toBe(false);
  });

  it("keeps the three collections independently controllable", () => {
    // DEC-009 may decide differently about a reliability signal, about product
    // analytics, and about a sampled recording, so the model must not force
    // them together even though the one control does.
    const store = new ConsentStore(memoryStorage());
    store.set({ sessionReplay: false });
    expect(store.sessionReplayAllowed).toBe(false);
    expect(store.analyticsAllowed).toBe(true);
    expect(store.errorMonitoringAllowed).toBe(true);
  });
});

describe("subscribers", () => {
  it("delivers the current state immediately and on every change", () => {
    const store = new ConsentStore(memoryStorage());
    const seen = vi.fn();
    store.subscribe(seen);
    expect(seen).toHaveBeenCalledTimes(1);
    store.optOut();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.lastCall?.[0].productAnalytics).toBe(false);
  });

  it("notifies when only the replay flag changes", () => {
    // The in-flight recording is stopped by a subscriber, so a change that
    // notified nobody would leave replay capturing after a withdrawal.
    const store = new ConsentStore(memoryStorage());
    const seen = vi.fn();
    store.subscribe(seen);
    store.set({ sessionReplay: false });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.lastCall?.[0].sessionReplay).toBe(false);
  });

  it("does not notify when nothing actually changed", () => {
    const store = new ConsentStore(memoryStorage());
    const seen = vi.fn();
    store.subscribe(seen);
    store.set({ productAnalytics: CONSENT_DEFAULT.productAnalytics });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const store = new ConsentStore(memoryStorage());
    const seen = vi.fn();
    store.subscribe(seen)();
    store.optOut();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("still tells the other consumers to stop when one subscriber throws", () => {
    // The consumers being notified are the ones that must stop collecting;
    // one broken listener must not leave another still sending.
    const store = new ConsentStore(memoryStorage());
    const good = vi.fn();
    store.subscribe(() => {
      throw new Error("listener exploded");
    });
    store.subscribe(good);
    expect(() => store.optOut()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(2);
  });
});

describe("fail-open storage (PRD OPS-02)", () => {
  it("constructs against a storage that throws", () => {
    const store = new ConsentStore(hostileStorage());
    expect(store.current).toEqual(CONSENT_DEFAULT);
  });

  it("applies a preference for the session even when it cannot be persisted", () => {
    const store = new ConsentStore(hostileStorage());
    expect(() => store.optOut()).not.toThrow();
    expect(store.analyticsAllowed).toBe(false);
    // The replay flag matters most here: a withdrawal that cannot be written
    // down must still stop the recording that is running right now.
    expect(store.sessionReplayAllowed).toBe(false);
  });

  it("works with no storage at all", () => {
    const store = new ConsentStore(null);
    store.optOut();
    expect(store.errorMonitoringAllowed).toBe(false);
    expect(store.sessionReplayAllowed).toBe(false);
  });
});
