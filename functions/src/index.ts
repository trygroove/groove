/**
 * Groove's Cloud Functions (#282): the first server-side code in the repo.
 *
 * Two Storage-triggered functions keep each user's storage total in
 * `users/{uid}/usage/current`, which `storage.rules` reads to refuse a write
 * that would take an account over its 1 GB allowance, and which the client
 * reads to warn before an import would. The rules for *how* the total moves
 * live in `src/userData/usageLedger.ts`, shared with the browser bundle and
 * unit-tested there; this file only connects Cloud Storage's events to a
 * Firestore transaction.
 *
 * A blocking `beforeSignIn` function (#854) keeps the alpha to its allowlist:
 * it is the enforcement, and `src/access/signInGate.ts` is its decision. A
 * Firestore trigger on the attempts it records emails the admin (#1112), as
 * `src/access/blockedSignInAlert.ts` decides.
 *
 * A streaming callable, `assistantTurn` (#69), is the assistant's gateway to
 * its model provider: `src/assistant/gateway.ts` decides everything, and the
 * provider's API key is a Secret Manager secret bound to that function alone.
 *
 * A callable, `revokeAccess` (#1147), lets an admin take an address off the
 * allowlist and end its account's sessions in one go, which needs the Admin
 * SDK; `src/access/revokeAccess.ts` decides.
 *
 * The assistant's transcripts (GRV-8) are kept by `assistantTurn` only for an
 * account that said yes; `assistantRetention` reads and stores that answer
 * (a no deletes what was kept), an hourly job deletes every transcript past
 * its 30 days, and deleting a project or an account deletes its transcripts.
 * Admins read them through `assistantTranscriptsAdmin` (GRV-98).
 * `src/assistant/retention.ts` and `transcripts.ts` decide all of it.
 *
 * Every kind of user data (packs today, recordings and presets later) is a
 * folder under `users/{uid}/`, so a new kind is counted as soon as it is added
 * to `USER_DATA_KINDS` — nothing here changes.
 *
 * Built by `firebase.json`'s `functions.predeploy` with `bun build`, which
 * bundles the shared modules in and leaves `firebase-admin`,
 * `firebase-functions` and `@anthropic-ai/sdk` to the runtime's own install of
 * `functions/package.json`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeApp } from "firebase-admin/app";
import { type Auth, getAuth } from "firebase-admin/auth";
import { type Firestore, getFirestore, type Transaction } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";
import { defineSecret, defineString } from "firebase-functions/params";
import { region as v1Region } from "firebase-functions/v1";
import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentDeleted, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onCall } from "firebase-functions/v2/https";
import { beforeUserSignedIn, HttpsError } from "firebase-functions/v2/identity";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  onObjectDeleted,
  onObjectFinalized,
  type StorageEvent,
} from "firebase-functions/v2/storage";
import { createTransport } from "nodemailer";
import { SITE_ORIGIN } from "../../site.config.mjs";
import {
  allowlistDocPath,
  NOT_ON_ALLOWLIST,
  type SignInAttempt,
  signInAttemptDocPath,
} from "../../src/access/allowlist";
import { alertBlockedSignIn } from "../../src/access/blockedSignInAlert";
import type { RevokeAccessStore } from "../../src/access/revokeAccess";
import { gateSignIn, type SignInGateStore } from "../../src/access/signInGate";
import {
  ASSISTANT_API_KEY_SECRET,
  ASSISTANT_CALL_LIMITS,
  ASSISTANT_YOUTUBE_KEY_SECRET,
} from "../../src/assistant/config";
import {
  createEmulatorAssistantProvider,
  emulatorVideoFinder,
  usesEmulatorProvider,
} from "../../src/assistant/emulatorProvider";
import type { AssistantProvider } from "../../src/assistant/provider";
import { createYouTubeVideoFinder, type VideoFinder } from "../../src/assistant/video";
import { CLOUD_FUNCTIONS_REGION } from "../../src/shared/cloudFunctions";
import type { VersionedPack } from "../../src/userData/packVersions";
import { withdrawRefusedSound } from "../../src/userData/refusedSound";
import {
  type LedgerOutcome,
  recordObjectDeleted,
  recordObjectWritten,
  type UsageTransaction,
} from "../../src/userData/usageLedger";
import {
  type UsageDocument,
  type UsageLedgerEntry,
  usageDocPath,
  usageObjectDocPath,
  userPackDocPath,
} from "../../src/userData/userData";
import { createAnthropicProvider } from "./anthropicProvider";
import { createAssistantHandler } from "./assistantHandler";
import { firestoreGuardStores } from "./assistantStores";
import { createRetentionHandler } from "./retentionHandler";
import { createRevokeAccessHandler } from "./revokeAccessHandler";
import { createTranscriptAdminHandler } from "./transcriptAdminHandler";
import { firestoreTranscriptStore } from "./transcriptStore";

/**
 * Where the functions run. A Storage trigger has to run in the default
 * bucket's location, and production's bucket is in `us-east1`; the deploy
 * refuses any other region. A bucket elsewhere means changing the one value
 * in `src/shared/cloudFunctions.ts`, which the browser's calls read too.
 */
