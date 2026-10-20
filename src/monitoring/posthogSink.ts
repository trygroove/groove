// The PostHog error sink (ADR 0011 decision 3, GRV-120).
//
// PostHog error tracking runs beside Sentry for a four-week evaluation, behind
// the same boundary: `errorReporting.ts` hands every finished report to both
// sinks, and a failing sink never stops the other. Sentry stays the system of
// record, with alerts and triage.
//
// This sink does not import `posthog-js`. It uses the analytics client the
// PostHog transport already loaded (`src/analytics/posthogTransport.ts`, the
// one module that imports the SDK), through the one method it needs. So it
// costs no bundle, and it follows the analytics consent as well as the
// error-monitoring one: a session that declined analytics has no client, and
// one that withdrew it has an opted-out client that sends nothing.
//
// ## Scrubbing
//
// A report reaches this sink only after `errorReporting.ts` has redacted its
// message. PostHog builds its event from the error object, as Sentry does, so
// the transport's `before_send` runs `scrubPostHogEvent` (`scrub.ts`) over the
// result: the message redacted again, frames reduced to our bundle's
// location, nothing else kept. A thrown value that is not an `Error` is never
// handed over at all; the sink sends a plain `Error` carrying the redacted
// message instead, so no arbitrary object's fields are serialized.
//
// PostHog's own exception autocapture stays off (`capture_exceptions: false`):
// our global handlers already catch everything, and autocapture would skip the
// boundary and its scrubbing.

import type { ErrorReport, ErrorSink } from "./errorReporting";

/** The slice of the PostHog client this sink calls. */
export interface PostHogExceptionClient {
  captureException(error: unknown, properties?: Record<string, unknown>): unknown;
}

/** Reports buffered while the analytics client is still loading. */
const MAX_BUFFERED_REPORTS = 20;

/**
 * The properties a PostHog exception carries beyond the exception itself:
 * the same tags `sentrySink.ts` sends, and the level PostHog groups fatal
 * errors by. All of them are classifications, never content.
 */
export function postHogExceptionProperties(report: ErrorReport): Record<string, unknown> {
  return {
    ...report.context,
    $exception_level: report.fatal ? "fatal" : "error",
    area: report.area,
    error_code: report.code,
    fatal: report.fatal,
    // The same name every catalog event carries it under, so errors and
    // events compare per release (ADR 0011 decision 3, criterion 1).
    release_sha: report.releaseSha,
    browser_name: report.browser.browserName,
    browser_version: report.browser.browserVersion,
    engine_name: report.browser.engineName,
    engine_version: report.browser.engineVersion,
  };
}

export class PostHogErrorSink implements ErrorSink {
  private client: PostHogExceptionClient | null = null;
  private unavailable = false;
  private stopped = false;
  private readonly buffered: ErrorReport[] = [];

  /**
   * @param client resolves to the loaded analytics client, or `null` where it
   * cannot run. Reports arriving first are buffered (bounded), so a crash
   * during startup is not lost to lazy loading.
   */
  constructor(client: Promise<PostHogExceptionClient | null>) {
    client.then(
      (resolved) => {
        if (!resolved) {
          this.discard();
          return;
        }
        this.client = resolved;
        for (const report of this.buffered.splice(0, this.buffered.length)) {
          this.send(resolved, report);
        }
      },
      () => this.discard(),
    );
  }

  capture(report: ErrorReport): void {
    if (this.stopped || this.unavailable) return;
    if (!this.client) {
      if (this.buffered.length < MAX_BUFFERED_REPORTS) this.buffered.push(report);
      return;
    }
    this.send(this.client, report);
  }

  /** Stops sending, as when error-monitoring consent is withdrawn. */
  stop(): void {
    this.stopped = true;
    this.buffered.length = 0;
  }

  private discard(): void {
    this.unavailable = true;
    this.buffered.length = 0;
  }

  private send(client: PostHogExceptionClient, report: ErrorReport): void {
    if (this.stopped) return;
    try {
      client.captureException(errorFor(report), postHogExceptionProperties(report));
    } catch {
      // A failing transport never stops the caller (PRD `OPS-03`).
    }
  }
}

/**
 * The error PostHog builds its event from. An `Error` keeps its own stack,
 * which is what symbolicates; anything else becomes a plain `Error` with the
 * already-redacted message, so an arbitrary thrown object is never serialized.
 */
function errorFor(report: ErrorReport): Error {
  return report.error instanceof Error ? report.error : new Error(report.message);
}
