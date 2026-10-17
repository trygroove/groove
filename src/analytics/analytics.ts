// The product-analytics logging boundary (PRD `OPS-02`).
//
// Every analytics call in the application goes through this object. It is the
// only thing that talks to an `AnalyticsTransport`, and it is what makes the
// catalog's guarantees true at runtime:
//
// - **Enrichment.** Release SHA and surface are attached to every event;
//   account type and internal-traffic are set as person properties, and the
//   signed-in account is identified by its Firebase UID alone. Callers
//   never pass them, so they cannot be forgotten or set to something else.
// - **Validation.** The payload is re-checked against the catalog and an event
//   that fails is dropped rather than sent partially — a half-populated event
//   silently corrupts the section 11 measures.
// - **Consent.** Nothing is sent while the user has opted out.
// - **Fail-open.** A blocked, failing, or absent transport is swallowed. PRD
//   `OPS-02`: it "never breaks playback, editing, saving, or export, and never
//   surfaces an error to the user."
// - **Once-only events.** `first_edit` and `feature_first_use` fire once per
//   project / per account respectively, across reloads.

import { RELEASE_SHA } from "../release";
import { isInternalTraffic } from "../shared/internalTraffic";
import {
  type AccountType,
  ANALYTICS_EVENTS,
  type AnalyticsEventName,
  type AnalyticsParamValue,
  AUTOMATIC_PARAMS,
  type FeatureKey,
  type LogArgs,
  type Surface,
  USER_PROPERTIES,
  validateEventPayload,
} from "./catalog";
import { type ConsentStore, consentStore } from "./consent";
import { type AnalyticsTransport, noopTransport } from "./transport";

/** Storage key prefix for once-only event bookkeeping. */
export const ONCE_STORAGE_PREFIX = "sg_once:";

export interface AnalyticsOptions {
  transport?: AnalyticsTransport;
  consent?: ConsentStore;
  /** Defaults to the build's stamped SHA (PRD `OPS-01`). */
  releaseSha?: string;
  surface?: Surface;
  /** Where once-only bookkeeping lives. `null` disables persistence. */
  storage?: Storage | null;
  /**
   * Called when an event is dropped. Never receives a rejected *value* — a
   * value rejected by the catalog may be exactly the project content that
   * must not travel. Defaults to a no-op.
   */
  onIssue?: (issues: readonly string[]) => void;
}

export class Analytics {
  private transport: AnalyticsTransport;
  private readonly consent: ConsentStore;
  private readonly releaseSha: string;
  private readonly storage: Storage | null;
  private readonly onIssue: (issues: readonly string[]) => void;
  private surface: Surface;
  private accountType: AccountType = "unknown";
  private internal = false;
  private userPropertiesSent = false;
  /** The signed-in account's Firebase UID, or `null` when signed out. */
  private userId: string | null = null;
  /** The UID the current transport has been identified as. */
  private identifiedAs: string | null = null;
  /**
   * A sign-out the vendor has not been told about yet. Signing out while no
   * transport is identified (opted out, so on `noopTransport`) skips the reset,
   * but the vendor client underneath may still hold the last account; the debt
   * is paid on the next transport that may collect, before anything else.
   */
  private resetOwed = false;
  /** Fallback for once-only events when storage is unavailable. */
  private readonly onceMemory = new Set<string>();

  constructor(options: AnalyticsOptions = {}) {
    this.transport = options.transport ?? noopTransport;
    this.consent = options.consent ?? consentStore;
    this.releaseSha = options.releaseSha ?? RELEASE_SHA;
    this.surface = options.surface ?? "dashboard";
    this.storage = options.storage === undefined ? safeStorage() : options.storage;
    this.onIssue = options.onIssue ?? (() => {});
  }