setGlobalOptions({ region: CLOUD_FUNCTIONS_REGION, maxInstances: 10 });

initializeApp();

/** A {@link UsageTransaction} over one Firestore transaction. */
function firestoreUsage(db: Firestore, tx: Transaction): UsageTransaction {
  return {
    async getEntry(uid, objectPath) {
      const snapshot = await tx.get(db.doc(usageObjectDocPath(uid, objectPath)));
      return snapshot.exists ? (snapshot.data() as UsageLedgerEntry) : null;
    },
    async getUsage(uid) {
      const snapshot = await tx.get(db.doc(usageDocPath(uid)));
      return snapshot.exists ? (snapshot.data() as UsageDocument) : null;
    },
    setEntry(uid, objectPath, entry) {
      tx.set(db.doc(usageObjectDocPath(uid, objectPath)), entry);
    },
    setUsage(uid, usage) {
      tx.set(db.doc(usageDocPath(uid)), usage);
    },
  };
}

type Recorder = typeof recordObjectWritten;

async function record(event: StorageEvent, recorder: Recorder): Promise<void> {
  const db = getFirestore();
  const generation = String(event.data.generation);
  const outcome: LedgerOutcome = await db.runTransaction((tx) =>
    recorder(
      firestoreUsage(db, tx),
      { path: event.data.name, generation, size: Number(event.data.size) },
      Date.now(),
    ),
  );
  // The object path names the user and the pack, so it is not logged.
  if (outcome.applied) {
    logger.info("user data usage changed", { delta: outcome.deltaBytes });
  } else if (outcome.reason === "over_allowance") {
    await reclaim(event.data.bucket, event.data.name, generation);
    await withdrawFromPack(db, event.data.name);
  }
}

/**
 * Take a refused sound out of the pack that lists it, so the owner is never
 * shown a sound with no audio behind it. A pack that does not list it yet
 * (the browser writes the pack after the upload) is left alone; the browser
 * holds the allowance for its own imports, so that only happens when two
 * sessions race (`src/userData/refusedSound.ts`).
 */
async function withdrawFromPack(db: Firestore, objectPath: string): Promise<void> {
  const withdrawn = await db.runTransaction((tx) =>
    withdrawRefusedSound(
      {
        async getPack(uid, packId) {
          const snapshot = await tx.get(db.doc(userPackDocPath(uid, packId)));
          return snapshot.exists ? (snapshot.data() as VersionedPack) : null;
        },
        setPack(uid, packId, pack) {
          tx.set(db.doc(userPackDocPath(uid, packId)), pack);
        },
      },
      objectPath,
      Date.now(),
    ),
  );
  if (withdrawn) logger.warn("a refused sound was taken out of its pack");
}

/**
 * Delete an object the ledger refused because the account was already full:
 * uploads that raced past `storage.rules` together. Only the generation that
 * was refused, so a newer object at the same path is never touched; one that
 * is already gone is fine.
 */
async function reclaim(bucket: string, name: string, generation: string): Promise<void> {
  try {
    await getStorage()
      .bucket(bucket)
      .file(name, { generation })
      .delete({ ifGenerationMatch: generation });
    logger.warn("user data over the allowance was deleted");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 404 || code === 412) return;
    throw error;
  }
}

/** A user stored something: count it. */
export const userDataUsageWritten = onObjectFinalized((event) =>
  record(event, recordObjectWritten),
);

/** A user deleted something: release it. */
export const userDataUsageDeleted = onObjectDeleted((event) =>
  record(event, recordObjectDeleted),
);

/** The sign-in gate's store over Firestore, with the admin credential. */
function firestoreGate(db: Firestore): SignInGateStore {
  return {
    async isListed(email) {
      return (await db.doc(allowlistDocPath(email)).get()).exists;
    },
    async recordAttempt(email, update) {
      const ref = db.doc(signInAttemptDocPath(email));
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        tx.set(ref, update(snapshot.exists ? (snapshot.data() as SignInAttempt) : null));
      });
    },
  };
}

