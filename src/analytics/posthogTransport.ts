// The PostHog transport (PRD `OPS-02`, ADR 0011, GRV-106 and GRV-120).
//
// The only module that imports `posthog-js`, and only dynamically: the SDK is
// its own chunk, loaded when the browser is idle after first paint (on the
// landing page, once the page has loaded and settled), and never in the
// prerendered landing shell or the entry chunk (`src/telemetry.ts` decides
// when). Like `sentrySink.ts` in monitoring, it is
// deliberately not re-exported from this directory's barrel: the boundary in
// `analytics.ts` is what application code uses, and swapping vendors must not
// mean touching call sites. `src/monitoring/boundaries.test.ts` enforces both.
//
// What the client collects, all set in `postHogInitOptions`:
//
// - **Product events**: the catalog's, plus the `$pageview` the router asks
//   for and the `$pageleave` the SDK sends with it (time on page, scroll
//   depth, bounce rate). Autocapture, heatmaps, surveys, feature flags and the
//   rest stay off.
// - **Session replay** (ADR 0011 decision 2), for a sampled session whose
//   consent allows it, under every ADR 0002/0003 condition: text, inputs and
//   name-bearing attributes masked, media blocked, canvas captured, no console
//   logs, network timing without headers or bodies, and URLs without their
//   query strings. The rules live in `src/monitoring/replayPrivacy.ts`. The
//   recorder is bundled, not fetched, and loaded only for a sampled session.
// - **Exceptions**, but only those the reporting boundary hands
//   `src/monitoring/posthogSink.ts` (ADR 0011 decision 3). PostHog's own
//   autocapture stays off, and `before_send` scrubs every exception event.
// - **Web vitals and network timing** (`capture_performance`), with the
//   web-vitals code bundled too.
//
// On the landing page (GRV-123) the client is analytics only: catalog events,
// `$pageview` and `$pageleave`. Replay, web vitals and network timing start
// when the session reaches an app surface (`PostHogLoader.startAppCollection`),
// and the PostHog error sink is attached only there, beside Sentry's.
//
// Nothing is fetched from PostHog's CDN at runtime: `disable_external_
// dependency_loading` is on, and the two extensions the SDK would fetch are
// imported from `posthog-js/dist` instead. The one request besides ingestion
// is the project's remote config, which is what tells the recorder the
// project records sessions.

import type { PostHogConfig } from "posthog-js";
import {
  BLOCK_MEDIA_SELECTOR,
  isSessionSampled,
  MASK_ALL_TEXT_SELECTOR,
  MASK_CONTENT,
  maskReplayAttribute,
  maskReplayNetworkRequest,
  maskReplayText,
  REPLAY_SESSION_SAMPLE_RATE,
} from "../monitoring/replayPrivacy";
import { scrubPostHogEvent } from "../monitoring/scrub";
import { type Clock, systemClock } from "../shared/clock";
import { type AnalyticsParamValue, USER_PROPERTIES } from "./catalog";
import type { AnalyticsTransport } from "./transport";

/** PostHog's EU ingestion host, the default unless the project is in the US. */
export const POSTHOG_DEFAULT_HOST = "https://eu.i.posthog.com";

/**
 * The event property that marks internal (team or test) traffic, so the
 * PostHog project's "filter out internal and test users" setting can exclude
 * it. The same name and value as the `internal` person property.
 */
export const INTERNAL_EVENT_PROPERTY = USER_PROPERTIES.internal;

/** Where the SDK keeps its identity: memory before consent, cookies after. */
export type PostHogPersistence = "memory" | "localStorage+cookie";

/**
 * What the client collects: `"landing"` is analytics only (GRV-123), `"app"`
 * adds web vitals and network timing (and lets the loader start replay).
 */
export type PostHogScope = "landing" | "app";

