// The typed product-analytics catalog (PRD `OPS-02`).
//
// This module is the *only* place an analytics event name or parameter name
// appears in the codebase. UI, audio, persistence, and assistant code log
// through `src/analytics/analytics.ts`, which accepts nothing this file has not
// declared. Logging an unregistered event, an unregistered parameter, or a
// value outside a parameter's declared set is a type error.
//
// ## Why there is no free-text parameter kind
//
// PRD `OPS-02`: "No project content, ever." Rather than reviewing each new call
// site for leaks, the catalog makes the leak unrepresentable: the four
// parameter kinds below are `enum`, `bucket`, `boolean`, and `count`. There is
// deliberately no `string`/`text` kind, so there is no way to declare a
// parameter that *could* carry a project name, an assistant reply, a search
// term, a URL, or a token — and `catalog.test.ts` asserts that stays true for
// parameters added by later tasks.
//
// ## Events that cannot be logged yet
//
// Several later-milestone parameters are keys owned by a task that has not landed
// (`template_id` by `LOOP-015`, `action_id` by `LOOP-014`, `suggestion_id` and
// `capability` by the `AI-*` tasks). Those are declared here as *empty* enums.
// An empty enum's value type is `never`, so the event is declared, reportable,
// and documented — but physically un-loggable until its owning task adds its
// keys in the same change that adds the call site. That is the "analytics ships
// with the feature" rule (CLAUDE.md's definition of done) enforced by the compiler rather than
// by review.
//
// ## Where an entry goes
//
// The catalog is split by feature area under `./catalog/`: each area file
// declares its own events, value sets, `feature_first_use` keys and
// `shortcut_used` action IDs, and this module combines them into the one
// public catalog. A feature adds its entries to its own area's file, so two
// features in different areas never edit the same list. Only the two events
// whose values span every area, `feature_first_use` and `shortcut_used`, are
// declared here.
//
// ## Changing this file
//
// Event names, parameter names, and parameter values are a published contract:
// they appear in Google Analytics reports and saved explorations, and renaming
// one splits a metric across two values for the same behavior. Adding is
// routine; renaming or removing is a task of its own.

import type { BucketLabel } from "./buckets";
import { APP_EVENTS, APP_FEATURE_KEYS } from "./catalog/app";
import {
  ARRANGEMENT_EVENTS,
  ARRANGEMENT_FEATURE_KEYS,
  ARRANGEMENT_SHORTCUT_ACTION_IDS,
} from "./catalog/arrangement";
import {
  ASSISTANT_EVENTS,
  ASSISTANT_FEATURE_KEYS,
  ASSISTANT_SHORTCUT_ACTION_IDS,
} from "./catalog/assistant";
import {
  AUDIO_EVENTS,
  AUDIO_FEATURE_KEYS,
  AUDIO_SHORTCUT_ACTION_IDS,
} from "./catalog/audio";
import {
  CLIP_EVENTS,
  CLIP_FEATURE_KEYS,
  CLIP_SHORTCUT_ACTION_IDS,
} from "./catalog/clips";
import { EDITING_EVENTS, EDITING_SHORTCUT_ACTION_IDS } from "./catalog/editing";
import {
  EXPORT_EVENTS,
  EXPORT_FEATURE_KEYS,
  EXPORT_SHORTCUT_ACTION_IDS,
} from "./catalog/export";
import {
  LIBRARY_EVENTS,
  LIBRARY_FEATURE_KEYS,
  LIBRARY_SHORTCUT_ACTION_IDS,
} from "./catalog/library";
import {
  NAVIGATION_EVENTS,
  NAVIGATION_FEATURE_KEYS,
  NAVIGATION_SHORTCUT_ACTION_IDS,
} from "./catalog/navigation";
import {
  type AnalyticsEventDefinition,
  type AnalyticsParamValue,
  type BooleanParam,
  type BucketParam,
  type CountParam,
  coerceParam,
  type EnumParam,
  enumParam,
  type SlugParam,
} from "./catalog/params";
import { PROJECT_EVENTS } from "./catalog/project";
import {
  TRACK_EVENTS,
  TRACK_FEATURE_KEYS,
  TRACK_SHORTCUT_ACTION_IDS,
} from "./catalog/tracks";
import type { PublishedPackId } from "./packIdentity";

