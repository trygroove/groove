import { describe, expect, it } from "vitest";
import { createInMemoryAccessRepository } from "../../src/access/inMemoryAccessRepository";
import {
  isQaSlot,
  MAX_QA_SLOT,
  provisionQaAccounts,
  QA_ACCOUNTS,
  type QaUser,
  type QaUserChanges,
  type QaUserStore,
  qaAccount,
} from "./qaPool";

/** Firebase Auth over a map, counting every write. */
function memoryUsers(seed: QaUser[] = []) {
  const users = new Map(seed.map((user) => [user.uid, { ...user }]));
  const writes: {
    kind: "create" | "update" | "markInternal";
    uid: string;
    changes?: QaUserChanges;
  }[] = [];
  const store: QaUserStore = {
    async get(uid) {
      const user = users.get(uid);
      return user ? { ...user } : null;
    },
    async create(user) {
      if (users.has(user.uid)) throw new Error(`exists: ${user.uid}`);
      users.set(user.uid, { ...user, internal: false });
      writes.push({ kind: "create", uid: user.uid });
    },
    async update(uid, changes) {
      const user = users.get(uid);
      if (!user) throw new Error(`missing: ${uid}`);
      users.set(uid, { ...user, ...changes });
      writes.push({ kind: "update", uid, changes });
    },
    async markInternal(uid) {
      const user = users.get(uid);
      if (!user) throw new Error(`missing: ${uid}`);
      users.set(uid, { ...user, internal: true });
      writes.push({ kind: "markInternal", uid });
    },
  };
  return { store, users, writes };
}

describe("the QA account pool", () => {
  it("is testuser0 to testuser10, each fixed by its slot", () => {
    expect(QA_ACCOUNTS).toHaveLength(11);
    expect(qaAccount(0)).toEqual({
      slot: 0,
      uid: "qa-testuser-0",
      email: "testuser0@qa.trygroove.app",
      displayName: "QA testuser0",
    });
    expect(qaAccount(10).email).toBe("testuser10@qa.trygroove.app");
  });

  it("has no account outside slots 0 to 10", () => {
    expect(MAX_QA_SLOT).toBe(10);
    for (const slot of [-1, 11, 1.5, Number.NaN]) {
      expect(isQaSlot(slot)).toBe(false);
      expect(() => qaAccount(slot)).toThrow(RangeError);
    }
  });
});

describe("provisionQaAccounts", () => {
  it("creates every account verified and internal, and allowlists every address", async () => {
    const { store, users } = memoryUsers();
    const allowlist = createInMemoryAccessRepository();

    const report = await provisionQaAccounts(store, allowlist, 42);

    expect(report.created).toEqual(QA_ACCOUNTS.map((a) => a.email));
    expect(report.updated).toEqual([]);
    expect(report.allowlist.added).toEqual(QA_ACCOUNTS.map((a) => a.email));
    expect(users.get("qa-testuser-3")).toEqual({
      uid: "qa-testuser-3",
      email: "testuser3@qa.trygroove.app",
      emailVerified: true,
      displayName: "QA testuser3",
      internal: true,
    });
    expect([...users.values()].every((user) => user.internal)).toBe(true);
    expect((await allowlist.listAllowlist()).map((entry) => entry.email).sort()).toEqual(
      QA_ACCOUNTS.map((a) => a.email).sort(),
    );
  });

  it("changes nothing when run a second time", async () => {
    const { store, users, writes } = memoryUsers();
    const allowlist = createInMemoryAccessRepository();
    await provisionQaAccounts(store, allowlist, 42);
    const usersAfterFirst = structuredClone([...users.entries()]);
    const listAfterFirst = await allowlist.listAllowlist();
    const writesAfterFirst = writes.length;

    const report = await provisionQaAccounts(store, allowlist, 99);

    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.unchanged).toEqual(QA_ACCOUNTS.map((a) => a.email));
    expect(report.allowlist.added).toEqual([]);
    expect(report.allowlist.alreadyListed).toEqual(QA_ACCOUNTS.map((a) => a.email));
    expect(writes).toHaveLength(writesAfterFirst);
    expect([...users.entries()]).toEqual(usersAfterFirst);
    // The entries keep the time they were first added.
    expect(await allowlist.listAllowlist()).toEqual(listAfterFirst);
  });

  it("puts back only what has drifted on an existing account", async () => {
    const { store, users, writes } = memoryUsers([
      {
        uid: "qa-testuser-2",
        email: "testuser2@qa.trygroove.app",
        emailVerified: false,
        displayName: "Renamed",
        internal: true,
      },
    ]);

    const report = await provisionQaAccounts(store, createInMemoryAccessRepository(), 1, [
      qaAccount(2),
    ]);

    expect(report.updated).toEqual(["testuser2@qa.trygroove.app"]);
    expect(writes).toEqual([
      {
        kind: "update",
        uid: "qa-testuser-2",
        changes: { emailVerified: true, displayName: "QA testuser2" },
      },
    ]);
    expect(users.get("qa-testuser-2")?.emailVerified).toBe(true);
  });

  // GRV-113: an account provisioned before the claim existed gets it, and
  // nothing else about it changes.
  it("flags an existing account that is not internal yet", async () => {
    const { store, users, writes } = memoryUsers([
      {
        uid: "qa-testuser-4",
        email: "testuser4@qa.trygroove.app",
        emailVerified: true,
        displayName: "QA testuser4",
        internal: false,
      },
    ]);

    const report = await provisionQaAccounts(store, createInMemoryAccessRepository(), 1, [
      qaAccount(4),
    ]);

    expect(report.updated).toEqual(["testuser4@qa.trygroove.app"]);
    expect(writes).toEqual([{ kind: "markInternal", uid: "qa-testuser-4" }]);
    expect(users.get("qa-testuser-4")?.internal).toBe(true);
  });

  it("clears a refused sign-in on record for a QA address", async () => {
    const allowlist = createInMemoryAccessRepository({
      attempts: [
        {
          email: "testuser1@qa.trygroove.app",
          firstAttemptAt: 1,
          lastAttemptAt: 1,
          count: 1,
        },
      ],
    });

    await provisionQaAccounts(memoryUsers().store, allowlist, 5, [qaAccount(1)]);

    expect(await allowlist.listAttempts()).toEqual([]);
  });
});
