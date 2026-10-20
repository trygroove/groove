// Records error reports the way Sentry would receive them (GRV-55).
//
// A failure's test asserts the *scrubbed payload*: what leaves the browser
// after `beforeSend`, not only what the call site passed in. So this builds
// the event the Sentry SDK would build from a report (its exception, the tags
// `sentrySink.ts` sends) and runs it through `scrubSentryEvent`, the same
// function the live sink uses. Tests only; production code never imports it.

import { expect } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import {
  createRecordingTransport,
  type RecordingTransport,
} from "../analytics/transport";
import { UNKNOWN_BROWSER } from "../monitoring/browserInfo";
import {
  type ErrorReport,
  ErrorReporter,
  type ReportOptions,
  reportTags,
} from "../monitoring/errorReporting";
import { type ScrubbableEvent, scrubSentryEvent } from "../monitoring/scrub";
import { memoryStorage } from "./storage";

export interface RecordedErrorReports {
  readonly reports: ErrorReport[];
  readonly reporter: ErrorReporter;
  /** The analytics transport the reporter's `exception` events go to. */
  readonly transport: RecordingTransport;
  /** A drop-in for `reportError`, reporting into this recorder. */
  report(error: unknown, options: ReportOptions): boolean;
  /** Every report as Sentry would receive it, scrubbed. */
  payloads(): ScrubbableEvent[];
}

/** The event the Sentry SDK builds from `captureException(report.error, ...)`. */
export function sentryEventFor(report: ErrorReport): ScrubbableEvent {
  const error = report.error;
  return {
    level: report.fatal ? "fatal" : "error",
    exception: {
      values: [
        {
          type: error instanceof Error ? error.name : "Error",
          value: error instanceof Error ? error.message : String(error),
          mechanism: { type: "solid_groove_boundary", handled: !report.fatal },
        },
      ],
    },
    tags: reportTags(report),
    contexts: { browser: { name: report.browser.browserName } },
  };
}

export interface RecordErrorReportsOptions {
  /**
   * The reporter's clock. Identical errors within five seconds collapse into
   * one report, so a test that fails the same way twice advances this.
   */
  readonly now?: () => number;
}

export function recordErrorReports(
  options: RecordErrorReportsOptions = {},
): RecordedErrorReports {
  const reports: ErrorReport[] = [];
  const consent = new ConsentStore(memoryStorage());
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent,
    releaseSha: "test-release",
    surface: "editor",
    storage: memoryStorage(),
  });
  const reporter = new ErrorReporter({
    analytics,
    consent,
    sinks: [{ capture: (report) => void reports.push(report) }],
    releaseSha: "test-release",
    browser: { ...UNKNOWN_BROWSER, browserName: "chrome", browserVersion: "140" },
    now: options.now,
  });
  return {
    reports,
    reporter,
    transport,
    report: (error, options) => reporter.report(error, options),
    payloads: () => reports.map((report) => scrubSentryEvent(sentryEventFor(report))),
  };
}

/**
 * Asserts a scrubbed payload names none of `content`: the project, track,
 * clip, section and asset names, user text, URLs and tokens a test put into
 * the failing operation. Case-insensitive, over the whole serialized event.
 */
export function expectNoContent(
  payload: ScrubbableEvent,
  content: readonly string[],
): void {
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const value of content) {
    expect(serialized, `payload carries "${value}"`).not.toContain(value.toLowerCase());
  }
}
