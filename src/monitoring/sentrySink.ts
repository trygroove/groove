// The Sentry transport (ADR 0001, PRD `OPS-03`).
//
// **This is the only module in the codebase that imports `@sentry/*`.** It is
// deliberately absent from `src/monitoring/index.ts`, the same way
// `firestoreProjectRepository.ts` is absent from the persistence barrel, so
// application code cannot reach the SDK even by accident. Everything upstream
// talks to `ErrorSink` in `errorReporting.ts`.
//
// ## Configuration decisions, all from ADR 0001
//
// - `sendDefaultPii: false`.
// - `defaultIntegrations: false` with an explicit minimal set. This also
//   disables Sentry's own `globalHandlers` integration, which matters for
//   correctness and not just for bundle size: our boundary owns the global
//   `error`/`unhandledrejection` handlers, and leaving Sentry's enabled would
//   report every uncaught error twice and bypass our scrubbing and our
//   fatal/non-fatal classification.
// - Console breadcrumbs are *disabled*, not filtered.
// - Network and DOM breadcrumbs are scrubbed in `beforeBreadcrumb`, and the
//   whole event again in `beforeSend`.
// - `browserSessionIntegration` provides Release Health, which is where the
//   PRD section 11 crash-free session rate comes from rather than a hand-built
//   derivation.
//
// ## No Session Replay (ADR 0011 decision 2, GRV-120)
//
// Replay moved to PostHog (`src/analytics/posthogTransport.ts`), under every
// condition ADRs 0002 and 0003 set, so only one vendor ever records. No replay
// integration is constructed here and both replay sample rates are 0; a test
// pins that, so replay cannot quietly come back to a second vendor.
//
// ## The DSN is public by design
//
// `VITE_SENTRY_DSN` ships in the client bundle. That is how a browser SDK
// works: the DSN identifies a project's ingest endpoint and grants nothing but
// the ability to submit events to it. The credential that must never ship is
// `SENTRY_AUTH_TOKEN`, which uploads source maps and creates releases; it
// lives in CI only. See `.env.example` and `docs/testing.md`.

import type { ErrorReport, ErrorSink } from "./errorReporting";
import {
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
  scrubBreadcrumb,
  scrubSentryEvent,
} from "./scrub";

type SentryModule = typeof import("@sentry/browser");

export interface SentrySinkOptions {
  dsn?: string;
  release?: string;
  environment?: string;
  /** Injectable for tests, so no test ever loads or initializes the real SDK. */
  load?: () => Promise<SentryModule>;
}

/** Reports buffered while the SDK is still loading. */
const MAX_BUFFERED_REPORTS = 20;

/**
 * A sink that loads and initializes the Sentry SDK on first use.
 *
 * Construction is synchronous and cheap; `start()` performs the dynamic
 * import. Reports arriving before the SDK is ready are buffered (bounded) and
 * flushed on arrival, so a crash during startup — the most valuable kind — is
 * not lost to the lazy-loading requirement.
 */
export class SentrySink implements ErrorSink {
  private sentry: SentryModule | null = null;
  private starting: Promise<boolean> | null = null;
  private stopped = false;
  private readonly buffered: ErrorReport[] = [];

  constructor(private readonly options: SentrySinkOptions = {}) {}

  get isReady(): boolean {
    return this.sentry !== null;
  }

  /**
   * Loads and initializes the SDK. Idempotent; resolves `false` when there is
   * no DSN configured or the SDK could not be loaded — an ad blocker, an
   * offline first load, a chunk that 404s after a rollback. None of those may
   * surface to the user (PRD `OPS-03`).
   */
  start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.starting = this.startInner().catch(() => false);
    return this.starting;
  }

  private async startInner(): Promise<boolean> {
    const dsn = this.options.dsn ?? readEnv("VITE_SENTRY_DSN");
    if (!dsn) return false;

    const load = this.options.load ?? (() => import("@sentry/browser"));
    const sentry = await load();

    sentry.init({
      dsn,
      release: this.options.release,
      environment: this.options.environment ?? "alpha",

      // --- Privacy (ADR 0001) -------------------------------------------
      sendDefaultPii: false,
      // Replay is PostHog's (ADR 0011 decision 2). Both rates stay 0 as well as
      // no integration being constructed, so neither alone is load-bearing.
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      // No performance tracing. ADR 0001 leaves that to a separate decision.
      tracesSampleRate: 0,

      // --- Minimal integration set --------------------------------------
      defaultIntegrations: false,
      integrations: [
        // Release Health: the source of the section 11 crash-free session rate.
        sentry.browserSessionIntegration(),
        // A second, independent collapse of identical events.
        sentry.dedupeIntegration(),
        sentry.breadcrumbsIntegration({
          // Disabled, not filtered: console arguments routinely contain
          // project state in a music application.
          console: false,
          dom: true,
          fetch: true,
          xhr: true,
          history: true,
          sentry: false,
        }),
      ],

      // --- Scrubbing ------------------------------------------------------
      // The double casts bridge the SDK's nominal event types and this
      // module's SDK-free structural ones. `scrubSentryEvent` only ever
      // removes fields or replaces strings with shorter strings, so the
      // shape it returns is still a valid event.
      beforeSend: (event) =>
        scrubSentryEvent(event as unknown as ScrubbableEvent) as unknown as typeof event,
      beforeBreadcrumb: (breadcrumb) =>
        scrubBreadcrumb(breadcrumb as ScrubbableBreadcrumb) as typeof breadcrumb | null,
    });

    this.sentry = sentry;
    this.flushBuffer();
    return true;
  }

  capture(report: ErrorReport): void {
    if (this.stopped) return;
    if (!this.sentry) {
      if (this.buffered.length < MAX_BUFFERED_REPORTS) {
        this.buffered.push(report);
      }
      return;
    }
    this.send(this.sentry, report);
  }

  private flushBuffer(): void {
    const sentry = this.sentry;
    if (!sentry) return;
    const pending = this.buffered.splice(0, this.buffered.length);
    for (const report of pending) {
      this.send(sentry, report);
    }
  }

  private send(sentry: SentryModule, report: ErrorReport): void {
    sentry.captureException(report.error, {
      // `handled: false` is what marks the session crashed in Release
      // Health, so the crash-free session rate reflects fatal errors only.
      mechanism: { type: "solid_groove_boundary", handled: !report.fatal },
      captureContext: {
        level: report.fatal ? "fatal" : "error",
        tags: {
          area: report.area,
          error_code: report.code,
          fatal: report.fatal,
          browser_name: report.browser.browserName,
          browser_version: report.browser.browserVersion,
          engine_name: report.browser.engineName,
          engine_version: report.browser.engineVersion,
        },
      },
    });
  }

  /**
   * Stops sending. Used when the user withdraws consent mid-session: our
   * boundary already stops forwarding, but `browserSessionIntegration` emits
   * session updates on its own, so the client itself has to be closed.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.buffered.length = 0;
    try {
      await this.sentry?.getClient()?.close();
    } catch {
      // Closing is best-effort; a failure here must not surface anywhere.
    }
    this.sentry = null;
  }
}

function readEnv(key: string): string | undefined {
  try {
    const value = (import.meta.env as Record<string, unknown>)[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