export {
  ACCOUNT_TYPES,
  type AccountType,
  BROWSER_CAPABILITY_IDS,
  SURFACES,
  type Surface,
} from "./catalog/app";
export {
  ASSISTANT_PROPOSAL_CAPABILITIES,
  ASSISTANT_RECOMMENDATION_REFUSALS,
  ASSISTANT_SUGGESTION_IDS,
} from "./catalog/assistant";
export { SAMPLE_RATE_KEYS, type SampleRateKey, sampleRateKey } from "./catalog/audio";
export {
  NOTE_EDIT_OPERATIONS,
  type NoteEditOperation,
  SCALE_KEYS,
} from "./catalog/clips";
export { LIBRARY_PACK_SLUGS, type LibraryPackSlug } from "./catalog/library";
export {
  EDITOR_VIEWS,
  type EditorViewName,
  VIEW_CHANGE_SOURCES,
  type ViewChangeSource,
} from "./catalog/navigation";
export {
  type AnalyticsEventDefinition,
  type AnalyticsParam,
  type AnalyticsParamValue,
  type BooleanParam,
  type BucketParam,
  type CountParam,
  declaredValues,
  type EnumParam,
  PARAM_KINDS,
  type SlugParam,
} from "./catalog/params";
export { COMMAND_IDS, type CommandId } from "./catalog/project";
export {
  DEVICE_OPERATIONS,
  type DeviceOperation,
  INSTRUMENT_TYPES,
  type InstrumentTypeKey,
} from "./catalog/tracks";

// ---------------------------------------------------------------------------
// Values that span every area
// ---------------------------------------------------------------------------

/**
 * `feature_first_use` keys (PRD `OPS-02`). One low-cardinality key rather than
 * an event name per feature, so first-use is comparable across features in one
 * report and the catalog stays well inside GA4's distinct-event-name limit.
 * A feature task adds its key to its own area's list under `./catalog/` with
 * the feature.
 */
export const FEATURE_KEYS = [
  ...APP_FEATURE_KEYS,
  ...AUDIO_FEATURE_KEYS,
  ...TRACK_FEATURE_KEYS,
  ...CLIP_FEATURE_KEYS,
  ...ARRANGEMENT_FEATURE_KEYS,
  ...NAVIGATION_FEATURE_KEYS,
  ...LIBRARY_FEATURE_KEYS,
  ...EXPORT_FEATURE_KEYS,
  ...ASSISTANT_FEATURE_KEYS,
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * Registered shortcut actions, as `shortcut_used`'s `action_id` (PRD `KEY-01`).
 *
 * Pinned here for the same reason as `COMMAND_IDS`: an analytics parameter's
 * value set is a published contract, and pinning it means a mapping added to
 * `src/shortcuts/registry.ts` has to be given an analytics decision in the same
 * change, in the same area's list under `./catalog/`. `catalog.test.ts` asserts
 * this list equals the registry's exactly.
 */
export const SHORTCUT_ACTION_IDS = [
  ...AUDIO_SHORTCUT_ACTION_IDS,
  ...TRACK_SHORTCUT_ACTION_IDS,
  ...CLIP_SHORTCUT_ACTION_IDS,
  ...EDITING_SHORTCUT_ACTION_IDS,
  ...ARRANGEMENT_SHORTCUT_ACTION_IDS,
  ...NAVIGATION_SHORTCUT_ACTION_IDS,
  ...LIBRARY_SHORTCUT_ACTION_IDS,
  ...EXPORT_SHORTCUT_ACTION_IDS,
  ...ASSISTANT_SHORTCUT_ACTION_IDS,
] as const;
export type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number];

// ---------------------------------------------------------------------------
// Automatic parameters and user properties
// ---------------------------------------------------------------------------

/**
 * Attached by the logging boundary to every event (PRD `OPS-02`: "Every event
 * carries the release SHA and the surface it came from"). Callers never pass
 * these — they are not part of any event's payload type, and the boundary
 * strips them if a caller somehow supplies one.
 */
export const AUTOMATIC_PARAMS = {
  /** The deployed revision, from `src/release.ts` (PRD `OPS-01`). */
  release_sha: "release_sha",
  surface: "surface",
} as const;

/**
 * GA4 user properties (PRD `OPS-02`: "limited to coarse, non-identifying
 * facts: account type and whether the session is internal").
 */
export const USER_PROPERTIES = {
  account_type: "account_type",
  /** `"true"`/`"false"` — GA4 user property values are strings. */
  internal: "internal",
} as const;

/**
 * GA4's reserved `traffic_type` parameter, which its *Internal Traffic* data
 * filter matches on (Admin → Data streams → Configure tag settings → Define
 * internal traffic; the filter under Data settings → Data filters). The
 * `internal` user property above is a custom dimension for *reading* reports;
 * this is what lets the property *exclude* the sessions. The transport sets it
 * as a default parameter on every event, automatic collection included, for a
 * browser `isInternalTraffic()` is true in.
 */
export const INTERNAL_TRAFFIC_EVENT_PARAMS = { traffic_type: "internal" } as const;

// ---------------------------------------------------------------------------
// The event catalog
// ---------------------------------------------------------------------------

/**
 * Every event in the PRD `OPS-02` catalog table, grouped by feature area.
 *
 * `surface`, `release_sha`, `account_type`, and `internal` appear in the PRD's
 * "key parameters" column for some rows but are not declared per-event: the
 * boundary attaches the first two to everything and sets the last two as user
 * properties.
 */
