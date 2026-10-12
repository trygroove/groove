/**
 * The admin credential the allowlist scripts run with (#854).
 *
 * Application default credentials: `gcloud auth application-default login`
 * on a laptop, or `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service
 * account key. The project is `FIREBASE_PROJECT_ID` (as `bun run deploy` reads
 * it), else `GOOGLE_CLOUD_PROJECT`. With `FIRESTORE_EMULATOR_HOST` and
 * `FIREBASE_AUTH_EMULATOR_HOST` set, the Admin SDK talks to the emulators
 * instead, which is how these scripts are tried out locally.
 *
 * The admin credential is not subject to security rules, which is why only
 * these scripts and the blocking function hold it; the browser reaches the
 * allowlist through an `admin: true` custom claim instead.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { type Auth, getAuth } from "firebase-admin/auth";
import { type Firestore, getFirestore } from "firebase-admin/firestore";
import {
  type AllowlistWriter,
  allowlistDocPath,
  approvalChunks,
  signInAttemptDocPath,
} from "../../src/access/allowlist";
import { withInternalClaim } from "../../src/access/claims";

export interface AdminServices {
  auth: Auth;
  db: Firestore;
}

export function adminServices(): AdminServices {
  const projectId = process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    fail(
      "Set FIREBASE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) to the Firebase project to change.",
    );
  }
  const usingEmulators =
    process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const app = initializeApp(
    usingEmulators ? { projectId } : { projectId, credential: applicationDefault() },
  );
  return { auth: getAuth(app), db: getFirestore(app) };
}

/** The allowlist writer over the Admin SDK: the same contract as the admin page's. */
export function adminAllowlistWriter(db: Firestore): AllowlistWriter {
  return {
    async listed(emails) {
      const listed = new Set<string>();
      for (const chunk of approvalChunks(emails)) {
        if (chunk.length === 0) continue;
        const snapshots = await db.getAll(
          ...chunk.map((email) => db.doc(allowlistDocPath(email))),
        );
        for (const snapshot of snapshots) if (snapshot.exists) listed.add(snapshot.id);
      }
      return listed;
    },
    async commit(entries, clearAttempts) {
      const byEmail = new Map(entries.map((entry) => [entry.email, entry]));
      for (const chunk of approvalChunks(clearAttempts)) {
        const batch = db.batch();
        for (const email of chunk) {
          const entry = byEmail.get(email);
          if (entry) batch.set(db.doc(allowlistDocPath(email)), entry);
          batch.delete(db.doc(signInAttemptDocPath(email)));
        }
        await batch.commit();
      }
    },
  };
}

/**
 * Sets or clears the `internal` custom claim (GRV-113) on one account, keeping
 * every other claim it has. Reads the account's current claims first, so an
 * `admin` granted in between is never dropped by a stale copy.
 */
export async function setInternalClaim(
  auth: Auth,
  uid: string,
  internal: boolean,
): Promise<void> {
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, withInternalClaim(user.customClaims, internal));
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
