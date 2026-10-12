/**
 * `bun run qa:accounts` (#1055): create the QA accounts CI signs in as.
 *
 * Creates or corrects `testuser0`…`testuser10@qa.trygroove.app` (UIDs
 * `qa-testuser-<n>`, address verified, display name `QA testuser<n>`) and puts
 * every address on the allowlist, through `provisionQaAccounts`
 * (`src/access/qaAccounts.ts`). Every account gets the `internal` claim
 * (GRV-113), so CI's traffic stays out of the product's measures. Running it
 * again changes nothing. It never grants `admin`, and it leaves a disabled
 * account disabled.
 *
 * Same credentials as the other access scripts (`adminApp.ts`): application
 * default credentials for an owner, or the emulators.
 */
import type { UserRecord } from "firebase-admin/auth";
import { hasInternalClaim } from "../../src/access/claims";
import {
  provisionQaAccounts,
  type QaUser,
  type QaUserStore,
} from "../../src/access/qaAccounts";
import { adminAllowlistWriter, adminServices, setInternalClaim } from "./adminApp";
import { printReport } from "./report";

const { auth, db } = adminServices();

const toRecord = (user: UserRecord): QaUser => ({
  uid: user.uid,
  email: user.email,
  emailVerified: user.emailVerified,
  displayName: user.displayName,
  internal: hasInternalClaim(user.customClaims),
});

const users: QaUserStore = {
  async get(uid) {
    try {
      return toRecord(await auth.getUser(uid));
    } catch (error) {
      if ((error as { code?: string }).code === "auth/user-not-found") return null;
      throw error;
    }
  },
  async create(user) {
    await auth.createUser(user);
  },
  async update(uid, changes) {
    await auth.updateUser(uid, changes);
  },
  async markInternal(uid) {
    await setInternalClaim(auth, uid, true);
  },
};

const report = await provisionQaAccounts(users, adminAllowlistWriter(db), Date.now());

console.log(`Accounts created: ${report.created.length}`);
for (const email of report.created) console.log(`  + ${email}`);
console.log(`Accounts updated: ${report.updated.length}`);
for (const email of report.updated) console.log(`  ~ ${email}`);
console.log(`Accounts unchanged: ${report.unchanged.length}`);
console.log("Allowlist:");
printReport(report.allowlist);
