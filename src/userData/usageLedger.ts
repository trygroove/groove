import {
  parseUserDataPath,
  USER_DATA_CAP_BYTES,
  type UsageDocument,
  type UsageLedgerEntry,
  type UserDataKind,
} from "./userData";

/**
 * How a user's storage total moves when an object is written or deleted (#282).
 *
 * The Cloud Function in `functions/src/index.ts` is a thin wrapper that hands
 * Cloud Storage's `finalized` and `deleted` events to {@link recordObjectWritten}
 * and {@link recordObjectDeleted} inside a Firestore transaction. The rules are
 * all here, over a {@link UsageTransaction} interface, so they are unit-tested
 * without a function runtime or a database:
 *
 *  - an event is **idempotent**. Cloud Storage delivers at least once, so each
 *    object has a ledger entry recording the generation it is about and what
 *    happened to it, and a repeat changes nothing;
 *  - events arrive in **any order**. An event for a generation older than the
 *    one the entry is about is stale. A delete that arrives before its write
 *    leaves a tombstone for that generation, so the late write is not counted
 *    for an object that no longer exists. An overwrite is a delete of the old
 *    generation and a write of the new one, and balances either way round;
 *  - the **allowance holds** even when uploads race. `storage.rules` check the
 *    total before a write, but the total only moves once the function runs, so
 *    two uploads started together can each pass. A write that would take the
 *    account over {@link USER_DATA_CAP_BYTES} is refused here instead: it is
 *    not counted, and the outcome tells the function to delete the object.
 *    That delete's own event then finds a `refused` entry and changes nothing;
 *    An internal or admin account (GRV-112) has no allowance: its writes are
 *    always counted, so its total stays true, and never refused;
 *  - only `users/{uid}/{kind}/…` objects of a declared kind count. The factory
 *    library and anything else in the bucket are skipped.
 */

/** The reads and writes one transaction needs. */
export interface UsageTransaction {
  getEntry(uid: string, objectPath: string): Promise<UsageLedgerEntry | null>;
  getUsage(uid: string): Promise<UsageDocument | null>;
  setEntry(uid: string, objectPath: string, entry: UsageLedgerEntry): void;
  setUsage(uid: string, usage: UsageDocument): void;
}

/** One Cloud Storage object event, reduced to what the ledger reads. */
export interface StorageObjectEvent {
  readonly path: string;
  readonly generation: string;
  /** Bytes, for a write; ignored on delete. */
  readonly size?: number;
}

/** What one event did to the total, for the function's log line. */
export type LedgerOutcome =
  | {
      readonly applied: false;
      readonly reason: "not_user_data" | "duplicate" | "stale" | "not_counted";
    }
  /**
   * The write would take the account over its allowance. It was not counted,
   * and the function must delete the object (this generation of it).
   */
  | { readonly applied: false; readonly reason: "over_allowance"; readonly uid: string }
  | { readonly applied: true; readonly uid: string; readonly deltaBytes: number };

const EMPTY_USAGE: UsageDocument = { totalBytes: 0, byKind: {}, updatedAt: 0 };

/**
 * Orders two object generations. Cloud Storage's are decimal integers too
 * large for a `number`, so they compare as `BigInt`s; anything else (never
 * seen in practice) falls back to comparing length, then text.
 */
