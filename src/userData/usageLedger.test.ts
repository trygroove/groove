import { describe, expect, it } from "vitest";
import {
  compareGenerations,
  recordObjectDeleted,
  recordObjectWritten,
  type UsageTransaction,
} from "./usageLedger";
import {
  USER_DATA_CAP_BYTES,
  type UsageDocument,
  type UsageLedgerEntry,
} from "./userData";

/** An in-memory stand-in for the Firestore transaction the function runs in. */
function memoryStore() {
  const entries = new Map<string, UsageLedgerEntry>();
  const usage = new Map<string, UsageDocument>();
  const tx: UsageTransaction = {
    getEntry: async (uid, path) => entries.get(`${uid}|${path}`) ?? null,
    getUsage: async (uid) => usage.get(uid) ?? null,
    setEntry: (uid, path, entry) => void entries.set(`${uid}|${path}`, entry),
    setUsage: (uid, doc) => void usage.set(uid, doc),
  };
  return { tx, entries, total: (uid: string) => usage.get(uid)?.totalBytes ?? 0, usage };
}

const PATH = "users/u1/packs/pak_a/ast_a";

describe("the usage ledger", () => {
  it("counts a written object against its owner and its kind", async () => {
    const store = memoryStore();
    const outcome = await recordObjectWritten(
      store.tx,
      { path: PATH, generation: "1", size: 500 },
      10,
    );
    expect(outcome).toEqual({ applied: true, uid: "u1", deltaBytes: 500 });
    expect(store.usage.get("u1")).toEqual({
      totalBytes: 500,
      byKind: { packs: 500 },
      updatedAt: 10,
    });
  });

  it("ignores a repeated delivery of the same write", async () => {
    const store = memoryStore();
    const event = { path: PATH, generation: "1", size: 500 };
    await recordObjectWritten(store.tx, event, 1);
    const again = await recordObjectWritten(store.tx, event, 2);
    expect(again).toEqual({ applied: false, reason: "duplicate" });
    expect(store.total("u1")).toBe(500);
  });

  it("releases a deleted object's bytes once", async () => {
    const store = memoryStore();
    await recordObjectWritten(store.tx, { path: PATH, generation: "1", size: 500 }, 1);
    await recordObjectWritten(
      store.tx,
      { path: "users/u1/packs/pak_a/ast_b", generation: "1", size: 200 },
      1,
    );
    await recordObjectDeleted(store.tx, { path: PATH, generation: "1" }, 2);
    expect(store.total("u1")).toBe(200);
    const again = await recordObjectDeleted(store.tx, { path: PATH, generation: "1" }, 3);
    expect(again).toEqual({ applied: false, reason: "duplicate" });
    expect(store.total("u1")).toBe(200);
  });

  it("balances an overwrite whose delete arrives after the new write", async () => {
    const store = memoryStore();
    await recordObjectWritten(store.tx, { path: PATH, generation: "1", size: 500 }, 1);
    await recordObjectWritten(store.tx, { path: PATH, generation: "2", size: 800 }, 2);
    expect(store.total("u1")).toBe(800);
    const late = await recordObjectDeleted(store.tx, { path: PATH, generation: "1" }, 3);
    expect(late).toEqual({ applied: false, reason: "stale" });
    expect(store.total("u1")).toBe(800);
  });

  it("balances an overwrite whose delete arrives first", async () => {
    const store = memoryStore();
    await recordObjectWritten(store.tx, { path: PATH, generation: "1", size: 500 }, 1);
    await recordObjectDeleted(store.tx, { path: PATH, generation: "1" }, 2);
    await recordObjectWritten(store.tx, { path: PATH, generation: "2", size: 800 }, 3);
    expect(store.total("u1")).toBe(800);
  });

  it("charges nobody for the factory library or an undeclared kind", async () => {
    const store = memoryStore();
    for (const path of ["library/audio/kick.ogg", "users/u1/secrets/a"]) {
      const outcome = await recordObjectWritten(
        store.tx,
        { path, generation: "1", size: 9 },
        1,
      );
      expect(outcome).toEqual({ applied: false, reason: "not_user_data" });
    }
    expect(store.usage.size).toBe(0);
  });

  it("keeps each user's total separate", async () => {
    const store = memoryStore();
    await recordObjectWritten(store.tx, { path: PATH, generation: "1", size: 5 }, 1);
    await recordObjectWritten(
      store.tx,
      { path: "users/u2/packs/pak_b/ast_b", generation: "1", size: 7 },
      1,
    );
    expect(store.total("u1")).toBe(5);
    expect(store.total("u2")).toBe(7);
  });

  it("skips a write whose delete arrived first, so a gone object is never counted", async () => {
    const store = memoryStore();
    const early = await recordObjectDeleted(store.tx, { path: PATH, generation: "7" }, 1);
    expect(early).toEqual({ applied: false, reason: "not_counted" });
    expect(store.entries.get(`u1|${PATH}`)).toMatchObject({
      generation: "7",
      state: "deleted",
    });
    const late = await recordObjectWritten(
      store.tx,
      { path: PATH, generation: "7", size: 500 },
      2,
    );
    expect(late).toEqual({ applied: false, reason: "stale" });
    expect(store.total("u1")).toBe(0);
  });

  it("ignores a write for a generation older than the one already counted", async () => {
    const store = memoryStore();
    await recordObjectWritten(store.tx, { path: PATH, generation: "9", size: 800 }, 1);
    const old = await recordObjectWritten(
      store.tx,
      { path: PATH, generation: "8", size: 500 },
      2,
    );
    expect(old).toEqual({ applied: false, reason: "stale" });
    expect(store.total("u1")).toBe(800);
  });

  it("orders generations as integers, not text", () => {
    expect(compareGenerations("1700000000000009", "1700000000000010")).toBeLessThan(0);
    expect(compareGenerations("10", "9")).toBeGreaterThan(0);
    expect(compareGenerations("5", "5")).toBe(0);
  });

  describe("over the allowance", () => {
    const NEARLY_FULL = USER_DATA_CAP_BYTES - 100;

    async function nearlyFull() {
      const store = memoryStore();
      await recordObjectWritten(
        store.tx,
        { path: "users/u1/packs/pak_a/ast_big", generation: "1", size: NEARLY_FULL },
        1,
      );
      return store;
    }

    it("refuses a write that would take the account over, and does not count it", async () => {
      const store = await nearlyFull();
      const outcome = await recordObjectWritten(
        store.tx,
        { path: PATH, generation: "1", size: 101 },
        2,
      );
      expect(outcome).toEqual({ applied: false, reason: "over_allowance", uid: "u1" });
      expect(store.total("u1")).toBe(NEARLY_FULL);
      expect(store.entries.get(`u1|${PATH}`)).toMatchObject({
        state: "refused",
        bytes: 0,
      });
    });

    it("counts a write over the allowance for an internal or admin account (GRV-112)", async () => {
      const store = await nearlyFull();
      const asked: string[] = [];
      const outcome = await recordObjectWritten(
        store.tx,
        { path: PATH, generation: "1", size: 101 },
        2,
        {
          isUnlimited: async (uid) => {
            asked.push(uid);
            return true;
          },
        },
      );
      expect(outcome).toEqual({ applied: true, uid: "u1", deltaBytes: 101 });
      expect(store.total("u1")).toBe(USER_DATA_CAP_BYTES + 1);
      expect(asked).toEqual(["u1"]);
    });

    it("refuses an account the lookup says is limited", async () => {
      const store = await nearlyFull();
      const outcome = await recordObjectWritten(
        store.tx,
        { path: PATH, generation: "1", size: 101 },
        2,
        { isUnlimited: async () => false },
      );
      expect(outcome).toEqual({ applied: false, reason: "over_allowance", uid: "u1" });
    });

    it("asks about the account only for a write that would go over", async () => {
      const store = await nearlyFull();
      let asked = 0;
      await recordObjectWritten(store.tx, { path: PATH, generation: "1", size: 100 }, 2, {
        isUnlimited: async () => {
          asked += 1;
          return true;
        },
      });
      expect(asked).toBe(0);
    });

    it("counts a write that lands exactly on the allowance", async () => {
      const store = await nearlyFull();
      const outcome = await recordObjectWritten(
        store.tx,
        { path: PATH, generation: "1", size: 100 },
        2,
      );
      expect(outcome).toEqual({ applied: true, uid: "u1", deltaBytes: 100 });
      expect(store.total("u1")).toBe(USER_DATA_CAP_BYTES);
    });

    it("lets the first of two racing uploads in and refuses the second", async () => {
      const store = await nearlyFull();
      // Both passed the rules against the same stale total; the ledger sees
      // them one transaction at a time.
      const first = await recordObjectWritten(
        store.tx,
        { path: "users/u1/packs/pak_a/ast_one", generation: "1", size: 60 },
        2,
      );
      const second = await recordObjectWritten(
        store.tx,
        { path: "users/u1/packs/pak_a/ast_two", generation: "1", size: 60 },
        2,
      );
      expect(first).toMatchObject({ applied: true });
      expect(second).toEqual({ applied: false, reason: "over_allowance", uid: "u1" });
      expect(store.total("u1")).toBe(NEARLY_FULL + 60);
    });

    it("treats the refused object's own delete as a no-op", async () => {
      const store = await nearlyFull();
      await recordObjectWritten(store.tx, { path: PATH, generation: "1", size: 500 }, 2);
      const reclaimed = await recordObjectDeleted(
        store.tx,
        { path: PATH, generation: "1" },
        3,
      );
      expect(reclaimed).toEqual({ applied: false, reason: "not_counted" });
      expect(store.total("u1")).toBe(NEARLY_FULL);
      const redelivered = await recordObjectWritten(
        store.tx,
        { path: PATH, generation: "1", size: 500 },
        4,
      );
      expect(redelivered).toEqual({ applied: false, reason: "stale" });
      expect(store.total("u1")).toBe(NEARLY_FULL);
    });

    it("never counts a repeated delivery of a refused write later, once there is room", async () => {
      const store = await nearlyFull();
      await recordObjectWritten(store.tx, { path: PATH, generation: "1", size: 500 }, 2);
      await recordObjectDeleted(
        store.tx,
        { path: "users/u1/packs/pak_a/ast_big", generation: "1" },
        3,
      );
      const again = await recordObjectWritten(
        store.tx,
        { path: PATH, generation: "1", size: 500 },
        4,
      );
      expect(again).toEqual({ applied: false, reason: "duplicate" });
      expect(store.total("u1")).toBe(0);
    });
  });
});