export const ANALYTICS_EVENTS = {
  ...APP_EVENTS,
  ...PROJECT_EVENTS,
  ...AUDIO_EVENTS,
  ...TRACK_EVENTS,
  ...CLIP_EVENTS,
  ...EDITING_EVENTS,
  ...ARRANGEMENT_EVENTS,
  ...NAVIGATION_EVENTS,
  ...LIBRARY_EVENTS,
  ...EXPORT_EVENTS,
  ...ASSISTANT_EVENTS,

  feature_first_use: {
    phase: 0,
    owners: ["FND-001c", "each owning feature task"],
    params: { feature: enumParam(FEATURE_KEYS) },
  },

  shortcut_used: {
    phase: 1,
    owners: ["LOOP-014"],
    // Action IDs come from the KEY-01 shortcut registry (LOOP-014), and the
    // registry — not the handler — is what logs them.
    params: { action_id: enumParam(SHORTCUT_ACTION_IDS) },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;

export type AnalyticsCatalog = typeof ANALYTICS_EVENTS;
export type AnalyticsEventName = keyof AnalyticsCatalog;

export const ANALYTICS_EVENT_NAMES = Object.keys(
  ANALYTICS_EVENTS,
) as AnalyticsEventName[];

// ---------------------------------------------------------------------------
// Derived payload types
// ---------------------------------------------------------------------------

/** The value type one declared parameter accepts. */
export type ParamValue<P> = P extends EnumParam<infer V, boolean>
  ? V
  : P extends BucketParam<infer S, boolean>
    ? BucketLabel<S>
    : P extends BooleanParam
      ? boolean
      : P extends CountParam
        ? number
        : P extends SlugParam
          ? PublishedPackId
          : never;

type ParamsOf<N extends AnalyticsEventName> = AnalyticsCatalog[N]["params"];

type RequiredKeys<P> = {
  [K in keyof P]: P[K] extends { optional: true } ? never : K;
}[keyof P];

type OptionalKeys<P> = {
  [K in keyof P]: P[K] extends { optional: true } ? K : never;
}[keyof P];

/**
 * The payload a caller must pass for one event.
 *
 * Required parameters are required, optional ones optional, and every value is
 * narrowed to its declared set — so `log("clip_edited", { editor: "steps" })`
 * (a typo) and `log("clip_edited", { editor: someUserInput })` are both type
 * errors, not runtime surprises.
 */
export type AnalyticsEventPayload<N extends AnalyticsEventName> = {
  [K in RequiredKeys<ParamsOf<N>>]: ParamValue<ParamsOf<N>[K]>;
} & {
  [K in OptionalKeys<ParamsOf<N>>]?: ParamValue<ParamsOf<N>[K]>;
};

/** Events whose payload is empty, so `log(name)` needs no second argument. */
type HasNoParams<N extends AnalyticsEventName> = keyof ParamsOf<N> extends never
  ? true
  : false;

/** Argument tuple for `log`, making the payload optional for empty events. */
export type LogArgs<N extends AnalyticsEventName> = HasNoParams<N> extends true
  ? [payload?: Record<string, never>]
  : [payload: AnalyticsEventPayload<N>];

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  readonly params: Record<string, AnalyticsParamValue>;
  readonly issues: readonly string[];
}

/**
 * Second line of defense behind the types.
 *
 * The compiler already rejects unregistered events, unregistered parameters,
 * and out-of-set values at every call site. This exists because analytics is
 * also reachable from untyped edges — a JS consumer, a `@ts-expect-error`, a
 * value narrowed by a cast — and a bad value must be dropped rather than sent.
 * It never throws: PRD `OPS-02` requires analytics to fail open.
 */
export function validateEventPayload(
  event: AnalyticsEventName,
  payload: Readonly<Record<string, unknown>> = {},
): ValidationResult {
  const definition = ANALYTICS_EVENTS[event] as AnalyticsEventDefinition | undefined;
  const params: Record<string, AnalyticsParamValue> = {};
  const issues: string[] = [];

  // The compiler rejects an unregistered event at every typed call site, so
  // reaching this needs an untyped edge. It must still return rather than
  // throw: analytics fails open, and the caller is editing or playback code.
  if (!definition) {
    return { params, issues: [`"${event}" is not a registered event`] };
  }

  for (const [name, value] of Object.entries(payload)) {
    const spec = definition.params[name];
    if (!spec) {
      issues.push(`"${event}" has no parameter "${name}"`);
      continue;
    }
    if (value === undefined) continue;
    const coerced = coerceParam(spec, value);
    if (coerced === undefined) {
      // Deliberately does not include `value` — an issue string can end up in
      // a log or an error report, and the whole point of this file is that a
      // rejected value may be exactly the project content that must not travel.
      issues.push(`"${event}.${name}" received a value outside its declared set`);
      continue;
    }
    params[name] = coerced;
  }

  for (const [name, spec] of Object.entries(definition.params)) {
    if (!spec.optional && !(name in params)) {
      issues.push(`"${event}" is missing required parameter "${name}"`);
    }
  }

  return { params, issues };
}
