// Public surface of the analytics layer (PRD `OPS-02`).
//
// `posthogTransport.ts` is deliberately absent: it is the only module that
// imports `posthog-js`, and application code must reach analytics through the
// boundary rather than through a vendor SDK.
// `src/monitoring/boundaries.test.ts` enforces both. `src/telemetry.ts`
// imports it directly to wire it up, the same way `src/persistence`'s Firestore
// repository is imported only by its composition root.

export type { AnalyticsOptions } from "./analytics";
export { Analytics, analytics, isDeclaredEvent } from "./analytics";
export type { BucketLabel, BucketScaleName, BucketUnit } from "./buckets";
export {
  BUCKET_SCALES,
  bucketLabels,
  bucketOf,
  projectAgeBucket,
} from "./buckets";
export type {
  AccountType,
  AnalyticsEventName,
  AnalyticsEventPayload,
  AnalyticsParam,
  AnalyticsParamValue,
  CommandId,
  FeatureKey,
  SampleRateKey,
  ShortcutActionId,
  Surface,
} from "./catalog";
export {
  ACCOUNT_TYPES,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENTS,
  COMMAND_IDS,
  declaredValues,
  FEATURE_KEYS,
  PARAM_KINDS,
  SAMPLE_RATE_KEYS,
  SHORTCUT_ACTION_IDS,
  SURFACES,
  sampleRateKey,
  validateEventPayload,
} from "./catalog";
export type { ConsentState } from "./consent";
export {
  CONSENT_ALL_OFF,
  CONSENT_DEFAULT,
  CONSENT_STORAGE_KEY,
  ConsentStore,
  consentStore,
} from "./consent";
export type { ErrorArea, ErrorCode } from "./errorCodes";
export {
  ERROR_AREAS,
  ERROR_CODES,
  isErrorArea,
  isErrorCode,
  toErrorCode,
} from "./errorCodes";
export type {
  IdentifiablePack,
  PackAnalyticsIdentity,
  PackKind,
  PublishedPackId,
} from "./packIdentity";
export {
  isPublishedPackSlug,
  PACK_KINDS,
  packAnalyticsIdentity,
  RESERVED_PACK_IDS,
} from "./packIdentity";
export type { AnalyticsTransport, RecordingTransport } from "./transport";
export {
  createFailingTransport,
  createRecordingTransport,
  noopTransport,
} from "./transport";