/** Web vitals and network timing, on an app surface only (GRV-120, GRV-123). */
export const POSTHOG_APP_PERFORMANCE = {
  web_vitals: true,
  network_timing: true,
  // Attribution names the elements behind a slow paint or interaction, and
  // needs its own, larger web-vitals build.
  web_vitals_attribution: false,
} as const satisfies PostHogConfig["capture_performance"];

/** The landing page's: neither, whatever the project's remote config says. */
export const POSTHOG_LANDING_PERFORMANCE = {
  web_vitals: false,
  network_timing: false,
} as const satisfies PostHogConfig["capture_performance"];

/**
 * The slice of `posthog-js` this module calls, which is what a test fake
 * implements. The real `PostHog` instance satisfies it structurally.
 */
export interface PostHogClient {
  capture(
    event: string,
    properties?: Record<string, unknown>,
    options?: { timestamp?: Date },
  ): unknown;
  identify(distinctId: string): void;
  reset(): void;
  setPersonProperties(properties: Record<string, unknown>): void;
  register(properties: Record<string, unknown>): unknown;
  /**
   * Read and written only to carry a visit's entry into a session the SDK
   * started after the visitor had moved on (`adoptEntry`). Optional so a test
   * fake may leave them out; the real SDK has both.
   */
  register_once?(properties: Record<string, unknown>): unknown;
  get_property?(name: string): unknown;
  opt_out_capturing(): void;
  opt_in_capturing(options?: { captureEventName?: string | null | false }): void;
  has_opted_out_capturing(): boolean;
  set_config(config: {
    persistence?: PostHogPersistence;
    capture_performance?: PostHogConfig["capture_performance"];
  }): void;
  /** Reports one error (`src/monitoring/posthogSink.ts`). */
  captureException(error: unknown, properties?: Record<string, unknown>): unknown;
  get_session_id(): string;
  onSessionId(callback: (sessionId: string) => void): () => void;
  startSessionRecording(): void;
  stopSessionRecording(): void;
  /**
   * The SDK's web-vitals extension, started again once an app surface turns
   * web vitals on (GRV-123). Absent where the SDK did not build it.
   */
  webVitalsAutocapture?: { startIfEnabled(): void };
}

/** What `import("posthog-js")` hands back: the default instance's `init`. */
export interface PostHogSdk {
  init(key: string, config: Partial<PostHogConfig>): PostHogClient | undefined;
}

export interface PostHogSettings {
  /** The project API key (`phc_…`). Public by design, like a Sentry DSN. */
  readonly key: string;
  readonly host: string;
}

/**
 * Reads `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST`. `null` without a key, which
 * is how the app runs on `noopTransport` in development, in tests and on a
 * preview deploy.
 */
export function postHogSettings(
  env: Record<string, unknown> = readImportMetaEnv(),
): PostHogSettings | null {
  const key = nonEmpty(env.VITE_POSTHOG_KEY);
  if (!key) return null;
  return { key, host: nonEmpty(env.VITE_POSTHOG_HOST) ?? POSTHOG_DEFAULT_HOST };
}

