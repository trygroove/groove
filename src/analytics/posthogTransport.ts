// The PostHog transport (PRD `OPS-02`, ADR 0011 decision 1, GRV-106).
//
// The only module that imports `posthog-js`, and only dynamically: the SDK is
// its own chunk, loaded after first paint and never on the static landing page
// (`src/telemetry.ts` decides when). Like `sentrySink.ts` in monitoring, it is
// deliberately not re-exported from this directory's barrel: the boundary in
// `analytics.ts` is what application code uses, and swapping vendors must not
// mean touching call sites. `src/monitoring/boundaries.test.ts` enforces both.
//
// PostHog is used for product events only. Everything else the SDK can do on
// its own — autocapture, its own pageviews, session recording, exception
// capture, performance, surveys, feature flags, loading extra scripts — is off
// in `postHogInitOptions`, so the only events it sends are the catalog's and
// the `$pageview` the router asks for. Replay, errors and flags are other
// cards' decisions (ADR 0011).

import type { PostHogConfig } from "posthog-js";
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
 * The slice of `posthog-js` this module calls, which is what a test fake
 * implements. The real `PostHog` instance satisfies it structurally.
 */
export interface PostHogClient {
  capture(event: string, properties?: Record<string, unknown>): unknown;
  identify(distinctId: string): void;
  reset(): void;
  setPersonProperties(properties: Record<string, unknown>): void;
  register(properties: Record<string, unknown>): unknown;
  opt_out_capturing(): void;
  opt_in_capturing(options?: { captureEventName?: string | null | false }): void;
  has_opted_out_capturing(): boolean;
  set_config(config: { persistence?: PostHogPersistence }): void;
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
 * The SDK's init options. Everything PostHog would collect by itself is off:
 * the catalog is the only source of events (PRD `OPS-02`), pageviews come from
 * the router, and replay and exceptions are not this card's (ADR 0011).
 */
export function postHogInitOptions(
  host: string,
  persistence: PostHogPersistence,
): Partial<PostHogConfig> {
  return {
    api_host: host,
    persistence,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    disable_session_recording: true,
    capture_exceptions: false,
    capture_performance: false,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    // Nothing is fetched from PostHog's CDN at runtime: the bundled SDK is
    // the whole of it.
    disable_external_dependency_loading: true,
    person_profiles: "identified_only",
  };
}

export interface PostHogLoaderOptions {
  settings: PostHogSettings;
  /** Replaced in tests with a fake; defaults to the real dynamic import. */
  importSdk?: () => Promise<PostHogSdk>;
}

/**
 * Owns the one PostHog client of a page: initialized at most once, and only
 * when `load` is first called, which `src/telemetry.ts` does only for a
 * session whose consent allows analytics.
 */
export interface PostHogLoader {
  /** Initializes the SDK (once) and resolves the client, or `null` on failure. */
  load(persistence: PostHogPersistence): Promise<PostHogClient | null>;
  /**
   * Applies a consent change to a client that is already running. Never loads
   * the SDK: turning collection off for a client that never started has
   * nothing to switch off.
   */
  setCollection(enabled: boolean, persistence: PostHogPersistence): void;
}

async function importPostHog(): Promise<PostHogSdk> {
  const module = await import("posthog-js");
  return module.default as unknown as PostHogSdk;
}

export function createPostHogLoader(options: PostHogLoaderOptions): PostHogLoader {
  let client: Promise<PostHogClient | null> | null = null;
  const importSdk = options.importSdk ?? importPostHog;

  return {
    load(persistence) {
      client ??= importSdk()
        .then((sdk) => {
          const instance =
            sdk.init(
              options.settings.key,
              postHogInitOptions(options.settings.host, persistence),
            ) ?? null;
          // PostHog remembers a runtime opt-out in its own storage. Consent is
          // this app's to decide (`src/analytics/consent.ts`), and a session
          // that reached `load` is one that allows it.
          if (instance?.has_opted_out_capturing()) {
            instance.opt_in_capturing({ captureEventName: false });
          }
          return instance;
        })
        .catch(() => null);
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
  };
}

/** Events buffered while the SDK resolves. */
const MAX_BUFFERED_EVENTS = 20;

type Operation = (client: PostHogClient) => void;

export interface PostHogTransportOptions {
  /** Resolves the initialized client, or `null` where it cannot run. */
  load: () => Promise<PostHogClient | null>;
}

/**
 * Creates the PostHog transport.
 *
 * Returns synchronously and queues until the client resolves, so the app never
 * waits on analytics and an early event is not lost to lazy loading. The queue
 * keeps call order, which is what puts an `identify` ahead of the events it
 * should own. Every failure path (no key, a blocked script, a throwing SDK)
 * degrades to discarding events, never to throwing (PRD `OPS-02` fail-open).
 */
export function createPostHogTransport(
  options: PostHogTransportOptions,
): AnalyticsTransport {
  let client: PostHogClient | null = null;
  let unavailable = false;
  let queuedEvents = 0;
  const queue: Operation[] = [];

  const run = (target: PostHogClient, operation: Operation) => {
    try {
      operation(target);
    } catch {
      // Blocked by an extension, offline, or the SDK threw.
    }
  };

  const discard = () => {
    unavailable = true;
    queue.length = 0;
  };

  let loading: Promise<PostHogClient | null>;
  try {
    loading = options.load();
  } catch (error) {
    loading = Promise.reject(error);
  }
  void loading
    .then((resolved) => {
      if (!resolved) {
        discard();
        return;
      }
      client = resolved;
      for (const operation of queue.splice(0, queue.length)) run(resolved, operation);
    })
    .catch(discard);

  const submit = (operation: Operation, isEvent = false) => {
    if (unavailable) return;
    if (client) {
      run(client, operation);
      return;
    }
    if (isEvent) {
      if (queuedEvents >= MAX_BUFFERED_EVENTS) return;
      queuedEvents += 1;
    }
    queue.push(operation);
  };

  return {
    logEvent(name, params) {
      const properties: Record<string, AnalyticsParamValue> = { ...params };
      submit((target) => target.capture(name, properties), true);
    },
    setUserProperties(properties) {
      const snapshot = { ...properties };
      submit((target) => {
        target.setPersonProperties(snapshot);
        // The person property is for reading; the event property is what the
        // project's internal-traffic filter excludes on, so it rides every
        // later event as a super property.
        const internal = snapshot[USER_PROPERTIES.internal];
        if (internal !== undefined) {
          target.register({ [INTERNAL_EVENT_PROPERTY]: internal });
        }
      });
    },
    identify(userId) {
      submit((target) => target.identify(userId));
    },
    resetIdentity() {
      submit((target) => target.reset());
    },
    pageview() {
      // Read now, not when a queued capture finally runs: a pageview buffered
      // on one route must not be attributed to the route the SDK loaded on.
      const url = currentUrl();
      submit(
        (target) => target.capture("$pageview", url ? { $current_url: url } : {}),
        true,
      );
    },
  };
}

function currentUrl(): string | undefined {
  try {
    return typeof location === "undefined" ? undefined : location.href;
  } catch {
    return undefined;
  }
}