  /**
   * Swaps in the real vendor transport once it has loaded.
   *
   * Analytics is usable from the first line of application code with the
   * no-op transport, so nothing has to wait for — or defensively null-check —
   * a vendor SDK that loads lazily.
   */
  setTransport(transport: AnalyticsTransport): void {
    const previous = this.transport;
    this.transport = transport;
    if (previous !== transport) {
      this.guard(() => {
        previous.dispose?.();
      });
    }
    // The new transport has no idea who this user is yet.
    this.identifiedAs = null;
    this.userPropertiesSent = false;
    this.flushIdentity();
    this.flushUserProperties();
  }

  /**
   * Records who is signed in: a Firebase UID, or `null` once signed out.
   * `AuthProvider` calls it as auth state settles. The UID is the only
   * identity analytics ever carries; no email or name reaches a transport.
   *
   * Signing out resets the transport's identity, so the next account on this
   * browser is not merged into the last one. A page that loads signed out
   * resets nothing: there is no identity to forget.
   */
  setUserId(userId: string | null): void {
    if (userId === this.userId) return;
    const previous = this.userId;
    this.userId = userId;
    if (this.identifiedAs === null) {
      if (previous !== null) this.resetOwed = true;
    } else {
      this.identifiedAs = null;
      this.guard(() => {
        this.transport.resetIdentity();
      });
      // A reset forgets the person and its properties along with the UID.
      this.userPropertiesSent = false;
    }
    this.flushIdentity();
    this.flushUserProperties();
  }

  /**
   * Sends one page view. The router calls it on every navigation, because the
   * vendor's own pageview capture is off (it would also fire on the landing
   * page and count route changes the app does not consider navigation).
   */
  pageview(): void {
    if (!this.consent.analyticsAllowed) return;
    this.flushIdentity();
    this.flushUserProperties();
    this.guard(() => {
      this.transport.pageview();
    });
  }

  /**
   * Whether product analytics may be collected now: what the assistant's turn
   * tells the gateway, which sends its trace only when it is (GRV-126).
   */
  get productAnalyticsAllowed(): boolean {
    return this.consent.analyticsAllowed;
  }

  /**
   * The vendor's current session, so a server-side event can join it (the
   * assistant's trace, GRV-126), or `null` while analytics is not allowed or
   * the vendor has not loaded.
   */
  sessionId(): string | null {
    if (!this.consent.analyticsAllowed) return null;
    try {
      return this.transport.sessionId?.() ?? null;
    } catch {
      return null;
    }
  }

  /** The surface attached to subsequent events. */
  setSurface(surface: Surface): void {
    this.surface = surface;
  }

  setAccountType(accountType: AccountType): void {
    if (this.accountType === accountType) return;
    this.accountType = accountType;
    this.userPropertiesSent = false;
    this.flushUserProperties();
  }

  /** Re-reads the persisted internal-traffic flag (`src/shared/internalTraffic.ts`). */
  refreshInternalTraffic(storage?: Storage): void {
    this.setInternalTraffic(storage ? isInternalTraffic(storage) : safeIsInternal());
  }

  /**
   * Marks this session as internal (team or test) traffic, or not.
   * `AuthProvider` calls it when an internal account signs in, so the sessions
   * of a browser the flag was not yet persisted in are still marked from the
   * sign-in onwards.
   */
  setInternalTraffic(internal: boolean): void {
    if (internal === this.internal) return;
    this.internal = internal;
    this.userPropertiesSent = false;
    this.flushUserProperties();
  }

  /**
   * Logs one catalogued event.
   *
   * The payload type comes from the catalog, so an unregistered event, an
   * unregistered parameter, or a value outside a parameter's declared set is
   * a compile error at the call site.
   */
  log<N extends AnalyticsEventName>(name: N, ...args: LogArgs<N>): void {
    const payload = (args[0] ?? {}) as Record<string, unknown>;
    if (!this.consent.analyticsAllowed) return;

    const { params, issues } = validateEventPayload(name, payload);
    if (issues.length > 0) {
      this.report(issues);
      return;
    }

    this.flushIdentity();
    this.flushUserProperties();
    this.send(name, {
      ...params,
      [AUTOMATIC_PARAMS.release_sha]: this.releaseSha,
      [AUTOMATIC_PARAMS.surface]: this.surface,
    });
  }

