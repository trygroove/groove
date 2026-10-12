// Marks a session as internal (team) traffic so it can be excluded from the
// PRD section 11 success measures -- see PRD `OPS-01` ("Team traffic is
// marked so internal sessions can be excluded") and `OPS-02`'s
// non-identifying `internal` user property.
//
// This module owns *detection and persistence* of the flag. `src/analytics`
// reads `isInternalTraffic()` to set the `internal` person property and to
// stamp every event with an `internal` event property, which is what the
// PostHog project's internal-traffic filter excludes (GRV-106); nothing here
// talks to an analytics SDK.
//
// Two things mark a browser as internal:
//
// - **Signing in as a team or test account.** `isInternalAccount` names them:
//   the product owner, the `groovetestuser<n>@gmail.com` accounts used for
//   hands-on testing, and the QA pool CI signs in as (`src/access/qaAccounts.ts`,
//   every address on its domain). `AuthProvider` calls `markInternalTraffic`
//   when one of them signs in, so from then on every load of that browser is
//   internal from its first event, not just from sign-in onwards.
// - **Visiting with `?internal=1`** (or `?internal=true`), for a browser no
//   listed account has signed into. `?internal=0` (or `?internal=false`) clears
//   the flag either way, so a team member testing the cohort experience can
//   turn it back off.
//
// Both persist the flag in `localStorage` for that browser, so it survives
// navigation and future sessions.

export const INTERNAL_TRAFFIC_STORAGE_KEY = "sg_internal_traffic";

const TRUE_VALUES = new Set(["1", "true"]);
const FALSE_VALUES = new Set(["0", "false"]);

/**
 * Pure parse of a `?internal=` query value into a tri-state: `true`/`false`
 * to set the flag, or `undefined` if the URL made no claim about it (the
 * param was absent or held an unrecognized value).
 */
export function parseInternalTrafficParam(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

/**
 * The browser's `localStorage`, or `null` where there is none or merely
 * reading it throws: a "block site data" setting makes the `localStorage`
 * getter itself throw a `SecurityError` (#75). Resolved here rather than as a
 * bare `= localStorage` default parameter, because a default is evaluated
 * before the function's own `try` — which is how blocked site data used to
 * throw out of `syncInternalTraffic` and leave the app on its loading screen.
 */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads the persisted flag. Fails closed (not internal) if storage throws. */
export function isInternalTraffic(storage: Storage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(INTERNAL_TRAFFIC_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function setInternalTraffic(value: boolean, storage: Storage | null): void {
  try {
    if (value) {
      storage?.setItem(INTERNAL_TRAFFIC_STORAGE_KEY, "true");
    } else {
      storage?.removeItem(INTERNAL_TRAFFIC_STORAGE_KEY);
    }
  } catch {
    // Storage can throw (private browsing, quota, disabled). Marking traffic
    // is a measurement nicety, never something that should surface an error
    // or block the app from loading.
  }
}

/** The product owner's address. */
const PRODUCT_OWNER_EMAIL = "bpgodfrey@gmail.com";

/** The Gmail accounts used for hands-on testing: `groovetestuser1@gmail.com`, … */
const TEST_ACCOUNT_PATTERN = /^groovetestuser\d*@gmail\.com$/;

/**
 * The QA pool's domain (`QA_ACCOUNT_DOMAIN` in `src/access/qaAccounts.ts`,
 * spelled out here so the bundle does not pull the provisioning code in;
 * `internalTraffic.test.ts` pins the two together).
 */
const QA_ACCOUNT_DOMAIN = "qa.trygroove.app";

/**
 * Whether a signed-in address belongs to the team or to a test account, so its
 * sessions count as internal traffic. Case-insensitive, like email addresses;
 * a missing address (a guest session, or signed out) is not internal.
 */
export function isInternalAccount(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (normalized === PRODUCT_OWNER_EMAIL) return true;
  if (TEST_ACCOUNT_PATTERN.test(normalized)) return true;
  return normalized.endsWith(`@${QA_ACCOUNT_DOMAIN}`);
}

/**
 * Persists the flag for this browser, as signing in with an internal account
 * does. Never clears it: that is `?internal=0`'s job, so a team member who
 * then signs in as a cohort account to see their experience stays marked.
 */
export function markInternalTraffic(storage: Storage | null = defaultStorage()): void {
  setInternalTraffic(true, storage);
}

/**
 * Call once per app load. Reads `?internal=` off the given location, updates
 * persisted storage if the URL made a claim, and returns the resulting flag
 * state either way.
 */
export function syncInternalTraffic(
  location: Pick<Location, "search"> = window.location,
  storage: Storage | null = defaultStorage(),
): boolean {
  const params = new URLSearchParams(location.search);
  const claim = parseInternalTrafficParam(params.get("internal"));
  if (claim !== undefined) {
    setInternalTraffic(claim, storage);
    return claim;
  }
  return isInternalTraffic(storage);
}
