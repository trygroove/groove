// The app, its accounts and the browser it runs in: the analytics events and
// value sets that are about Groove itself rather than a project in it.

import { ERROR_AREAS, ERROR_CODES } from "../errorCodes";
import {
  type AnalyticsEventDefinition,
  boolParam,
  countParam,
  enumParam,
} from "./params";

/**
 * The surfaces the app can log from. Attached to every event automatically
 * (see `AUTOMATIC_PARAMS`), so no event declares it.
 */
export const SURFACES = ["landing", "dashboard", "editor"] as const;
export type Surface = (typeof SURFACES)[number];

/** Non-identifying account facts, set as a PostHog person property. */
export const ACCOUNT_TYPES = ["anonymous", "registered", "unknown"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * The browser capabilities Groove feature-detects (PRD section 10, #75), as
 * `browser_capability_missing`'s `capability`. Pinned here like
 * `SHORTCUT_ACTION_IDS`: `catalog.test.ts` asserts it equals
 * `CAPABILITY_IDS` in `src/browser/capabilities.ts` exactly, so a new probe has
 * to be given an analytics decision in the same change.
 */
export const BROWSER_CAPABILITY_IDS = [
  "web_audio",
  "audio_decoding",
  "offline_audio",
  "site_storage",
  "canvas_2d",
  "file_download",
] as const;

/** The app's `feature_first_use` keys (see `FEATURE_KEYS`). */
export const APP_FEATURE_KEYS = [
  // The in-app account controls (#951): logging a guest in to an existing
  // account, and signing out.
  "log_in",
  "sign_out",
  // The admin page's batch approval of the alpha allowlist (#854).
  "allowlist_admin",
  // The home page's second version (#1135): a visitor's first call to action
  // on it, of any kind.
  "landing_v2",
] as const;

/**
 * Where a home-page call to action sits (#1135), as `landing_cta_click`'s
 * `placement`, so conversion can be compared by place on the page.
 */
export const LANDING_CTA_PLACEMENTS = ["header", "hero", "close"] as const;

/**
 * What happened to unsaved edits when the crash screen reloaded (GRV-55), as
 * `crash_reloaded`'s `save_outcome`: there were none, they were written, or
 * they could not be written and the producer chose to reload anyway.
 */
export const CRASH_SAVE_OUTCOMES = ["nothing_queued", "saved", "unsaved"] as const;
export type CrashSaveOutcome = (typeof CRASH_SAVE_OUTCOMES)[number];

export const APP_EVENTS = {
  app_opened: {
    phase: 0,
    owners: ["FND-001c"],
    params: {},
  },

  landing_cta_click: {
    phase: 1,
    owners: ["LOOP-001b", "#1135"],
    // `start_free` was guest start, retired by #854 and kept so its history
    // stays readable; `log_in` is the Sign in button; `see_inside` is the
    // hero's anchor down to the studio (#1135). `placement` is where on the
    // page it sat (#1135), so `cta_id` keeps meaning what it always has.
    params: {
      cta_id: enumParam(["start_free", "log_in", "request_access", "see_inside"]),
      placement: enumParam(LANDING_CTA_PLACEMENTS),
    },
  },

  // The home page's hero video started (#1135), once per page view. It never
  // plays under reduced motion, so this also says how many visitors saw it.
  landing_video_play: {
    phase: 1,
    owners: ["#1135"],
    params: {},
  },

  anon_session_created: {
    phase: 1,
    owners: ["LOOP-001"],
    params: {},
  },

  // The alpha allowlist (#854). A sign-in the blocking function refused,
  // counted where the browser learns of it; which surface it was refused on,
  // never the address.
  sign_in_blocked: {
    phase: 1,
    owners: ["#854"],
    params: { source: enumParam(["landing", "log_in", "upgrade"]) },
  },

  // An admin approving addresses onto the allowlist (#854): from a paste or a
  // blocked attempt's one-click Approve, and how many of each outcome. Counts
  // only; an address is never a parameter.
  allowlist_approved: {
    phase: 1,
    owners: ["#854"],
    params: {
      source: enumParam(["paste", "attempt"]),
      added_count: countParam(1000),
      already_listed_count: countParam(1000),
      invalid_count: countParam(1000),
    },
  },

  // An admin revoking an account's access (#1147): the address taken off the
  // allowlist and its sessions ended, through the `revokeAccess` callable.
  // Whether it was still listed and whether an account had it; never the
  // address.
  access_revoked: {
    phase: 1,
    owners: ["#1147"],
    params: { was_listed: boolParam(), sessions_ended: boolParam() },
  },

  account_upgraded: {
    phase: 1,
    owners: ["LOOP-001"],
    // The alpha's only upgrade path is linking an anonymous account to a
    // Google identity (see src/auth/authService.ts). A second provider adds
    // its key here with the sign-in method itself.
    params: { method: enumParam(["google"]) },
  },

  browser_capability_missing: {
    phase: 1,
    owners: ["#75"],
    // The editor opened in a browser that lacks a capability Groove depends
    // on, so the producer was shown what it costs and what to do (PRD section
    // 10, #75). Once per capability per browser: a missing API is a property
    // of the browser, not of a session. `is_required` separates "no sound at
    // all" from one feature being unavailable.
    params: {
      capability: enumParam(BROWSER_CAPABILITY_IDS),
      is_required: boolParam(),
    },
  },

  /**
   * The producer pressed Reload on the crash screen (GRV-55), which writes
   * any edit still waiting to save before it reloads. `save_outcome` says
   * whether there was one and whether it landed.
   */
  crash_reloaded: {
    phase: 3,
    owners: ["GRV-55"],
    params: { save_outcome: enumParam(CRASH_SAVE_OUTCOMES) },
  },

  exception: {
    phase: 0,
    owners: ["FND-001c"],
    params: {
      fatal: boolParam(),
      area: enumParam(ERROR_AREAS),
      error_code: enumParam(ERROR_CODES),
    },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
