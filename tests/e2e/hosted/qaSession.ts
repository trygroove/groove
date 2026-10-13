import type { Page } from "@playwright/test";
import { type FirebaseApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
  signOut,
} from "firebase/auth";
import {
  type App as AdminApp,
  cert,
  initializeApp as initAdmin,
} from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { isQaSlot, type QaAccount, qaAccount } from "../../../scripts/access/qaPool";
import { installFirebaseUser } from "../support/firebaseSession";

/**
 * Signs a page into the live app as one of the QA accounts (#1055), with no
 * person and no Google account.
 *
 * A dedicated service account, whose key is the `QA_SIGN_IN_SERVICE_ACCOUNT`
 * secret, signs a Firebase custom token for the slot's account with the Admin
 * SDK; this process exchanges it for a session with the same Firebase client
 * SDK the app runs (`signInWithCustomToken`); and that user's own `toJSON()`
 * is written into the page's IndexedDB by `installFirebaseUser`, the code the
 * emulator suite installs its sessions with. The app is not changed: nothing
 * in its bundle knows about QA accounts or custom tokens.
 *
 * Firebase does not run blocking functions for a custom-token sign-in, so the
 * allowlist gate never sees these. The accounts are allowlisted and verified
 * all the same (`bun run qa:accounts`), see `docs/runbooks/alpha-allowlist.md`.
 *
 * Every failure says what is wrong without the key, the token or the address:
 * the hosted suites' logs and reports are uploaded, and the sweep's become
 * public issues.
 */

/** The repository secret holding the service account's JSON key. */
export const QA_SIGN_IN_SECRET = "QA_SIGN_IN_SERVICE_ACCOUNT";

/**
 * The web API key the deployed build runs with. Not a secret, but
 * load-bearing: the SDK stores the signed-in user under a key built from it,
 * so it must be the build's own. The deploy and preview jobs pass the
 * `VITE_FIREBASE_API_KEY` variable the build was made with (it is scoped to
 * the `prod` environment); anywhere else, such as the QA sweep, it is read
 * from the site itself ({@link HOSTING_CONFIG_PATH}).
 */
export const QA_API_KEY_VAR = "VITE_FIREBASE_API_KEY";

/**
 * Firebase Hosting's reserved URL for the project's web app config, served on
 * every Hosting origin (custom domain and preview channels included). Its
 * `apiKey` is the one the build is configured with (`VITE_FIREBASE_API_KEY`
 * is that web app's key).
 */
export const HOSTING_CONFIG_PATH = "/__/firebase/init.json";

/** A QA sign-in that could not happen, said without anything secret in it. */
export class QaSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaSignInError";
  }
}

/**
 * Why QA sign-in cannot be attempted here, or `null` when it can. A fork's
 * pull request gets no secrets, so the smoke test skips its signed-in test
 * with this rather than failing.
 */
export function qaSignInUnavailable(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[QA_SIGN_IN_SECRET]?.trim()
    ? null
    : `QA sign-in is unavailable: ${QA_SIGN_IN_SECRET} is not set.`;
}

/** The build's web API key: the variable if it is set, else the site's own. */
async function webApiKey(page: Page, env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnv = env[QA_API_KEY_VAR]?.trim();
  if (fromEnv) return fromEnv;
  let apiKey: unknown;
  try {
    const response = await page.request.get(HOSTING_CONFIG_PATH);
    if (response.ok()) apiKey = ((await response.json()) as { apiKey?: unknown }).apiKey;
  } catch {
    // Reported below, the same as a missing key.
  }
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new QaSignInError(
      `Could not read the site's web API key from ${HOSTING_CONFIG_PATH}; ` +
        `set ${QA_API_KEY_VAR} to the key the build runs with.`,
    );
  }
  return apiKey;
}

interface ServiceAccountKey {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * The secret, parsed. `JSON.parse`'s own message quotes the text around a
 * syntax error, which here would be part of the private key, so it is never
 * passed on.
 */
function serviceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new QaSignInError(`${QA_SIGN_IN_SECRET} is not valid JSON.`);
  }
  const key = parsed as Partial<ServiceAccountKey> | null;
  for (const field of ["project_id", "client_email", "private_key"] as const) {
    if (typeof key?.[field] !== "string" || key[field] === "") {
      throw new QaSignInError(
        `${QA_SIGN_IN_SECRET} is not a service account key: it has no ${field}.`,
      );
    }
  }
  return key as ServiceAccountKey;
}

/** The Firebase error code alone, which names no account and holds no token. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "an error with no code";
}

let adminApp: AdminApp | undefined;
let clientApp: FirebaseApp | undefined;

/**
 * Signs `slot`'s account in, in this process, and returns the record the SDK
 * persists for it. One admin and one client app per process, signed out again
 * before returning, because Playwright runs a worker's tests one at a time.
 */
async function signInInThisProcess(
  account: QaAccount,
  apiKey: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const key = serviceAccountKey(env[QA_SIGN_IN_SECRET] as string);

  let token: string;
  try {
    const credential = cert({
      projectId: key.project_id,
      clientEmail: key.client_email,
      privateKey: key.private_key,
    });
    adminApp ??= initAdmin({ credential, projectId: key.project_id }, "qa-sign-in");
    token = await getAdminAuth(adminApp).createCustomToken(account.uid);
  } catch (error) {
    throw new QaSignInError(
      `Could not sign a custom token for QA slot ${account.slot} (${codeOf(error)}). ` +
        `Check ${QA_SIGN_IN_SECRET} holds a current key.`,
    );
  }

  clientApp ??= initializeApp(
    {
      apiKey,
      authDomain: `${key.project_id}.firebaseapp.com`,
      projectId: key.project_id,
    },
    "qa-sign-in",
  );
  const auth = getAuth(clientApp);
  // Only for trying this out against the Auth emulator; CI never sets it.
  const emulator = env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulator && !auth.emulatorConfig) {
    connectAuthEmulator(auth, `http://${emulator}`, { disableWarnings: true });
  }

  let record: Record<string, unknown>;
  try {
    const { user } = await signInWithCustomToken(auth, token);
    record = user.toJSON() as Record<string, unknown>;
  } catch (error) {
    throw new QaSignInError(
      `Firebase refused the sign-in for QA slot ${account.slot} (${codeOf(error)}). ` +
        "Check the account exists (bun run qa:accounts) and is not disabled, and that " +
        "the web API key is this project's.",
    );
  } finally {
    await signOut(auth).catch(() => undefined);
  }
  if (record.uid !== account.uid) {
    throw new QaSignInError(`QA slot ${account.slot} signed in as a different user.`);
  }
  return record;
}

/**
 * Signs `page`'s browser context in as the QA account in `slot` and leaves the
 * page on `about:blank`, ready for the caller's first navigation (which should
 * carry `?internal=1`, so the account's traffic stays out of the product's
 * measures). The page must be on the app's origin (`baseURL`).
 */
export async function signInAsQaAccount(
  page: Page,
  slot: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QaAccount> {
  if (!isQaSlot(slot)) throw new QaSignInError(`There is no QA slot ${slot}.`);
  const unavailable = qaSignInUnavailable(env);
  if (unavailable) throw new QaSignInError(unavailable);
  const account = qaAccount(slot);
  const apiKey = await webApiKey(page, env);
  const record = await signInInThisProcess(account, apiKey, env);
  await installFirebaseUser(page, apiKey, record);
  return account;
}