  /**
   * Logs an event at most once for `key`, across reloads.
   *
   * Returns whether it fired. The marker is written *before* the event is
   * sent: a "first use" that is double-counted is a worse failure than one
   * that is lost, because the section 11 first-use measures assume a single
   * observation per account.
   */
  logOnce<N extends AnalyticsEventName>(
    key: string,
    name: N,
    ...args: LogArgs<N>
  ): boolean {
    if (!this.consent.analyticsAllowed) return false;
    if (this.hasFired(key)) return false;
    this.markFired(key);
    this.log(name, ...args);
    return true;
  }

  /** `feature_first_use`, once per account per browser (PRD `OPS-02`). */
  logFeatureFirstUse(feature: FeatureKey): boolean {
    return this.logOnce(`feature:${feature}`, "feature_first_use", { feature });
  }

  /** Whether a once-only key has already fired. */
  hasFired(key: string): boolean {
    if (this.onceMemory.has(key)) return true;
    if (!this.storage) return false;
    try {
      return this.storage.getItem(ONCE_STORAGE_PREFIX + key) !== null;
    } catch {
      return false;
    }
  }

  private markFired(key: string): void {
    // Always recorded in memory, so a session whose storage is unavailable
    // still gets once-per-session rather than once-per-call semantics.
    this.onceMemory.add(key);
    if (!this.storage) return;
    try {
      this.storage.setItem(ONCE_STORAGE_PREFIX + key, "1");
    } catch {
      // Private browsing or a full quota. Handled by `onceMemory` above.
    }
  }

  private flushIdentity(): void {
    if (!this.consent.analyticsAllowed) return;
    if (this.resetOwed) {
      this.resetOwed = false;
      this.guard(() => {
        this.transport.resetIdentity();
      });
      this.userPropertiesSent = false;
    }
    if (this.userId === null || this.identifiedAs === this.userId) return;
    const userId = this.userId;
    this.identifiedAs = userId;
    this.guard(() => {
      this.transport.identify(userId);
    });
  }

  private flushUserProperties(): void {
    if (this.userPropertiesSent || !this.consent.analyticsAllowed) return;
    this.userPropertiesSent = true;
    this.guard(() => {
      this.transport.setUserProperties({
        [USER_PROPERTIES.account_type]: this.accountType,
        [USER_PROPERTIES.internal]: String(this.internal),
      });
    });
  }

  private send(name: string, params: Record<string, AnalyticsParamValue>): void {
    this.guard(() => {
      this.transport.logEvent(name, params);
    });
  }

  /**
   * Runs a transport call so that no failure can escape into the caller.
   *
   * The caller is playback, editing, or saving code. PRD `OPS-02` and
   * `OPS-03` both require that a blocked endpoint — an ad blocker is the
   * common case — is invisible to it.
   */
  private guard(action: () => void): void {
    try {
      action();
    } catch {
      // Intentionally silent: reporting a failed *analytics* send through the
      // error reporter (which itself logs an analytics event) is how a
      // telemetry loop starts.
    }
  }

  private report(issues: readonly string[]): void {
    try {
      this.onIssue(issues);
    } catch {
      // An issue handler must not be able to break the caller either.
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function safeIsInternal(): boolean {
  try {
    return typeof localStorage === "undefined" ? false : isInternalTraffic();
  } catch {
    return false;
  }
}

/**
 * The app-wide analytics boundary.
 *
 * Starts with the no-op transport; `initTelemetry()` swaps in the PostHog
 * transport, which loads its SDK once the browser is idle after first paint,
 * and on the landing page once that has loaded and settled (GRV-123). Tests construct their own `Analytics`
 * with a recording transport rather than reaching for this.
 */
export const analytics = new Analytics();

/** Events declared in the catalog but not yet reachable from any call site. */
export function isDeclaredEvent(name: string): name is AnalyticsEventName {
  return Object.hasOwn(ANALYTICS_EVENTS, name);
}
