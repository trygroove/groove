// Public surface of the error-monitoring layer (PRD `OPS-03`, ADR 0001).
//
// `sentrySink.ts` is deliberately absent. It is the only module that imports
// `@sentry/*`, and ADR 0001 decision 1 requires that "application code does
// not call the Sentry SDK directly" — leaving it out of the barrel is what
// makes that a structural fact rather than a review convention.
// `src/telemetry.ts` imports it dynamically as the composition root.

export type { BrowserInfo, BrowserName, EngineName } from "./browserInfo";
export {
  BROWSER_NAMES,
  currentBrowserInfo,
  ENGINE_NAMES,
  parseBrowserInfo,
  UNKNOWN_BROWSER,
} from "./browserInfo";
export type {
  AudioContextStateKey,
  ErrorContext,
  ErrorContextKey,
  ErrorContextTags,
} from "./errorContext";
export {
  AUDIO_CONTEXT_STATES,
  audioContextStateKey,
  browserOnline,
  contextTags,
  ERROR_CONTEXT_KEYS,
} from "./errorContext";
export type {
  ErrorReport,
  ErrorReporterOptions,
  ErrorSink,
  ReportOptions,
} from "./errorReporting";
export {
  CodedError,
  codeFor,
  ErrorReporter,
  errorReporter,
  reportError,
  reportTags,
} from "./errorReporting";
export type { GlobalHandlerOptions } from "./globalHandlers";
export { installGlobalErrorHandlers } from "./globalHandlers";
export type {
  ScrubbableBreadcrumb,
  ScrubbableEvent,
  ScrubbableException,
  ScrubbableFrame,
} from "./scrub";
// `pathOnly` is deliberately absent for the same reason as `sentrySink.ts`: it
// returns a raw pathname, which still carries whatever the user named. Callers
// outside `scrub.ts` want `scrubRoute`.
export {
  ALLOWED_CONTEXTS,
  ALLOWED_ROUTE_SEGMENTS,
  ALLOWED_TAGS,
  MAX_MESSAGE_LENGTH,
  redactText,
  scrubBreadcrumb,
  scrubFramePath,
  scrubRoute,
  scrubSelector,
  scrubSentryEvent,
} from "./scrub";
