// The application's error-reporting boundary (PRD `OPS-03`, ADR 0001
// decision 1).
//
// This is the single place an error becomes a report. Global `error` and
// `unhandledrejection` handlers, Solid error boundaries, and any code with a
// caught failure worth knowing about all call `reportError` here. Sentry sits
// *behind* this boundary as a transport (`ErrorSink`), never in front of it:
//
// - Application code never imports `@sentry/*`. Only `sentrySink.ts` does, and
//   it is not re-exported from this directory's barrel — the same convention
//   `src/persistence` uses for `firestoreProjectRepository.ts`.
// - Replacing the platform means replacing one `ErrorSink` implementation.
//   ADR 0001: "Exit cost is bounded precisely because of decision 1."
//
// ## The guarantees this class owns
//
// - **Report once.** One error reaching both a Solid boundary and the global
//   handler produces one report, collapsed by fingerprint.
// - **Fatal vs non-fatal.** Carried explicitly, so Sentry release health can
//   compute crash-free session rate (PRD section 11) rather than us deriving it.
// - **No recursion.** A sink that throws cannot cause another report.
// - **Non-blocking.** PRD `OPS-03`: a "failing, blocked, or ad-blocker-
//   suppressed reporter cannot stop the transport, block editing, lose unsaved
//   state, or recurse into another report."

import type { Analytics } from "../analytics/analytics";
import { analytics as defaultAnalytics } from "../analytics/analytics";
import { type ConsentStore, consentStore } from "../analytics/consent";
import { type ErrorArea, type ErrorCode, toErrorCode } from "../analytics/errorCodes";
import { RELEASE_SHA } from "../release";
import { type BrowserInfo, currentBrowserInfo, UNKNOWN_BROWSER } from "./browserInfo";
import { redactText } from "./scrub";

/**
 * An error carrying its own stable code, so a `catch` does not have to guess.
 * Prefer this over bare `Error` for failures with a known classification.
 */
export class CodedError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodedError";
  }
}

export interface ReportOptions {
  readonly area: ErrorArea;
  /**
   * Whether the error took a surface down. Fatal reports mark the Sentry
   * session as crashed, which is what the section 11 crash-free session rate
   * is computed from — so a handled, recovered failure must not be fatal.
   */
  readonly fatal: boolean;
  /** Overrides the code derived from the error itself. */
  readonly code?: ErrorCode;
}

/** The finished, scrubbed report handed to every sink. */
export interface ErrorReport {
  readonly area: ErrorArea;
  readonly code: ErrorCode;
  readonly fatal: boolean;
  /** Already redacted — safe to transmit. */
  readonly message: string;
  readonly releaseSha: string;
  readonly browser: BrowserInfo;
  /** The original error, for a sink that can symbolicate its stack. */
  readonly error: unknown;
  readonly fingerprint: string;
}

/** A transport for finished reports. Implemented by `sentrySink.ts`. */
export interface ErrorSink {
  capture(report: ErrorReport): void;
}

export interface ErrorReporterOptions {
  analytics?: Analytics;
  consent?: ConsentStore;
  sinks?: readonly ErrorSink[];
  releaseSha?: string;
  browser?: BrowserInfo;
  /** How long an identical error stays deduplicated. */
  dedupeWindowMs?: number;
  /** Cap on remembered fingerprints, so a loop cannot grow memory forever. */
  dedupeCapacity?: number;
  now?: () => number;
}

const DEFAULT_DEDUPE_WINDOW_MS = 5_000;
const DEFAULT_DEDUPE_CAPACITY = 50;

export class ErrorReporter {
  private readonly analytics: Analytics;
  private readonly consent: ConsentStore;
  private readonly sinks: ErrorSink[];
  private readonly releaseSha: string;
  private readonly browser: BrowserInfo;
  private readonly dedupeWindowMs: number;
  private readonly dedupeCapacity: number;
  private readonly now: () => number;
  /** Fingerprint to last-reported timestamp, in insertion order. */
  private readonly recent = new Map<string, number>();
  private reporting = false;