/**
 * Only verified, allowlisted addresses sign in during the alpha (#854). Runs
 * before every sign-in, a guest linking Google included (never an anonymous
 * sign-in: Firebase does not run blocking functions for those, which is why
 * the Anonymous provider is disabled); a refused one is recorded
 * in `signInAttempts` for an admin to approve. The refusal's message carries
 * {@link NOT_ON_ALLOWLIST}, which is how the browser knows to show the
 * "not on the alpha list" page rather than a generic failure. Nothing logged
 * here names the address.
 */
export const alphaAllowlistGate = beforeUserSignedIn(async (event) => {
  const decision = await gateSignIn(
    firestoreGate(getFirestore()),
    {
      email: event.data?.email ?? null,
      emailVerified: event.data?.emailVerified,
      providerId: event.credential?.providerId ?? event.additionalUserInfo?.providerId,
    },
    Date.now(),
  );
  if (decision.allowed) return;
  logger.info("a sign-in was refused", { reason: decision.reason });
  throw new HttpsError("permission-denied", NOT_ON_ALLOWLIST);
});

/** A `signInAttempts` snapshot's document, or `null` when there is none. */
function attemptOf(snapshot?: {
  exists: boolean;
  data(): unknown;
}): SignInAttempt | null {
  return snapshot?.exists ? (snapshot.data() as SignInAttempt) : null;
}

/** Who gets the blocked sign-in email. Empty turns the alerts off. */
const alertTo = defineString("ALLOWLIST_ALERT_TO", {
  default: "",
  description:
    "Address emailed when the alpha allowlist blocks a sign-in (empty: no alerts)",
});

/** The SMTP server alerts go through, e.g. `smtps://user:pass@smtp.gmail.com`. */
const alertSmtpUrl = defineSecret("ALLOWLIST_ALERT_SMTP_URL");

/**
 * Emails the admin when the allowlist refuses a sign-in (#1112): on an
 * address's first refusal, and again when it comes back after a quiet day. A
 * trigger of its own rather than part of {@link alphaAllowlistGate}, so a slow
 * or broken mail server never delays or fails a sign-in. No retries: a missed
 * alert is acceptable, since the attempt is still listed in `/admin`. Nothing
 * logged here names the address.
 */
export const allowlistBlockedSignInAlert = onDocumentWritten(
  { document: "signInAttempts/{email}", secrets: [alertSmtpUrl], retry: false },
  async (event) => {
    await alertBlockedSignIn({
      before: attemptOf(event.data?.before),
      after: attemptOf(event.data?.after),
      config: { to: alertTo.value(), smtpUrl: alertSmtpUrl.value() },
      siteOrigin: SITE_ORIGIN,
      async send(smtpUrl, message) {
        await createTransport(smtpUrl).sendMail(message);
      },
      logger,
    });
  },
);

/** The revocation's store over the Admin SDK, which the rules do not apply to. */
function adminRevokeStore(db: Firestore, auth: Auth): RevokeAccessStore {
  return {
    async unlist(email) {
      const ref = db.doc(allowlistDocPath(email));
      if (!(await ref.get()).exists) return false;
      await ref.delete();
      return true;
    },
    async endSessions(email) {
      let uid: string;
      try {
        uid = (await auth.getUserByEmail(email)).uid;
      } catch (error) {
        if ((error as { code?: unknown }).code === "auth/user-not-found") return false;
        throw error;
      }
      await auth.revokeRefreshTokens(uid);
      return true;
    },
  };
}

/**
 * An admin revoking an account's access (#1147): the address comes off the
 * allowlist and the account's refresh tokens are revoked, so its sessions end
 * at their next token refresh (within the hour) and its next sign-in meets
 * the gate. A callable, so Firebase verifies the caller's ID token before the
 * handler runs; the shared decision then refuses anyone without the `admin`
 * claim, and an admin revoking their own address. Nothing logged here names
 * the address. The export's name is what the browser calls
 * (`REVOKE_ACCESS_CALLABLE` in `src/access/revokeAccess.ts`).
 */
export const revokeAccess = onCall(
  createRevokeAccessHandler(() => adminRevokeStore(getFirestore(), getAuth())),
);

/** The provider's API key, readable by `assistantTurn` and nothing else. */
const anthropicApiKey = defineSecret(ASSISTANT_API_KEY_SECRET);

/** The YouTube Data API key, readable by `assistantTurn` and nothing else. */
const youtubeApiKey = defineSecret(ASSISTANT_YOUTUBE_KEY_SECRET);

/**
 * `[flaky]`'s memory, shared by every worker process the emulator runs: the
 * first to claim a message's marker file is the first time. A retry often
 * lands on another worker than the try it repeats, so a memory held in one
 * process would fail it again.
 */