function readImportMetaEnv(): Record<string, unknown> {
  try {
    return import.meta.env as Record<string, unknown>;
  } catch {
    return {};
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The recorder's options (ADR 0002 decision 2, ADR 0003 decision 1, ADR 0011
 * decision 2). Exported so the tests assert against the value the SDK is
 * handed, and so `replayPayload.test.ts` can run PostHog's recorder with it.
 *
 * Set here rather than in the PostHog project: a client-side value wins over
 * the project's for every one of them, so a project setting cannot unmask
 * text, turn on header or body capture, or turn canvas capture off.
 */
export const POSTHOG_SESSION_RECORDING: NonNullable<PostHogConfig["session_recording"]> =
  {
    /** Every text node masked; `maskReplayText` lets only the named unmasks through. */
    maskTextSelector: MASK_ALL_TEXT_SELECTOR,
    maskTextFn: maskReplayText,
    /** The class a component marks its own user-authored text with. */
    maskTextClass: MASK_CONTENT,
    /** Typed text is user content by definition. */
    maskAllInputs: true,
    /** Names reach the DOM as attributes too; URL attributes lose their query. */
    maskAttributeFn: maskReplayAttribute,
    /** Images, video and audio are recorded as empty boxes. */
    blockSelector: BLOCK_MEDIA_SELECTOR,
    /**
     * ADR 0003 decision 1: the arrangement and piano roll are canvases, and a
     * replay without them is a grey box. What they draw is recorded as drawn,
     * which the disclosure says.
     */
    captureCanvas: { recordCanvas: true, canvasFps: 4, canvasQuality: "0.4" },
    /** Network timing records method, status and timing only. */
    recordHeaders: false,
    recordBody: false,
    maskCapturedNetworkRequestFn: (request) => maskReplayNetworkRequest(request),
    /**
     * PostHog's own sampling, at the rate the recorder was loaded for:
     * `isSessionSampled` makes the same decision first, so only a session this
     * would record loads the recorder at all.
     */
    sampleRate: REPLAY_SESSION_SAMPLE_RATE,
  };

/**
 * The SDK's init options. Everything PostHog would collect by itself is off
 * except what GRV-120 turned on (the file banner lists it); the catalog is
 * the only source of product events (PRD `OPS-02`).
 *
 * Session recording starts disabled. The loader starts it for a sampled
 * session whose replay consent allows it, once the recorder is loaded and the
 * session is on an app surface.
 *
 * `scope` is where the SDK starts: on the landing page it starts with web
 * vitals and network timing off (GRV-123), and the loader turns them on when
 * the session reaches an app surface.
 */
export function postHogInitOptions(
  host: string,
  persistence: PostHogPersistence,
  scope: PostHogScope = "app",
): Partial<PostHogConfig> {
  return {
    api_host: host,
    persistence,
    autocapture: false,
    capture_pageview: false,
    // Time on page, scroll depth and bounce rate in Web Analytics. The SDK
    // pairs each `$pageleave` with the router's last `$pageview`.
    capture_pageleave: true,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    disable_session_recording: true,
    session_recording: POSTHOG_SESSION_RECORDING,
    // Console arguments routinely carry project state in a music application.
    enable_recording_console_log: false,
    // Our global handlers catch everything and report through the boundary;
    // autocapture would bypass its scrubbing.
    capture_exceptions: false,
    capture_performance:
      scope === "app"
        ? { ...POSTHOG_APP_PERFORMANCE }
        : { ...POSTHOG_LANDING_PERFORMANCE },
    before_send: scrubPostHogEvent,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    // Feature flags stay off, but the project's remote config is still read:
    // it is what tells the recorder the project records sessions.
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    // Nothing is fetched from PostHog's CDN at runtime: the bundled SDK and
    // the extensions imported beside it are the whole of it.
    disable_external_dependency_loading: true,
    person_profiles: "identified_only",
  };
}

export interface PostHogLoaderOptions {
  settings: PostHogSettings;
  /** Replaced in tests with a fake; defaults to the real dynamic import. */
  importSdk?: () => Promise<PostHogSdk>;
  /**
   * Installs the session recorder for the SDK to find. Defaults to the
   * bundled `posthog-js/dist/posthog-recorder`, its own chunk, which only a
   * sampled session on an app surface loads.
   */
  importRecorder?: () => Promise<unknown>;
  /**
   * Installs the web-vitals callbacks, likewise bundled rather than fetched.
   * Loaded only once the session is on an app surface.
   */
  importWebVitals?: () => Promise<unknown>;
}

/** What `load` needs to decide about replay, read when it decides. */
export interface PostHogLoadOptions {
  /** Whether replay consent allows recording now. */
  sessionReplayAllowed: () => boolean;
}

/**
 * Owns the one PostHog client of a page: initialized at most once, and only
 * when `load` is first called, which `src/telemetry.ts` does only for a
 * session whose consent allows analytics.
 */
export interface PostHogLoader {
  /** Initializes the SDK (once) and resolves the client, or `null` on failure. */
  load(
    persistence: PostHogPersistence,
    options?: PostHogLoadOptions,
  ): Promise<PostHogClient | null>;
  /**
   * The client once `load` has resolved it: what the PostHog error sink
   * sends through. Stays pending for a session that never loads the SDK.
   */
  readonly client: Promise<PostHogClient | null>;
  /**
   * Applies a consent change to a client that is already running. Never loads
   * the SDK: turning collection off for a client that never started has
   * nothing to switch off.
   */
  setCollection(enabled: boolean, persistence: PostHogPersistence): void;
  /**
   * Stops an in-flight recording when replay consent is withdrawn (ADR 0002
   * decision 4), and keeps this page load from starting another. Analytics
   * keeps running.
   */
  stopSessionRecording(): void;
  /**
   * The session has reached an app surface (GRV-123): web vitals, network
   * timing and, for a sampled session whose consent allows it, replay may
   * start. Before `load`, it makes the SDK start with them; after, it turns
   * them on in the running client. Idempotent, and never loads the SDK.
   */
  startAppCollection(): void;
}

async function importPostHog(): Promise<PostHogSdk> {
  const module = await import("posthog-js");
  return module.default as unknown as PostHogSdk;
}

async function importRecorder(): Promise<unknown> {
  return import("posthog-js/dist/posthog-recorder");
}

async function importWebVitals(): Promise<unknown> {
  return import("posthog-js/dist/web-vitals");
}

export function createPostHogLoader(options: PostHogLoaderOptions): PostHogLoader {
  let client: Promise<PostHogClient | null> | null = null;
  let resolveClient: (client: PostHogClient | null) => void = () => {};
  const loaded = new Promise<PostHogClient | null>((resolve) => {
    resolveClient = resolve;
  });
  const importSdk = options.importSdk ?? importPostHog;
  const loadRecorder = options.importRecorder ?? importRecorder;
  const loadWebVitals = options.importWebVitals ?? importWebVitals;
  /** Replay withdrawn this page load: nothing may start a recording again. */
  let replayStopped = false;
  let recorder: Promise<unknown> | null = null;
  let webVitals: Promise<unknown> | null = null;
  /** An app surface has been reached this page load. */
  let appCollection = false;
  /** What `load` was told about replay, kept for an app surface reached later. */
  let replayOptions: PostHogLoadOptions | undefined;
  /** The client app collection has been started on, so it starts once. */
  let appStartedOn: PostHogClient | null = null;

  const importWebVitalsOnce = () => {
    webVitals ??= loadWebVitals().catch(() => undefined);
    return webVitals;
  };

  /**
   * Starts the recording for the current session if it is in the sample and
   * consent allows it. Run at load and again on every new session, since the
   * SDK samples per session and a long page can see several.
   */
  const startReplayIfSampled = (instance: PostHogClient, replay: PostHogLoadOptions) => {
    if (replayStopped || !replay.sessionReplayAllowed()) return;
    if (!isSessionSampled(instance.get_session_id(), REPLAY_SESSION_SAMPLE_RATE)) return;
    recorder ??= loadRecorder();
    recorder.then(
      () => {
        if (replayStopped || !replay.sessionReplayAllowed()) return;
        instance.startSessionRecording();
      },
      () => {
        // A recorder chunk that cannot load leaves the session unrecorded,
        // which is the fail-open outcome (PRD `OPS-02`).
        recorder = null;
      },
    );
  };

  /**
   * Turns on what an app surface collects, once per client. A client that
   * started on the landing page is reconfigured at once, before replay can
   * start: the recorder reads `capture_performance.network_timing` when it
   * starts, so a later reconfiguration would leave the recording without
   * network timing. The web-vitals extension is started again once its code
   * is installed, so it finds that code rather than fetching it; starting it
   * is a no-op once it is running.
   */
  const startAppCollectionOn = (instance: PostHogClient, startedAs: PostHogScope) => {
    if (appStartedOn === instance) return;
    appStartedOn = instance;
    if (startedAs === "landing") {
      try {
        instance.set_config({ capture_performance: { ...POSTHOG_APP_PERFORMANCE } });
      } catch {
        // Performance capture failing to start never costs analytics.
      }
    }
    void importWebVitalsOnce().then(() => {
      try {
        instance.webVitalsAutocapture?.startIfEnabled();
      } catch {
        // Performance capture failing to start never costs analytics.
      }
    });
    const replay = replayOptions;
    if (!replay) return;
    try {
      startReplayIfSampled(instance, replay);
      instance.onSessionId(() => startReplayIfSampled(instance, replay));
    } catch {
      // Replay failing to start never costs the analytics client.
    }
  };

  return {
    client: loaded,
    load(persistence, loadOptions) {
      replayOptions ??= loadOptions;
      // The web-vitals code is only needed on an app surface; on the landing
      // page it is not fetched until the session moves on.
      client ??= Promise.all([
        importSdk(),
        appCollection ? importWebVitalsOnce() : undefined,
      ])
        .then(([sdk]) => {
          const scope: PostHogScope = appCollection ? "app" : "landing";
          const instance =
            sdk.init(
              options.settings.key,
              postHogInitOptions(options.settings.host, persistence, scope),
            ) ?? null;
          // PostHog remembers a runtime opt-out in its own storage. Consent is
          // this app's to decide (`src/analytics/consent.ts`), and a session
          // that reached `load` is one that allows it.
          if (instance?.has_opted_out_capturing()) {
            instance.opt_in_capturing({ captureEventName: false });
          }
          if (instance && appCollection) startAppCollectionOn(instance, scope);
          return instance;
        })
        .catch(() => null);
      void client.then(resolveClient);
      return client;
    },
    setCollection(enabled, persistence) {
      if (!client) return;
      void client.then((instance) => {
        if (!instance) return;
        try {
          if (!enabled) {
            instance.opt_out_capturing();
            return;
          }
          if (instance.has_opted_out_capturing()) {
            instance.opt_in_capturing({ captureEventName: false });
          }
          if (persistence !== "memory") instance.set_config({ persistence });
        } catch {
          // A failing SDK never surfaces (PRD `OPS-02` fail-open).
        }
      });
    },
    stopSessionRecording() {
      replayStopped = true;
      if (!client) return;
      void client.then((instance) => {
        try {
          instance?.stopSessionRecording();
        } catch {
          // A recording we cannot stop must not become an exception on the
          // consent path; opting out of capture is the backstop.
        }
      });
    },
    startAppCollection() {
      appCollection = true;
      if (!client) return;
      // A client initialized before this call started on the landing page;
      // one still initializing reads `appCollection` when it does.
      void client.then((instance) => {
        if (instance) startAppCollectionOn(instance, "landing");
      });
    },
  };
}

/** Events buffered while the SDK resolves. */
const MAX_BUFFERED_EVENTS = 20;

/**
 * One call on the client. `queuedAt` is when the app made it, set only for a
 * call that waited in the queue, so a buffered event keeps its own time rather
 * than the moment the SDK happened to load.
 */
type Operation = (client: PostHogClient, queuedAt: number | null) => void;

export interface PostHogTransportOptions {
  /**
   * Resolves the initialized client, or `null` where it cannot run. The signal
   * aborts when the transport is disposed, so a load still waiting for its
   * gate can stand down instead of starting the SDK for nobody.
   */
  load: (signal: AbortSignal) => Promise<PostHogClient | null>;
  /** Stamps queued events. Defaults to the real clock. */
  clock?: Clock;
}

/**
 * Creates the PostHog transport.
 *
 * Returns synchronously and queues until the client resolves, so the app never
 * waits on analytics and an early event is not lost to lazy loading. The queue
 * keeps call order, which is what puts an `identify` ahead of the events it
 * should own. Every failure path (no key, a blocked script, a throwing SDK)
 * degrades to discarding events, never to throwing (PRD `OPS-02` fail-open).
 *
 * `dispose` (which the boundary calls when it replaces this transport, as on
 * an opt-out) drops the queue and aborts a load that has not run yet, so
 * nothing buffered before a withdrawal is ever sent.
 */
export function createPostHogTransport(
  options: PostHogTransportOptions,
): AnalyticsTransport {
  const clock = options.clock ?? systemClock;
  const aborter = new AbortController();
  let client: PostHogClient | null = null;
  let unavailable = false;
  let queuedEvents = 0;
  const queue: { operation: Operation; queuedAt: number }[] = [];
  /** Where this visit was when the transport was made: its entry, usually. */
  const entry = currentEntry();
  /**
   * Whether the client is identified, in call order. PostHog runs with
   * `person_profiles: "identified_only"`, so person properties wait for an
   * identity: sent for an anonymous visitor, they would create the profile
   * that setting exists to avoid.
   */
  let identified = false;
  let personProperties: Record<string, string> | null = null;

  const run = (target: PostHogClient, operation: Operation, queuedAt: number | null) => {
    try {
      operation(target, queuedAt);
    } catch {
      // Blocked by an extension, offline, or the SDK threw.
    }
  };

  const discard = () => {
    unavailable = true;
    client = null;
    queue.length = 0;
  };

  let loading: Promise<PostHogClient | null>;
  try {
    loading = options.load(aborter.signal);
  } catch (error) {
    loading = Promise.reject(error);
  }
  void loading
    .then((resolved) => {
      if (aborter.signal.aborted) return;
      if (!resolved) {
        discard();
        return;
      }
      client = resolved;
      adoptEntry(resolved, entry);
      for (const { operation, queuedAt } of queue.splice(0, queue.length)) {
        run(resolved, operation, queuedAt);
      }
    })
    .catch(discard);

  const submit = (operation: Operation, isEvent = false) => {
    if (unavailable) return;
    if (client) {
      run(client, operation, null);
      return;
    }
    if (isEvent) {
      if (queuedEvents >= MAX_BUFFERED_EVENTS) return;
      queuedEvents += 1;
    }
    queue.push({ operation, queuedAt: clock.now() });
  };

  const capture = (event: string, properties: Record<string, unknown>) =>
    submit((target, queuedAt) => {
      if (queuedAt === null) target.capture(event, properties);
      else target.capture(event, properties, { timestamp: new Date(queuedAt) });
    }, true);

  const sendPersonProperties = () => {
    if (!identified || !personProperties) return;
    const snapshot = personProperties;
    submit((target) => target.setPersonProperties(snapshot));
  };

  return {
    logEvent(name, params) {
      const properties: Record<string, AnalyticsParamValue> = { ...params };
      capture(name, properties);
    },
    setUserProperties(properties) {
      personProperties = { ...personProperties, ...properties };
      // The event property is what the project's internal-traffic filter
      // excludes on, so it rides every later event as a super property,
      // anonymous or not.
      const internal = properties[USER_PROPERTIES.internal];
      if (internal !== undefined) {
        submit((target) => target.register({ [INTERNAL_EVENT_PROPERTY]: internal }));
      }
      sendPersonProperties();
    },
    identify(userId) {
      submit((target) => target.identify(userId));
      identified = true;
      sendPersonProperties();
    },
    resetIdentity() {
      submit((target) => target.reset());
      identified = false;
    },
    pageview() {
      // Read now, not when a queued capture finally runs: a pageview buffered
      // on one route must not be attributed to the route the SDK loaded on.
      capture("$pageview", currentLocation());
    },
    dispose() {
      aborter.abort();
      discard();
    },
  };
}

/**
 * The query parameters PostHog reads as campaign attribution: posthog-js
 * 1.438's `CAMPAIGN_PARAMS` (`@posthog/browser-common` `event-utils`), the
 * UTM tags and the ad platforms' click IDs.
 */
export const CAMPAIGN_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gad_source",
  "mc_cid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "igshid",
  "ttclid",
  "rdt_cid",
  "epik",
  "qclid",
  "sccid",
  "oppref",
  "irclid",
  "_kx",
] as const;

