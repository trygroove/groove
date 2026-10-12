/**
 * The standing pool of QA accounts CI signs into the live app as (#1055).
 *
 * Guest start is retired (#854), so the scheduled QA sweep and the post-deploy
 * smoke test sign in as real, allowlisted accounts instead. They are ordinary
 * users with a verified address on a domain that receives no mail; what makes
 * them reachable from CI is that a service account signs a Firebase custom
 * token for one of them (`tests/e2e/hosted/qaSession.ts`). Nothing here is in
 * the app's bundle: only the provisioning script and the hosted suites import
 * it.
 *
 * - Slot 0 belongs to the post-deploy smoke test.
 * - Slots 1 to 10 belong to the sweep: agent *n* signs in as slot *n*, so
 *   agents stay out of each other's projects. Ten is the sweep's agent ceiling
 *   (`MAX_AGENTS` in `scripts/qa-sweep/sweep.mjs`).
 *
 * Every one of them carries the `internal` claim (GRV-113,
 * `src/access/claims.ts`), so CI's sessions and kept assistant turns stay out
 * of the product's measures.
 *
 * Like the rest of `src/access`, this imports nothing from Firebase: the
 * script supplies the Admin SDK as a {@link QaUserStore}, and the tests a map.
 */
import { type AllowlistWriter, type ApprovalReport, approveEmails } from "./allowlist";

/** The product owner's domain for the QA accounts. It receives no mail. */
export const QA_ACCOUNT_DOMAIN = "qa.trygroove.app";

/** The post-deploy smoke test's account. */
export const SMOKE_QA_SLOT = 0;

/** The highest slot: one per sweep agent, up to the sweep's ceiling of ten. */
export const MAX_QA_SLOT = 10;

/** One QA account, everything about it fixed by its slot. */
export interface QaAccount {
  slot: number;
  uid: string;
  email: string;
  displayName: string;
}

/** Whether `slot` names one of the pool's accounts. */
export function isQaSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot <= MAX_QA_SLOT;
}

/** The account in `slot`. Throws for a slot outside the pool. */
export function qaAccount(slot: number): QaAccount {
  if (!isQaSlot(slot)) {
    throw new RangeError(`There is no QA account in slot ${slot} (0 to ${MAX_QA_SLOT}).`);
  }
  return {
    slot,
    uid: `qa-testuser-${slot}`,
    email: `testuser${slot}@${QA_ACCOUNT_DOMAIN}`,
    displayName: `QA testuser${slot}`,
  };
}

/** Every account in the pool, slot 0 first. */
export const QA_ACCOUNTS: readonly QaAccount[] = Array.from(
  { length: MAX_QA_SLOT + 1 },
  (_, slot) => qaAccount(slot),
);

/** The part of an Auth user the provisioning reads and sets. */
export interface QaUserRecord {
  uid: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}

/** An existing Auth user as provisioning reads it: its record and its `internal` claim. */
export interface QaUser extends QaUserRecord {
  /** Whether the user carries the `internal: true` custom claim. */
  internal: boolean;
}

/** The fields provisioning may change on an existing user. */
export type QaUserChanges = Partial<Omit<QaUserRecord, "uid">>;

/**
 * Firebase Auth as provisioning needs it: the Admin SDK in the script, a map
 * in the tests. The one claim it can set is `internal`, keeping every other
 * claim as it is; there is deliberately no general way to set custom claims
 * through it, so provisioning cannot make a QA account an admin.
 */
export interface QaUserStore {
  /** The user with this UID, or `null` if there is none. */
  get(uid: string): Promise<QaUser | null>;
  create(user: QaUserRecord): Promise<void>;
  update(uid: string, changes: QaUserChanges): Promise<void>;
  /** Gives the user the `internal: true` claim, keeping its other claims. */
  markInternal(uid: string): Promise<void>;
}

/** What one provisioning run did. */
export interface QaProvisionReport {
  created: string[];
  updated: string[];
  unchanged: string[];
  allowlist: ApprovalReport;
}

/** How an existing user differs from its account, as the changes to make. */
function driftOf(user: QaUserRecord, account: QaAccount): QaUserChanges {
  const changes: QaUserChanges = {};
  if (user.email !== account.email) changes.email = account.email;
  if (user.emailVerified !== true) changes.emailVerified = true;
  if (user.displayName !== account.displayName) {
    changes.displayName = account.displayName;
  }
  return changes;
}

/**
 * Creates or corrects every QA account, flags each one internal, and puts
 * each address on the allowlist. Idempotent: a second run creates, updates
 * and adds nothing.
 *
 * It only ever touches the fields above and the `internal` claim. In
 * particular it leaves a disabled account disabled (the runbook's response to
 * a leaked key) and never sets any other custom claim.
 */
export async function provisionQaAccounts(
  users: QaUserStore,
  allowlist: AllowlistWriter,
  now: number,
  accounts: readonly QaAccount[] = QA_ACCOUNTS,
): Promise<QaProvisionReport> {
  const report: QaProvisionReport = {
    created: [],
    updated: [],
    unchanged: [],
    allowlist: { added: [], alreadyListed: [], invalid: [] },
  };
  for (const account of accounts) {
    const existing = await users.get(account.uid);
    if (!existing) {
      await users.create({
        uid: account.uid,
        email: account.email,
        emailVerified: true,
        displayName: account.displayName,
      });
      await users.markInternal(account.uid);
      report.created.push(account.email);
      continue;
    }
    const changes = driftOf(existing, account);
    const drifted = Object.keys(changes).length > 0;
    if (drifted) await users.update(account.uid, changes);
    if (!existing.internal) await users.markInternal(account.uid);
    if (drifted || !existing.internal) {
      report.updated.push(account.email);
    } else {
      report.unchanged.push(account.email);
    }
  }
  const emails = accounts.map((account) => account.email);
  report.allowlist = await approveEmails(allowlist, { emails, invalid: [] }, now);
  return report;
}
