/**
 * `bun run internal:grant -- <email>` and `bun run internal:revoke -- <email>`
 * (GRV-113): flag an account as internal (a team or test account), or stop.
 *
 * Sets or removes the `internal: true` custom claim (`src/access/claims.ts`),
 * keeping any other claims the account has. An internal account's sessions are
 * marked internal traffic in analytics (`AuthProvider`) and its kept assistant
 * turns are marked internal (`functions/src/assistantHandler.ts`), so the
 * team's own use stays out of the product's measures. It grants no access:
 * the address still has to be on the allowlist to sign in.
 *
 * The account has to exist, which means it has signed in once. The claim
 * reaches the browser with the account's next ID token, so a signed-in
 * account is marked after signing out and in again (or within the hour); a
 * browser it has already marked stays marked until `?internal=0`.
 *
 * Same credentials as the other access scripts (`adminApp.ts`): application
 * default credentials for an owner, or the emulators.
 */
import { normaliseEmail, parseEmailBatch } from "../../src/access/allowlist";
import { adminServices, fail, setInternalClaim } from "./adminApp";

const USAGE = "Usage: bun run internal:grant -- <email>  (or internal:revoke)";

const [mode, raw] = process.argv.slice(2);
if (mode !== "grant" && mode !== "revoke") fail(USAGE);
if (!raw) fail(USAGE);

const batch = parseEmailBatch(raw);
if (batch.emails.length !== 1) fail(`Not an email address: ${raw}`);
const email = normaliseEmail(batch.emails[0]);

const { auth } = adminServices();

let uid: string;
try {
  uid = (await auth.getUserByEmail(email)).uid;
} catch (error) {
  if ((error as { code?: string }).code === "auth/user-not-found") {
    fail(`${email} has no account yet. Sign in with it once, then run this again.`);
  }
  throw error;
}

const internal = mode === "grant";
await setInternalClaim(auth, uid, internal);
console.log(
  internal
    ? `${email} is internal. Its sessions count as internal from its next sign-in.`
    : `${email} is no longer internal. A browser it already marked stays marked until ?internal=0.`,
);
