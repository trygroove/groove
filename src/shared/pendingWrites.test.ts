import { afterEach, describe, expect, it } from "vitest";
import {
  __resetPendingWritesForTests,
  flushPendingWrites,
  holdPendingWrites,
  unsavedWriteCount,
} from "./pendingWrites";

afterEach(() => __resetPendingWritesForTests());

/** A holder with `pending` entries, whose flush writes them unless `fails`. */
function holder(pending: number, behaviour: "writes" | "fails" | "hangs" | "throws") {
  let left = pending;
  return {
    pending: () => left,
    flush: () => {
      if (behaviour === "throws") return Promise.reject(new Error("refused"));
      if (behaviour === "hangs") return new Promise<void>(() => {});
      if (behaviour === "writes") left = 0;
      return Promise.resolve();
    },
  };
}

describe("pendingWrites (GRV-55)", () => {
  it("says nothing was queued when no holder has anything unwritten", async () => {
    holdPendingWrites(holder(0, "writes"));
    expect(await flushPendingWrites()).toBe("nothing_queued");
  });

  it("writes every holder's queue and says it saved", async () => {
    holdPendingWrites(holder(2, "writes"));
    holdPendingWrites(holder(1, "writes"));
    expect(unsavedWriteCount()).toBe(3);
    expect(await flushPendingWrites()).toBe("saved");
    expect(unsavedWriteCount()).toBe(0);
  });

  it("says unsaved when a write fails, throws, or does not settle in time", async () => {
    holdPendingWrites(holder(1, "fails"));
    expect(await flushPendingWrites()).toBe("unsaved");
    __resetPendingWritesForTests();
    holdPendingWrites(holder(1, "throws"));
    expect(await flushPendingWrites()).toBe("unsaved");
    __resetPendingWritesForTests();
    holdPendingWrites(holder(1, "hangs"));
    expect(await flushPendingWrites(5)).toBe("unsaved");
  });

  it("counts stuck entries as unsaved without trying to write them", async () => {
    let flushed = 0;
    holdPendingWrites({
      pending: () => 0,
      stuck: () => 2,
      flush: async () => {
        flushed += 1;
      },
    });
    expect(unsavedWriteCount()).toBe(2);
    expect(await flushPendingWrites()).toBe("unsaved");
    expect(flushed).toBe(0);
  });

  it("writes what it can beside a stuck entry, and still says unsaved", async () => {
    const writable = holder(1, "writes");
    holdPendingWrites(writable);
    holdPendingWrites({ pending: () => 0, stuck: () => 1, flush: async () => {} });
    expect(await flushPendingWrites()).toBe("unsaved");
    expect(writable.pending()).toBe(0);
    expect(unsavedWriteCount()).toBe(1);
  });

  it("forgets a holder once it is released", async () => {
    const release = holdPendingWrites(holder(4, "fails"));
    release();
    expect(unsavedWriteCount()).toBe(0);
  });
});
