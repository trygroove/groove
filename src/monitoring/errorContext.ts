// The triage context an error report may carry (GRV-55, PRD `OPS-03`).
//
// A stable code says *which* failure happened; this says enough about the
// circumstances to act on it: whether the browser was online, what state the
// audio context was in, how large the export was. It is the error-report
// counterpart of the analytics catalog, and it follows the same rule: every
// field is an enumerated value, a bucket label, a boolean or a bounded count,
// so there is no field that *could* carry a project, track, clip, section or
// asset name, user text, an asset URL or a token.
//
// The fields travel as Sentry tags (and PostHog exception properties), so each
// key is in `ALLOWED_TAGS` in `scrub.ts`; `errorContext.test.ts` fails if the
// two drift apart. A value that is not one the field declares is dropped
// rather than sent, so a cast at a call site cannot smuggle text through.

import {
  type BucketLabel,
  type BucketScaleName,
  bucketLabels,
} from "../analytics/buckets";

/**
 * The state the real-time audio context was in when something failed, as the
 * browser names it, plus `uninitialized` (no context yet) and `unavailable`
 * (this browser has no Web Audio).
 */
export const AUDIO_CONTEXT_STATES = [
  "running",
  "suspended",
  "closed",
  "interrupted",
  "uninitialized",
  "unavailable",
] as const;
export type AudioContextStateKey = (typeof AUDIO_CONTEXT_STATES)[number];

/** Narrows whatever a context reports as its state onto {@link AUDIO_CONTEXT_STATES}. */
export function audioContextStateKey(state: string | undefined): AudioContextStateKey {
  return state !== undefined &&
    (AUDIO_CONTEXT_STATES as readonly string[]).includes(state)
    ? (state as AudioContextStateKey)
    : "uninitialized";
}

export const EXPORT_TYPES = ["stereo", "stems"] as const;

export interface ErrorContext {
  /** Whether the browser said it was online when the failure happened. */
  readonly online?: boolean;
  /** How many attempts the failing operation had already cost (0 to 20). */
  readonly retry_count?: number;
  readonly audio_context_state?: AudioContextStateKey;
  readonly export_type?: (typeof EXPORT_TYPES)[number];
  /** The size of the file being made, bucketed. */
  readonly file_size_bucket?: BucketLabel<"file_bytes">;
  readonly duration_bucket?: BucketLabel<"musical_duration">;
  readonly track_count_bucket?: BucketLabel<"track_count">;
  /** How many ZIPs a stems export was split into (1 to 32). */
  readonly zip_count?: number;
  /** Audio nodes still registered after their project closed. */
  readonly leaked_node_bucket?: BucketLabel<"leak_count">;
  /** Buffer and asset subscriptions still registered after their project closed. */
  readonly leaked_subscription_bucket?: BucketLabel<"leak_count">;
  /** Any other audio resource still registered after its project closed. */
  readonly leaked_other_bucket?: BucketLabel<"leak_count">;
}

export type ErrorContextKey = keyof ErrorContext;
export type ErrorContextTags = Readonly<Record<string, string | number | boolean>>;

type Accepts = (value: unknown) => boolean;

const oneOf =
  (values: readonly string[]): Accepts =>
  (value) =>
    typeof value === "string" && values.includes(value);
const bucket = (scale: BucketScaleName): Accepts => oneOf(bucketLabels(scale));
const count =
  (max: number): Accepts =>
  (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const flag: Accepts = (value) => typeof value === "boolean";

/** Every field, with the values it accepts. The keys are the tag names. */
const FIELDS = {
  online: flag,
  retry_count: count(20),
  audio_context_state: oneOf(AUDIO_CONTEXT_STATES),
  export_type: oneOf(EXPORT_TYPES),
  file_size_bucket: bucket("file_bytes"),
  duration_bucket: bucket("musical_duration"),
  track_count_bucket: bucket("track_count"),
  zip_count: count(32),
  leaked_node_bucket: bucket("leak_count"),
  leaked_subscription_bucket: bucket("leak_count"),
  leaked_other_bucket: bucket("leak_count"),
} as const satisfies Record<ErrorContextKey, Accepts>;

/** The tag names a report's context can produce. */
export const ERROR_CONTEXT_KEYS = Object.keys(FIELDS) as readonly ErrorContextKey[];

/**
 * The context as tags: only declared keys, only values each key accepts.
 * Anything else is dropped, never sent and never thrown about, because the
 * caller is a failure path that must not fail again.
 */
export function contextTags(context: ErrorContext | undefined): ErrorContextTags {
  if (!context) return {};
  const tags: Record<string, string | number | boolean> = {};
  for (const key of ERROR_CONTEXT_KEYS) {
    const value: unknown = context[key];
    if (value !== undefined && FIELDS[key](value)) {
      tags[key] = value as string | number | boolean;
    }
  }
  return tags;
}

/** Whether the browser says it is online; `undefined` where it cannot say. */
export function browserOnline(): boolean | undefined {
  return typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
    ? navigator.onLine
    : undefined;
}
