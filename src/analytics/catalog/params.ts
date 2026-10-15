// The analytics catalog's parameter kinds and the helpers each feature area
// declares its events with. See `../catalog.ts` for why there is no free-text
// kind, and for the catalog as a whole.

import { type BucketScaleName, bucketLabels } from "../buckets";
import { isPublishedPackSlug } from "../packIdentity";

// ---------------------------------------------------------------------------
// Parameter kinds
// ---------------------------------------------------------------------------

export interface EnumParam<V extends string = string, O extends boolean = boolean> {
  readonly kind: "enum";
  readonly values: readonly V[];
  readonly optional: O;
}

export interface BucketParam<
  S extends BucketScaleName = BucketScaleName,
  O extends boolean = boolean,
> {
  readonly kind: "bucket";
  readonly scale: S;
  readonly optional: O;
}

export interface BooleanParam<O extends boolean = boolean> {
  readonly kind: "boolean";
  readonly optional: O;
}

export interface CountParam<O extends boolean = boolean> {
  readonly kind: "count";
  /** Values above this are clamped, so cardinality stays bounded. */
  readonly max: number;
  readonly optional: O;
}

/**
 * A value set an enum cannot express because it is *published* rather than
 * compiled: a third-party pack's slug enters the library by publication, so no
 * table in this repository can enumerate it ahead of time (LIB-05, LIB-08).
 *
 * The guarantee is therefore a shape and a set of reserved sentinels instead of
 * a fixed list — a kebab-case slug within {@link MAX_PACK_ID_LENGTH}, or one of
 * `reserved`. Anything else is dropped exactly like an out-of-set enum value.
 * This is the *only* parameter kind that admits a value the catalog has not
 * seen, which is why the decision about whether a value may travel at all is
 * made before it gets here, by `packAnalyticsIdentity`.
 */
export interface SlugParam<O extends boolean = boolean> {
  readonly kind: "slug";
  /** Non-slug values that are always allowed (e.g. `"user"`, `"unknown"`). */
  readonly reserved: readonly string[];
  readonly optional: O;
}

export type AnalyticsParam =
  | EnumParam
  | BucketParam
  | BooleanParam
  | CountParam
  | SlugParam;

/** Every parameter kind, for exhaustiveness checks in tests and validation. */
export const PARAM_KINDS = ["enum", "bucket", "boolean", "count", "slug"] as const;

export function enumParam<const V extends string>(
  values: readonly V[],
): EnumParam<V, false> {
  return { kind: "enum", values, optional: false };
}

export function optionalEnumParam<const V extends string>(
  values: readonly V[],
): EnumParam<V, true> {
  return { kind: "enum", values, optional: true };
}

export function bucketParam<S extends BucketScaleName>(scale: S): BucketParam<S, false> {
  return { kind: "bucket", scale, optional: false };
}

export function boolParam(): BooleanParam<false> {
  return { kind: "boolean", optional: false };
}

export function countParam(max: number): CountParam<false> {
  return { kind: "count", max, optional: false };
}

export function optionalCountParam(max: number): CountParam<true> {
  return { kind: "count", max, optional: true };
}

export function slugParam<const R extends string>(
  reserved: readonly R[],
): SlugParam<false> {
  return { kind: "slug", reserved, optional: false };
}

/** Keys owned by a task that has not landed yet — see the banner in `../catalog.ts`. */
export const UNCLAIMED: readonly never[] = [];

export interface AnalyticsEventDefinition {
  /**
   * Delivery milestone, matching the PRD `OPS-02` catalog table's
   * `Alpha Milestone` column. The field keeps its `phase` name because
   * renaming it changes this published catalog contract, which is its own
   * task rather than part of a documentation rename.
   */
  readonly phase: 0 | 1 | 2 | 3;
  /** Backlog task(s) that must ship the event with the feature it measures. */
  readonly owners: readonly string[];
  readonly params: Readonly<Record<string, AnalyticsParam>>;
}

/**
 * Values sent to the transport: strings, numbers, and booleans.
 */
export type AnalyticsParamValue = string | number | boolean;

export function coerceParam(
  spec: AnalyticsParam,
  value: unknown,
): AnalyticsParamValue | undefined {
  switch (spec.kind) {
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? value : undefined;
    case "bucket":
      return typeof value === "string" &&
        (bucketLabels(spec.scale) as readonly string[]).includes(value)
        ? value
        : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "count":
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      return Math.min(Math.max(Math.round(value), 0), spec.max);
    case "slug":
      if (typeof value !== "string") return undefined;
      if (spec.reserved.includes(value)) return value;
      // Shape, not membership — the published set is not knowable here. A
      // value that is not a well-formed slug (a `pak_` ID, a display name, a
      // user-entered string) is dropped exactly like an out-of-set enum value.
      return isPublishedPackSlug(value) ? value : undefined;
  }
}

/**
 * Every allowed value of an `enum` or `bucket` parameter, for tests. A `slug`
 * parameter has no closed set — only its reserved sentinels are declared.
 */
export function declaredValues(spec: AnalyticsParam): readonly string[] {
  switch (spec.kind) {
    case "enum":
      return spec.values;
    case "bucket":
      return bucketLabels(spec.scale);
    case "slug":
      return spec.reserved;
    default:
      return [];
  }
}