  constructor(options: ErrorReporterOptions = {}) {
    this.analytics = options.analytics ?? defaultAnalytics;
    this.consent = options.consent ?? consentStore;
    this.sinks = [...(options.sinks ?? [])];
    this.releaseSha = options.releaseSha ?? RELEASE_SHA;
    this.browser = options.browser ?? safeBrowserInfo();
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.dedupeCapacity = options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Adds a transport. Called by `initTelemetry()` once the Sentry SDK has
   * lazily loaded, so reports made before then still reach the analytics counter.
   */
  addSink(sink: ErrorSink): void {
    this.sinks.push(sink);
  }

  removeSink(sink: ErrorSink): void {
    const index = this.sinks.indexOf(sink);
    if (index >= 0) this.sinks.splice(index, 1);
  }

  /**
   * Reports one error. Returns whether it produced a report — `false` means
   * it was collapsed into a recent identical one, or arrived re-entrantly.
   *
   * Never throws, whatever the error, the sinks, or the analytics transport
   * do. The caller is editing, playback, or persistence code.
   */
  report(error: unknown, options: ReportOptions): boolean {
    // Re-entrancy guard. A sink that throws is caught below, but a sink that
    // *itself* reports an error would otherwise recurse without bound.
    if (this.reporting) return false;
    this.reporting = true;
    try {
      return this.reportInner(error, options);
    } catch {
      // The reporting path itself failed. There is deliberately nowhere to
      // escalate this to: escalating is the recursion this guard prevents.
      return false;
    } finally {
      this.reporting = false;
    }
  }

  private reportInner(error: unknown, options: ReportOptions): boolean {
    const code = options.code ?? codeFor(error);
    const message = redactText(messageOf(error));
    const fingerprint = fingerprintOf(options.area, code, message, topFrame(error));

    if (this.isDuplicate(fingerprint)) return false;
    this.remember(fingerprint);

    const report: ErrorReport = {
      area: options.area,
      code,
      fatal: options.fatal,
      message,
      releaseSha: this.releaseSha,
      browser: this.browser,
      error,
      fingerprint,
    };

    // The analytics counter event. It keeps the section 11 measures computable from
    // one catalog (ADR 0001 decision 3) and carries no message at all — only
    // `fatal`, `area`, and `error_code`.
    this.analytics.log("exception", {
      fatal: report.fatal,
      area: report.area,
      error_code: report.code,
    });

    if (this.consent.errorMonitoringAllowed) {
      for (const sink of this.sinks) {
        try {
          sink.capture(report);
        } catch {
          // One failing transport must not stop the others, and must not
          // stop the caller. ADR 0001: ad blockers block `sentry.io`, so
          // this is the expected path for some sessions, not an anomaly.
        }
      }
    }

    return true;
  }

  private isDuplicate(fingerprint: string): boolean {
    const last = this.recent.get(fingerprint);
    return last !== undefined && this.now() - last < this.dedupeWindowMs;
  }

  private remember(fingerprint: string): void {
    // Re-insert so the map stays ordered by recency for the eviction below.
    this.recent.delete(fingerprint);
    this.recent.set(fingerprint, this.now());
    while (this.recent.size > this.dedupeCapacity) {
      const oldest = this.recent.keys().next();
      if (oldest.done) break;
      this.recent.delete(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Error inspection
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  // Never stringify an arbitrary thrown object: its fields could be project
  // state. The type alone is enough to pair with the stack trace in Sentry.
  return `non-error thrown (${typeof error})`;
}

/**
 * Derives a stable code from an error.
 *
 * Only recognizes classifications the error itself declares. It deliberately
 * does not pattern-match on message text: message wording changes between
 * browser versions, and a code that silently changes meaning is worse than
 * `"unknown"` paired with a symbolicated stack trace.
 */
export function codeFor(error: unknown): ErrorCode {
  if (error instanceof CodedError) return error.code;
  if (error instanceof Error) {
    // DOMException names are a stable, specified vocabulary.
    switch (error.name) {
      case "NotAllowedError":
        return "autoplay_blocked";
      case "NotSupportedError":
        return "not_supported";
      case "EncodingError":
        return "decode_failed";
      case "InvalidStateError":
        return "context_closed";
      case "QuotaExceededError":
        return "quota_exceeded";
      case "AbortError":
        return "aborted";
      case "TimeoutError":
        return "timeout";
      case "SecurityError":
        return "permission_denied";
      case "NetworkError":
        return "network";
      default:
        break;
    }
    const declared = (error as { code?: unknown }).code;
    if (typeof declared === "string") return toErrorCode(declared);
  }
  return "unknown";
}

/**
 * The first stack frame, used only as fingerprint input.
 *
 * Never transmitted from here — it is hashed into the fingerprint, and the
 * real stack reaches Sentry through the error object itself, where it is
 * scrubbed by `scrubSentryEvent`.
 */
function topFrame(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== "string") return "";
  const lines = error.stack.split("\n");
  // Line 0 is usually "Name: message", which the message already covers.
  return (lines[1] ?? lines[0] ?? "").trim().slice(0, 200);
}

function fingerprintOf(
  area: string,
  code: string,
  message: string,
  frame: string,
): string {
  return `${area}|${code}|${message}|${frame}`;
}

function safeBrowserInfo(): BrowserInfo {
  try {
    return currentBrowserInfo();
  } catch {
    return UNKNOWN_BROWSER;
  }
}

/** The app-wide reporting boundary. */
export const errorReporter = new ErrorReporter();

/**
 * Reports an error through the app-wide boundary.
 *
 * The function application code calls. Never throws.
 */
export function reportError(error: unknown, options: ReportOptions): boolean {
  return errorReporter.report(error, options);
}