/**
 * The page-view properties PostHog would read itself, taken now: the URL, and
 * the campaign parameters in it (GRV-123). The SDK reads campaign parameters
 * from the document's URL when an event is sent, not from `$current_url`, so
 * a landing view queued on `/?utm_source=…` and sent once the visitor is in
 * the app would otherwise lose its campaign. Explicit event properties win
 * over the SDK's own.
 */
function currentLocation(): Record<string, string> {
  try {
    if (typeof location === "undefined") return {};
    const properties: Record<string, string> = {
      $current_url: location.href,
      $host: location.host,
      $pathname: location.pathname,
    };
    const query = new URLSearchParams(location.search);
    for (const name of CAMPAIGN_PARAMS) {
      const value = query.get(name);
      if (value) properties[name] = value;
    }
    return properties;
  } catch {
    return {};
  }
}

/** A visit's entry, as PostHog keeps it: referrer `r` and URL `u`. */
interface EntryInfo {
  r: string;
  u: string;
}

/** The longest URL or referrer PostHog keeps in its session and person info. */
const ENTRY_INFO_MAX_LENGTH = 1000;

/** The persistence key holding the session's entry (posthog-js `CLIENT_SESSION_PROPS`). */
const SESSION_ENTRY_KEY = "$client_session_props";
/** The persistence key holding the person's first entry (`INITIAL_PERSON_INFO`). */
const INITIAL_ENTRY_KEY = "$initial_person_info";

