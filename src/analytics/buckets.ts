// Bucketed numeric analytics values (PRD `OPS-02`).
//
// "Counts and durations are bucketed rather than exact, so a rare exact
// combination cannot re-identify a session." This module owns every bucket
// scale the catalog uses. A `*_bucket` parameter's allowed values are exactly
// one scale's labels, so `src/analytics/catalog.ts` names a scale rather than
// repeating a list of strings, and a caller cannot invent a label.
//
// Labels are part of the published analytics contract: they end up in Google
// Analytics reports and in saved explorations. Renaming one silently splits a
// metric across two labels for the same behavior, so treat a change here the
// same way as a change to an event name — as a contract change.

/** The real-world unit a scale's input is measured in. */
export type BucketUnit = "days" | "seconds" | "milliseconds" | "items";

export interface BucketBoundary {
  /** The label a value strictly below `below` receives. */
  readonly label: string;
  /** Exclusive upper edge of this bucket, in the scale's unit. */
  readonly below: number;
}

export interface BucketScale {
  readonly unit: BucketUnit;
  /** Ordered by ascending `below`. */
  readonly boundaries: readonly BucketBoundary[];
  /** Label for any value at or above the last boundary. */
  readonly overflow: string;
}

/**
 * Every bucket scale in the analytics contract.
 *
 * Kept deliberately coarse. A bucket exists to make a distribution readable,
 * not to reconstruct an individual session, so the top bucket of every scale
 * is open-ended rather than extending until values become unique.
 */
export const BUCKET_SCALES = {
  /** How old a project was when it was opened or deleted. */
  project_age: {
    unit: "days",
    boundaries: [
      { label: "same_day", below: 1 },
      { label: "1_7d", below: 8 },
      { label: "8_30d", below: 31 },
      { label: "31_90d", below: 91 },
    ],
    overflow: "90d_plus",
  },

  /** Tracks in a project or an export. */
  track_count: {
    unit: "items",
    boundaries: [
      { label: "0", below: 1 },
      { label: "1_2", below: 3 },
      { label: "3_5", below: 6 },
      { label: "6_10", below: 11 },
      { label: "11_20", below: 21 },
      { label: "21_50", below: 51 },
    ],
    overflow: "50_plus",
  },

  /** Notes or automation breakpoints touched by one editing gesture. */
  event_count: {
    unit: "items",
    boundaries: [
      { label: "0", below: 1 },
      { label: "1_4", below: 5 },
      { label: "5_16", below: 17 },
      { label: "17_64", below: 65 },
      { label: "65_256", below: 257 },
    ],
    overflow: "256_plus",
  },

  /** Commands in one assistant proposal. */
  command_count: {
    unit: "items",
    boundaries: [
      { label: "1", below: 2 },
      { label: "2_5", below: 6 },
      { label: "6_20", below: 21 },
      { label: "21_100", below: 101 },
    ],
    overflow: "100_plus",
  },

  /**
   * A short user-scale latency: time from opening a project to the first
   * edit, or from seeing an assistant proposal to deciding about it.
   */
  elapsed_seconds: {
    unit: "seconds",
    boundaries: [
      { label: "0_5s", below: 6 },
      { label: "6_30s", below: 31 },
      { label: "31_120s", below: 121 },
      { label: "2_10m", below: 601 },
    ],
    overflow: "10m_plus",
  },

  /**
   * Musical duration of a project or an export. The 2-minute edge is the
   * PRD section 11 primary-measure threshold, so it is an exact bucket edge
   * rather than something a report has to interpolate.
   */
  musical_duration: {
    unit: "seconds",
    boundaries: [
      { label: "under_30s", below: 30 },
      { label: "30_60s", below: 60 },
      { label: "1_2m", below: 120 },
      { label: "2_5m", below: 300 },
      { label: "5_10m", below: 600 },
    ],
    overflow: "10m_plus",
  },

  /** Wall-clock time a machine-paced operation took, e.g. an export. */
  elapsed_ms: {
    unit: "milliseconds",
    boundaries: [
      { label: "under_500ms", below: 500 },
      { label: "500ms_2s", below: 2_000 },
      { label: "2_10s", below: 10_000 },
      { label: "10_60s", below: 60_000 },
    ],
    overflow: "60s_plus",
  },

  /** Which turn of an assistant conversation something happened on, from 1. */
  turn_index: {
    unit: "items",
    boundaries: [
      { label: "1", below: 2 },
      { label: "2_3", below: 4 },
      { label: "4_10", below: 11 },
    ],
    overflow: "10_plus",
  },

  /** Scheduled audio events dropped or late in one sampled underrun report. */
  dropped_events: {
    unit: "items",
    boundaries: [
      { label: "1_4", below: 5 },
      { label: "5_20", below: 21 },
      { label: "21_100", below: 101 },
    ],
    overflow: "100_plus",
  },
} as const satisfies Record<string, BucketScale>;

export type BucketScaleName = keyof typeof BUCKET_SCALES;

/** The exact set of labels one scale can produce, as a literal union. */
export type BucketLabel<S extends BucketScaleName> =
  | (typeof BUCKET_SCALES)[S]["boundaries"][number]["label"]
  | (typeof BUCKET_SCALES)[S]["overflow"];

/** Every label a scale can produce, lowest bucket first. */
export function bucketLabels<S extends BucketScaleName>(
  scale: S,
): readonly BucketLabel<S>[] {
  const definition = BUCKET_SCALES[scale];
  return [
    ...definition.boundaries.map((boundary) => boundary.label),
    definition.overflow,
  ] as BucketLabel<S>[];
}

/**
 * Places a measured value into its bucket.
 *
 * Total by construction. A negative value (a clock that went backwards, a
 * duration measured across a DST jump) lands in the lowest bucket. `NaN` means
 * "unmeasured" and lands there too, since no comparison against it is true.
 * `Infinity` is a real ordering — it falls through to the overflow bucket like
 * any other very large value. Bucketing is a measurement nicety; it must never
 * throw into a caller's editing or playback path because a clock misbehaved.
 */
export function bucketOf<S extends BucketScaleName>(
  scale: S,
  value: number,
): BucketLabel<S> {
  const definition = BUCKET_SCALES[scale];
  if (Number.isNaN(value)) {
    return definition.boundaries[0].label as BucketLabel<S>;
  }
  for (const boundary of definition.boundaries) {
    if (value < boundary.below) return boundary.label as BucketLabel<S>;
  }
  return definition.overflow as BucketLabel<S>;
}

/** Milliseconds to a `project_age` bucket. */
export function projectAgeBucket(ageMs: number): BucketLabel<"project_age"> {
  return bucketOf("project_age", ageMs / 86_400_000);
}
