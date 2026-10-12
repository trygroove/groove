// Context provider for auth state. Read it through `useAuth()`; it redirects
// unauthenticated users to the home page.

import type { User } from "firebase/auth";
import {
  createContext,
  createEffect,
  createStore,
  type ParentProps,
  useContext,
} from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import { isInternalAccount, markInternalTraffic } from "../shared/internalTraffic";
import { authService } from "./authService";

interface AuthState {
  user: User | null;
  loading: boolean;
  isAnonymous: boolean;
}

export interface AuthContextValue extends Readonly<AuthState> {
  /**
   * Signs in with Google (#951). This *signs in*, it does not link: the
   * session moves to that account's uid, and any projects made as a guest
   * stay with the guest. Rejects if the provider does (a closed popup, most
   * often, or the alpha allowlist refusing the address, #854), leaving the
   * current session as it was.
   */
  logIn(): Promise<void>;
  /**
   * Ends the session (#951). The provider reports no user and the caller
   * decides where to go (the app leaves for `/`).
   */
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue>();

export interface AuthProviderProps extends ParentProps {
  /** Overridden in tests; defaults to the app-wide analytics boundary. */
  analytics?: Analytics;
  /**
   * Where the internal-traffic flag persists when a team or test account
   * signs in. Defaults to the browser's `localStorage`; tests inject
   * `memoryStorage()`, and `null` persists nothing.
   */
  internalTrafficStorage?: Storage | null;
}

export function AuthProvider(props: AuthProviderProps) {
  const analytics = props.analytics ?? defaultAnalytics;
  const internalTrafficStorage = props.internalTrafficStorage;
  const [state, setState] = createStore<AuthState>({
    user: null,
    loading: true,
    isAnonymous: false,
  });

  // No session means signed out. Guest start is retired (#854): the alpha is
  // invite-only, so a visitor with no session is not signed in as anyone, and
  // the surfaces that need an account send them to the landing page
  // (`SignedInOnly`). A guest session from before keeps working: Firebase
  // restores it like any other, and `onAuthStateChanged` reports it below.
  const logIn = () => authService.signInWithGoogle();

  const signOut = () => authService.signOut();

  // PRD `OPS-02`: account type is a *person property*, not an event
  // parameter, and it is the only account fact analytics carries besides the
  // UID below. The
  // boundary attaches it to every subsequent event, so no call site passes
  // it and none can get it wrong.
  //
  // Split effect: every reactive read stays in the compute half, because Solid
  // 2 tracks only what that half touches. All three of `state.loading`,
  // `state.user` and — through `accountTypeOf` — `state.isAnonymous` are read
  // there; a read that slipped into the apply half below would leave the
  // reported account type frozen at whatever it was on the first run.
  createEffect(
    () => (state.loading || !state.user ? "unknown" : accountTypeOf(state)),
    (accountType) => analytics.setAccountType(accountType),
  );

  // GRV-106: the signed-in account is identified to analytics by its Firebase
  // UID and nothing else (no email, no display name), and forgotten again on
  // sign-out. `undefined` while auth is still resolving, so a page load does
  // not read as a sign-out before Firebase has restored the session.
  createEffect(
    () => (state.loading ? undefined : (state.user?.uid ?? null)),
    (uid) => {
      if (uid !== undefined) analytics.setUserId(uid);
    },
  );

  // The team's and the test accounts' sessions are internal traffic
  // (`src/shared/internalTraffic.ts`), so they stay out of the product's
  // measures without anyone remembering `?internal=1`. Marking is one-way: the
  // browser stays marked after a sign-out or a cohort account's sign-in, and
  // only `?internal=0` clears it. The address is read in the compute half and
  // goes no further than this boolean; analytics never sees it.
  createEffect(
    () => !state.loading && isInternalAccount(state.user?.email),
    (internalAccount) => {
      if (!internalAccount) return;
      markInternalTraffic(internalTrafficStorage);
      analytics.setInternalTraffic(true);
    },
  );

  // Split effect with no reactive dependencies: the subscription is created
  // once and lives until the provider is disposed. It sits in the apply half
  // because that is where a store write is sanctioned in Solid 2, and the
  // unsubscribe rides the cleanup the apply half *returns* rather than a
  // nested `onCleanup`.
  createEffect(
    () => undefined,
    () => {
      const unsubscribe = authService.onAuthStateChanged((user) => {
        setState((auth) => {
          auth.user = user;
          auth.loading = false;
          auth.isAnonymous = user?.isAnonymous ?? false;
        });
      });

      return () => unsubscribe();
    },
  );

  // Getters, so every read still goes through the store and stays reactive.
  const value: AuthContextValue = {
    get user() {
      return state.user;
    },
    get loading() {
      return state.loading;
    },
    get isAnonymous() {
      return state.isAnonymous;
    },
    logIn,
    signOut,
  };

  return <AuthContext value={value}>{props.children}</AuthContext>;
}

export function useAuth() {
  return useContext(AuthContext);
}

/** Coarse, non-identifying account fact for the analytics person property. */
function accountTypeOf(state: AuthState): "anonymous" | "registered" {
  return state.isAnonymous ? "anonymous" : "registered";
}