function emulatorFirstTime(message: string): boolean {
  const name = createHash("sha256").update(message).digest("hex");
  const dir = join(tmpdir(), "groove-emulator-assistant");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, name), "", { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

let emulatorProvider: AssistantProvider | null = null;

/**
 * The real provider, or, in the emulator with no key, the scripted one the
 * browser suite drives (`src/assistant/emulatorProvider.ts`, GRV-26).
 */
function assistantProvider(): AssistantProvider {
  const apiKey = anthropicApiKey.value() ?? "";
  if (usesEmulatorProvider(process.env, apiKey)) {
    emulatorProvider ??= createEmulatorAssistantProvider(emulatorFirstTime);
    return emulatorProvider;
  }
  return createAnthropicProvider({ apiKey });
}

/**
 * How the gateway finds a tutorial video the model recommends (GRV-16, ADR
 * 0009 decision 5): a YouTube Data API search for the model's words, its
 * result checked with YouTube's oEmbed endpoint, both from here and never
 * from the browser. In the emulator with the scripted provider, the scripted
 * video's own search, so the browser suite never depends on YouTube. With no
 * YouTube key the model is offered no video at all.
 */
function videoFinder(): VideoFinder | undefined {
  if (usesEmulatorProvider(process.env, anthropicApiKey.value() ?? "")) {
    return emulatorVideoFinder;
  }
  const apiKey = (youtubeApiKey.value() ?? "").trim();
  return apiKey ? createYouTubeVideoFinder({ fetcher: fetch, apiKey }) : undefined;
}

/**
 * The assistant's gateway (#69, ADR 0006): one authenticated turn, its reply
 * streamed back as it is written. A callable, so Firebase verifies the
 * caller's ID token before the handler runs; the gateway then refuses a
 * guest, and holds every account to its request quota and the organisation
 * to its daily spend ceiling, with a kill switch in `assistantControl/settings`. Nothing it logs carries the conversation, the project or the
 * account (`src/assistant/telemetry.ts`).
 */
export const assistantTurn = onCall(
  {
    secrets: [anthropicApiKey, youtubeApiKey],
    timeoutSeconds: ASSISTANT_CALL_LIMITS.functionTimeoutSeconds,
  },
  createAssistantHandler(() => ({
    provider: assistantProvider(),
    guards: firestoreGuardStores(getFirestore()),
    transcripts: firestoreTranscriptStore(getFirestore()),
    findVideo: videoFinder(),
  })),
);

/**
 * The account's answer to the assistant's disclosure (GRV-8): read it, give
 * it, or add what became of a proposal to a kept turn. Saying no deletes every
 * transcript the account has before the call returns. The export's name is
 * what the browser calls (`ASSISTANT_RETENTION_CALLABLE` in
 * `src/assistant/retention.ts`).
 */
export const assistantRetention = onCall(
  createRetentionHandler(() => firestoreTranscriptStore(getFirestore())),
);

/**
 * Kept transcripts for admins (GRV-98): the newest turns, narrowed by
 * account, project, outcome and traffic, and one turn in full, so the team
 * can see why a proposal was rejected. Only the `admin` claim gets anything;
 * the rules still deny every client the collection. The export's name is
 * what the browser calls (`TRANSCRIPT_ADMIN_CALLABLE` in
 * `src/assistant/transcriptAdmin.ts`).
 */
export const assistantTranscriptsAdmin = onCall(
  createTranscriptAdminHandler(() => firestoreTranscriptStore(getFirestore())),
);

/**
 * Deletes every transcript whose 30 days have passed (GRV-8). Hourly, so a
 * record outlives its window by an hour at most; deleted, never archived.
 */
export const purgeExpiredTranscripts = onSchedule("every 60 minutes", async () => {
  const deleted = await firestoreTranscriptStore(getFirestore()).deleteExpired(
    Date.now(),
  );
  logger.info("expired assistant transcripts deleted", { deleted });
});

/** A deleted project takes its transcripts with it (GRV-8). */
export const deleteProjectTranscripts = onDocumentDeleted(
  "projects/{projectId}",
  async (event) => {
    const deleted = await firestoreTranscriptStore(getFirestore()).deleteForProject(
      event.params.projectId,
    );
    logger.info("a deleted project's assistant transcripts deleted", { deleted });
  },
);

/**
 * A deleted account takes its transcripts and its retention answer with it
 * (GRV-8). A first-generation trigger: the second generation has no
 * account-deleted event.
 */
export const deleteAccountTranscripts = v1Region(CLOUD_FUNCTIONS_REGION)
  .auth.user()
  .onDelete(async (user) => {
    const store = firestoreTranscriptStore(getFirestore());
    const deleted = await store.deleteForUser(user.uid);
    await store.deletePreference(user.uid);
    logger.info("a deleted account's assistant transcripts deleted", { deleted });
  });
