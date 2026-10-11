import type { Page } from "@playwright/test";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  GoogleAuthProvider,
  getAuth,
  signInWithCredential,
  signOut,
} from "firebase/auth";
import { installFirebaseUser } from "../../support/firebaseSession";
import { allowlist, uniqueEmail } from "./access";
import { seedSkippedOnboarding } from "./onboarding";

/**
 * Puts a signed-in, **invited** (allowlisted) Google session into a page,
 * without going anywhere near the product's own sign-in control.
 *
 * ## Why
 *
 * Guest start is retired (#854), so every flow whose precondition is "signed
 * in" needs an account, and there are two ways to get one: drive the identity
 * provider's UI, or install the session the way a returning producer's browser
 * already has it installed. Driving the provider makes every such flow depend
 * on our sign-in control's markup *and* on the Auth emulator's account
 * chooser, so a change to either reddens flows that are not about signing in
 * at all. This takes the second route: signing in is a journey of its own, and
 * CF-001 and CF-032 are the flows that walk it.
 *
 * ## Why it is not a pile of guesses
 *
 * This process signs the account in with the same Firebase SDK the app runs,
 * through the Auth emulator, and `installFirebaseUser`
 * (`tests/e2e/support/firebaseSession.ts`, shared with the hosted suites'
 * QA-account sign-in) stores *that user's own* `toJSON()` where the SDK looks
 * for it. (This used to copy the record a guest session wrote; there are no
 * guest sessions to copy any more.)
 *
 * The sign-in goes through the emulator, so the blocking `beforeSignIn`
 * function decides it exactly as production would: the address is put on the
 * allowlist first.
 */

/**
 * Where `firebase emulators:exec` bound the Auth emulator, exported into this
 * process the same way `tests/e2e/emulator/playwright.config.ts` reads it.
 */
const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";

/**
 * The app's emulator-mode credentials (`placeholderFirebaseConfig` in
 * `src/devBackend.ts`, which cannot be imported here because it reads
 * `import.meta.env`). The API key is load-bearing: it is part of the key the
 * SDK stores the user under, so it must be the one the page runs with.
 */
const PROJECT_ID = "demo-solid-groove";
const API_KEY = `${PROJECT_ID}-api-key`;
const APP_NAME = "[DEFAULT]";

export interface RegisteredSession {
  uid: string;
  email: string;
  displayName: string;
}

export interface SeedRegisteredSessionOptions {
  /**
   * Distinguishes this run's account from every other. A flow whose
   * precondition is an *empty* account cannot reuse one across runs, so
   * callers pass something unique (the spec id and browser name, say).
   */
  label: string;
  displayName?: string;
  /**
   * Whether the account has been through onboarding (GRV-25). By default it
   * has skipped it, so the dashboard opens as it always has; CF-035, the flow
   * about onboarding, passes `false` for an account with no profile at all.
   */
  onboarded?: boolean;
}

/**
 * Signs `page` in as a fresh invited Google account and leaves it on a page
 * that has not loaded the app, ready for the caller's own first navigation.
 *
 * The session lives in the browser context, so it also covers any further page
 * that context opens, and it survives `page.reload()` as a real one does.
 */
export async function seedRegisteredSession(
  page: Page,
  options: SeedRegisteredSessionOptions,
): Promise<RegisteredSession> {
  const email = uniqueEmail(options.label);
  const displayName = options.displayName ?? "Flow Producer";

  await allowlist(email);
  const record = await signInInThisProcess(email, displayName);
  if (options.onboarded !== false) await seedSkippedOnboarding(String(record.uid));

  await installFirebaseUser(page, API_KEY, record);

  return { uid: String(record.uid), email, displayName };
}

/**
 * Signs `email` in through the Auth emulator with the Firebase SDK, and
 * returns the record the SDK persists for that user. Playwright runs a
 * worker's tests one at a time, so one app per worker process is shared and
 * signed out again before returning.
 */
async function signInInThisProcess(
  email: string,
  displayName: string,
): Promise<Record<string, unknown>> {
  const app = getApps().some((existing) => existing.name === APP_NAME)
    ? getApp()
    : initializeApp({
        apiKey: API_KEY,
        authDomain: `${PROJECT_ID}.firebaseapp.com`,
        projectId: PROJECT_ID,
      });
  const auth = getAuth(app);
  if (!auth.emulatorConfig) {
    connectAuthEmulator(auth, `http://${authEmulatorHost}`, { disableWarnings: true });
  }
  // The emulator accepts an unsigned JSON "id token" in place of Google's
  // signed one — that substitution is the whole point of an auth emulator.
  const idToken = JSON.stringify({
    sub: `google-${email}`,
    email,
    email_verified: true,
    name: displayName,
  });
  const { user } = await signInWithCredential(
    auth,
    GoogleAuthProvider.credential(idToken),
  );
  const record = user.toJSON() as Record<string, unknown>;
  await signOut(auth);
  return record;
}
