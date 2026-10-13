// Telemetry consent (PRD `OPS-02` / section 10 Security and privacy).
//
// "The user is told what is collected and can decline product analytics
// without losing any DAW or assistant capability." This module owns the
// *mechanism*: a persisted, observable preference that the analytics boundary
// and the error-reporting boundary both consult before they send anything.
//
// It deliberately owns neither the default nor the wording. `DEC-009` decides
// whether collection is on by default with an opt-out or requires opt-in, what
// the disclosure says, how long data is retained, and any regional constraint.
// Both are isolated to `CONSENT_DEFAULT` and `src/components/TelemetryDisclosure.tsx`
// so settling `DEC-009` is a one-line change here plus copy, not a redesign.
//
// Three collections, three flags: PostHog for product events (ADR 0011), error
// monitoring (Sentry, ADR 0001, and PostHog beside it while it is evaluated),
// and PostHog Session Replay for understanding how the app is used (ADR 0002,
// moved to PostHog by ADR 0011 decision 2). Replay rides the analytics client,
// so it needs analytics allowed as well as its own flag. They are separate because `DEC-009` may
// decide differently about a reliability signal that keeps a release gate
// honest, about product analytics, and about a sampled recording of an
// interaction — which is more sensitive per record than a counter. The alpha's
// disclosure surface presents them as one choice; the model does not force that.

export interface ConsentState {
  /** PRD `OPS-02` product-analytics events. */
  readonly productAnalytics: boolean;
  /** PRD `OPS-03` error and crash reports (Sentry and PostHog, ADR 0011 decision 3). */
  readonly errorMonitoring: boolean;
  /**
   * PostHog Session Replay (ADR 0002 decision 4, ADR 0011 decision 2).
   *
   * Declining is honoured *at the source*: the recorder is never loaded and
   * recording never started, so nothing is captured in the first place rather
   * than being captured and dropped before send. Withdrawing mid-session stops
   * the in-flight recording.
   */
  readonly sessionReplay: boolean;
}

export const CONSENT_STORAGE_KEY = "sg_telemetry_consent";

/**
 * The state before the user has expressed a preference.
 *
 * **Provisional, pending `DEC-009`.** Set to collect-with-opt-out, matching
 * the PRD `OPS-02` phrasing that the user "can decline" — which describes an
 * opt-out, not an opt-in. If `DEC-009` decides opt-in, flip them to `false`;
 * every consumer already treats "no stored preference" as this value and
 * nothing else needs to change. `sessionReplay` follows the same rule and is
 * `DEC-009`'s to settle too (ADR 0002 decision 5), alongside replay retention
 * and region — it is a one-line change here, exactly as the others are.
 */
export const CONSENT_DEFAULT: ConsentState = {
  productAnalytics: true,
  errorMonitoring: true,
  sessionReplay: true,
};

/** Every flag, so nothing below has to restate the shape of `ConsentState`. */
export const CONSENT_FLAGS = Object.keys(
  CONSENT_DEFAULT,
) as readonly (keyof ConsentState)[];

export const CONSENT_ALL_OFF: ConsentState = {
  productAnalytics: false,
  errorMonitoring: false,
  sessionReplay: false,
};

type Listener = (state: ConsentState) => void;

function parse(raw: string | null): ConsentState {
  if (raw === null) return CONSENT_DEFAULT;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return CONSENT_DEFAULT;
    const record = parsed as Record<string, unknown>;
    // Driven by `CONSENT_FLAGS` rather than field by field: a flag added later
    // is read back and defaulted without anyone having to remember this
    // function exists. A stored value that is not a boolean — hand-edited,
    // written by an older build, or hostile — falls back to the default for
    // that flag alone rather than discarding the whole preference.
    const state = { ...CONSENT_DEFAULT } as Record<keyof ConsentState, boolean>;
    for (const flag of CONSENT_FLAGS) {
      if (typeof record[flag] === "boolean") state[flag] = record[flag];
    }
    return state;
  } catch {
    // Corrupt or hand-edited storage falls back to the default rather than
    // throwing on app start.
    return CONSENT_DEFAULT;
  }
}

/**
 * A consent store over one `Storage`.
 *
 * Injectable rather than reaching for `localStorage` directly so tests — and
 * any future per-account server-side preference — can supply their own.
 */
export class ConsentStore {
  private readonly listeners = new Set<Listener>();
  private state: ConsentState;
  private expressed: boolean;

  constructor(private readonly storage: Storage | null) {
    this.state = this.read();
    this.expressed = this.readExpressed();
  }

  /**
   * Whether the user has made a choice, rather than running on
   * `CONSENT_DEFAULT`. Analytics persists its identity in cookies only once
   * they have (GRV-106); until then the vendor keeps it in memory, so a visitor
   * who never touched the control leaves no analytics cookie behind.
   */
  get preferenceExpressed(): boolean {
    return this.expressed;
  }

  get current(): ConsentState {
    return this.state;
  }

  /** Whether product-analytics events may be sent. */
  get analyticsAllowed(): boolean {
    return this.state.productAnalytics;
  }

  /** Whether error reports may be sent to the monitoring processor. */
  get errorMonitoringAllowed(): boolean {
    return this.state.errorMonitoring;
  }

  /**
   * Whether Session Replay may capture (ADR 0002 decision 4).
   *
   * Consulted before a recording starts, not before it is sent — declining
   * means nothing is recorded at all.
   */
  get sessionReplayAllowed(): boolean {
    return this.state.sessionReplay;
  }

  set(patch: Partial<ConsentState>): ConsentState {
    const next: ConsentState = { ...this.state, ...patch };
    if (CONSENT_FLAGS.every((flag) => next[flag] === this.state[flag])) {
      return this.state;
    }
    this.state = next;
    this.expressed = true;
    this.persist(next);
    for (const listener of [...this.listeners]) {
      this.deliver(listener, next);
    }
    return next;
  }

  /**
   * A consumer that throws must not prevent the other consumers from being
   * told to stop collecting, and must not break the caller — `subscribe` runs
   * during app startup (`initTelemetry`), where an escaping exception would
   * take the whole app down over a telemetry preference.
   */
  private deliver(listener: Listener, state: ConsentState): void {
    try {
      listener(state);
    } catch {
      // Intentionally silent, for the reasons above.
    }
  }

  /**
   * Turns every collection off in one action — the user-facing opt-out.
   *
   * One action covers all three flags including replay (ADR 0002 decision 4):
   * the model keeps them separable for `DEC-009`, but the control the user
   * actually has is a single switch.
   */
  optOut(): ConsentState {
    return this.set(CONSENT_ALL_OFF);
  }

  optIn(): ConsentState {
    return this.set({
      productAnalytics: true,
      errorMonitoring: true,
      sessionReplay: true,
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.deliver(listener, this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private read(): ConsentState {
    if (!this.storage) return CONSENT_DEFAULT;
    try {
      return parse(this.storage.getItem(CONSENT_STORAGE_KEY));
    } catch {
      // Private browsing / disabled storage. Consent is a preference, never a
      // reason for the app to fail to start.
      return CONSENT_DEFAULT;
    }
  }

  private readExpressed(): boolean {
    if (!this.storage) return false;
    try {
      return this.storage.getItem(CONSENT_STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  private persist(state: ConsentState): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The preference still applies for this session; it just will not
      // survive a reload. Better than surfacing a storage error to the user.
    }
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The app-wide consent store. Tests construct their own `ConsentStore`. */
export const consentStore = new ConsentStore(defaultStorage());