export function compareGenerations(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The bytes an entry has in the total. */
function countedBytes(entry: UsageLedgerEntry | null): number {
  return entry?.state === "counted" ? entry.bytes : 0;
}

/** What the ledger asks about an account outside the transaction's reads. */
export interface UsageLedgerOptions {
  /**
   * Whether the account carries the `internal` or `admin` claim
   * (`hasUnlimitedClaim`, GRV-112), so a write past the allowance is counted
   * rather than refused. Asked only of a write that would go over. Without
   * one, every account is held to the allowance.
   */
  readonly isUnlimited?: (uid: string) => Promise<boolean>;
}

/**
 * Count a written (or overwritten) object against its owner, if it fits or
 * the owner has no allowance.
 */
export async function recordObjectWritten(
  tx: UsageTransaction,
  event: StorageObjectEvent,
  now: number,
  options: UsageLedgerOptions = {},
): Promise<LedgerOutcome> {
  const owner = parseUserDataPath(event.path);
  if (!owner) return { applied: false, reason: "not_user_data" };
  const [entry, stored] = await Promise.all([
    tx.getEntry(owner.uid, event.path),
    tx.getUsage(owner.uid),
  ]);
  if (entry) {
    const order = compareGenerations(event.generation, entry.generation);
    if (order < 0) return { applied: false, reason: "stale" };
    if (order === 0) {
      // A tombstone for this very generation: it was deleted before this
      // write event arrived, so there is nothing left to count.
      return {
        applied: false,
        reason: entry.state === "deleted" ? "stale" : "duplicate",
      };
    }
  }
  const usage = stored ?? EMPTY_USAGE;
  const bytes = Math.max(0, Math.round(event.size ?? 0));
  // A newer generation replaces whatever the entry counted: an overwrite whose
  // delete has not arrived yet comes off once, now, and that delete is stale.
  const replaced = countedBytes(entry);
  if (
    bytes > 0 &&
    usage.totalBytes - replaced + bytes > USER_DATA_CAP_BYTES &&
    !(await options.isUnlimited?.(owner.uid))
  ) {
    tx.setEntry(owner.uid, event.path, {
      kind: owner.kind,
      bytes: 0,
      generation: event.generation,
      state: "refused",
    });
    if (replaced > 0) tx.setUsage(owner.uid, adjust(usage, owner.kind, -replaced, now));
    return { applied: false, reason: "over_allowance", uid: owner.uid };
  }
  const delta = bytes - replaced;
  tx.setEntry(owner.uid, event.path, {
    kind: owner.kind,
    bytes,
    generation: event.generation,
    state: "counted",
  });
  tx.setUsage(owner.uid, adjust(usage, owner.kind, delta, now));
  return { applied: true, uid: owner.uid, deltaBytes: delta };
}

/**
 * Release a deleted object's bytes, unless a newer generation already replaced
 * it. The entry stays behind as a tombstone for the deleted generation.
 */
export async function recordObjectDeleted(
  tx: UsageTransaction,
  event: StorageObjectEvent,
  now: number,
): Promise<LedgerOutcome> {
  const owner = parseUserDataPath(event.path);
  if (!owner) return { applied: false, reason: "not_user_data" };
  const [entry, stored] = await Promise.all([
    tx.getEntry(owner.uid, event.path),
    tx.getUsage(owner.uid),
  ]);
  if (entry) {
    const order = compareGenerations(event.generation, entry.generation);
    if (order < 0) return { applied: false, reason: "stale" };
    if (order === 0 && entry.state === "deleted") {
      return { applied: false, reason: "duplicate" };
    }
  }
  // Deleting this generation, or a newer one whose write is still on its way,
  // takes whatever the entry counted with it: an older generation was
  // overwritten by the one being deleted, so it is gone too.
  const released = countedBytes(entry);
  tx.setEntry(owner.uid, event.path, {
    kind: owner.kind,
    bytes: 0,
    generation: event.generation,
    state: "deleted",
  });
  if (released === 0) return { applied: false, reason: "not_counted" };
  tx.setUsage(owner.uid, adjust(stored ?? EMPTY_USAGE, owner.kind, -released, now));
  return { applied: true, uid: owner.uid, deltaBytes: -released };
}

/**
 * The usage document after `delta` bytes of `kind`. The kind is part of the
 * path the ledger is keyed on, so an object never changes kind, and the total
 * is always the sum of the kinds.
 */
function adjust(
  usage: UsageDocument,
  kind: UserDataKind,
  delta: number,
  now: number,
): UsageDocument {
  const byKind: Partial<Record<UserDataKind, number>> = {
    ...usage.byKind,
    [kind]: (usage.byKind[kind] ?? 0) + delta,
  };
  const totalBytes = Object.values(byKind).reduce((sum, bytes) => sum + (bytes ?? 0), 0);
  return { totalBytes, byKind, updatedAt: now };
}
