import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, initializeFirestore } from "firebase/firestore";
import {
  firestoreSettings,
  placeholderFirebaseConfig,
  resolveEmulatorHosts,
} from "./devBackend";

// Placeholder credentials for the two backends that do not authenticate
// against a real project: the mock backend never loads the SDK at all, and the
// emulator validates none of them. Falling back keeps `initializeApp`
// succeeding so neither mode needs a configured `.env`. The emulator's
// `projectId` is load-bearing rather than cosmetic — see `src/devBackend.ts`.
const placeholders = placeholderFirebaseConfig();

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? placeholders?.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? placeholders?.authDomain,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? placeholders?.projectId,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? placeholders?.storageBucket,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? placeholders?.appId,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Local Firebase Emulator wiring (`VITE_DEV_BACKEND=emulator`, plus the
// `FND-009` emulator-backed browser E2E suite; see
// `tests/e2e/emulator/playwright.config.ts`). Distinct from the mock backend, which swaps
// in an in-memory fake and never touches the Firebase SDK at all: this points
// the *real* SDK at a local emulator so a genuine page reload proves
// persistence rather than a fake that resets on every navigation. Emulator mode
// implies the default hosts and `VITE_*_EMULATOR_HOST` overrides them — see
// `src/devBackend.ts`. Dev/test only; never set in a real deployment.
const emulatorHosts = resolveEmulatorHosts();
export const db = initializeFirestore(app, firestoreSettings(emulatorHosts));
if (emulatorHosts) {
  const [firestoreHost, firestorePort] = emulatorHosts.firestore.split(":");
  connectFirestoreEmulator(db, firestoreHost, Number(firestorePort));
  connectAuthEmulator(auth, `http://${emulatorHosts.auth}`, {
    disableWarnings: true,
  });
}