function currentEntry(): EntryInfo | null {
  try {
    if (typeof location === "undefined") return null;
    const referrer = typeof document === "undefined" ? "" : document.referrer;
    return {
      r: (referrer || "$direct").slice(0, ENTRY_INFO_MAX_LENGTH),
      u: location.href.slice(0, ENTRY_INFO_MAX_LENGTH),
    };
  } catch {
    return null;
  }
}

/**
 * Gives the SDK the visit's real entry when it loaded after the visitor had
 * moved on (GRV-123: a landing visitor who clicks into the app before the
 * landing page's deferred load). PostHog takes a session's entry URL, and a
 * new person's first URL, from wherever the page is when it starts the
 * session, so without this the session would enter on `/projects` and lose
 * the landing page's URL and campaign (`$session_entry_url`,
 * `$session_entry_utm_*`, `$initial_*`).
 *
 * Only a session the SDK has just started at the current URL is rewritten:
 * one carried over from an earlier page load already has its own entry. The
 * referrer is the SDK's own, which a client-side navigation does not change.
 */
function adoptEntry(client: PostHogClient, entry: EntryInfo | null): void {
  try {
    const here = currentEntry();
    if (!entry || !here || entry.u === here.u) return;
    if (!client.get_property || !client.register_once) return;
    const sessionId = client.get_session_id();
    const stored = client.get_property(SESSION_ENTRY_KEY) as
      | { sessionId?: unknown; props?: { r?: unknown; u?: unknown } }
      | undefined;
    if (stored?.sessionId !== sessionId || stored.props?.u !== here.u) return;
    client.register({
      [SESSION_ENTRY_KEY]: { ...stored, props: { ...stored.props, u: entry.u } },
    });
    client.register_once({
      [INITIAL_ENTRY_KEY]: { r: stored.props.r ?? entry.r, u: entry.u },
    });
  } catch {
    // Attribution is best effort; it never costs the events themselves.
  }
}
