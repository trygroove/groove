// The library: finding, auditioning and inserting sounds, and the packs they
// come from.

import { ERROR_CODES } from "../errorCodes";
import { PACK_KINDS, RESERVED_PACK_IDS } from "../packIdentity";
import {
  type AnalyticsEventDefinition,
  boolParam,
  enumParam,
  optionalCountParam,
  slugParam,
} from "./params";

/**
 * Our own published packs, as `pack_id` values (PRD LIB-05, LOOP-013, LIB-08).
 *
 * `pack_id` is a pack's stable **slug** — never its display name, never its
 * `pak_` ID. This list is *not* the parameter's whole value set: a third-party
 * pack is published into the library out of band, so no table compiled into the
 * app can enumerate every legitimate slug, and `pack_id` is a
 * {@link SlugParam} that admits any published slug by shape (see
 * `packAnalyticsIdentity`, which decides whether a given pack's slug may travel
 * at all).
 *
 * What the list still buys is a decision point for *our* catalogue: a factory
 * pack shipped without an analytics decision fails `catalog.test.ts` rather than
 * quietly appearing in reports, and the frozen slugs document what a saved PostHog
 * insight of the first-party library can rely on.
 */
export const LIBRARY_PACK_SLUGS = [
  "core-electronic-drums",
  "foundation-bass",
  "tonal-elements",
  "ambient-textures",
  "transitions-fx",
  "cc0-percussion",
  "cc0-keys-mallets",
  "cc0-synth-tones",
  // Private-alpha only; leaves with the pack itself (CNT-003, #676).
  "alpha-drum-machines",
] as const;
export type LibraryPackSlug = (typeof LIBRARY_PACK_SLUGS)[number];

/** The library's `feature_first_use` keys (see `FEATURE_KEYS`). */
export const LIBRARY_FEATURE_KEYS = [
  "library_browser",
  "pack_browser",
  "library_similar",
  "library_shuffle",
  "library_pack_preview",
  // Moving a project's pin for a pack to a newer version so a sound from it can
  // go in (#892), whether automatic or chosen with "Upgrade anyway".
  "pack_upgrade",
  "library_favourites",
  // Opening the library's Recently heard place (#815).
  "library_recently_heard",
  // A producer's own packs and the sounds they import into them (#282).
  "user_packs",
] as const;

/** The library's shortcut actions, as `shortcut_used`'s `action_id` (see `SHORTCUT_ACTION_IDS`). */
export const LIBRARY_SHORTCUT_ACTION_IDS = [
  "library.select_previous",
  "library.select_next",
  "library.audition",
  "library.insert",
  "library.insert_and_return",
  "library.like",
  "library.similar",
  "library.shuffle",
  "library.pick_all",
  "library.category_previous",
  "library.category_next",
  "library.family_previous",
  "library.family_next",
  "library.genre_menu",
  "library.loop_tempo",
  "library.all_sounds",
  "library.favourites",
  "library.browse_packs",
  "library.back",
  "library.search",
] as const;

export const LIBRARY_EVENTS = {
  library_audition: {
    phase: 1,
    owners: ["LOOP-013"],
    params: {
      asset_type: enumParam(["one_shot", "loop", "instrument_preset"]),
      had_genre_filter: boolParam(),
      // The pack's stable slug (never its display name), so an audition can
      // be attributed to a pack without leaking library copy — see
      // `packIdentity.ts` for which packs may be named at all.
      pack_id: slugParam(RESERVED_PACK_IDS),
      pack_kind: enumParam(PACK_KINDS),
    },
  },

  library_pack_added: {
    phase: 1,
    owners: ["LOOP-013", "LIB-08"],
    // This is the pack-popularity measure, so it has to say *which* pack —
    // including a third party's, whose creator the adoption number is fed back
    // to (LIB-05, LIB-06). `pack_id` therefore carries any *published* pack's
    // slug, first-party or third-party, and `"user"` for an unpublished pack a
    // producer authored themselves. `packAnalyticsIdentity` is what draws that
    // line; the same two parameters as `library_audition`, so a pack's
    // auditions and its adds join on one vocabulary.
    params: {
      pack_id: slugParam(RESERVED_PACK_IDS),
      pack_kind: enumParam(PACK_KINDS),
    },
  },

  library_pack_upgraded: {
    phase: 1,
    owners: ["#892"],
    // An insert moved the project's pin for a pack to the newer version the
    // sound came from (#892). `choice` says whether that was the automatic,
    // safe upgrade (every sound the project used is still in the pack) or the
    // producer's "Upgrade anyway" over sounds that would go missing, and
    // `missing_sound_count` how many went missing (0 when automatic; absent
    // when the newer version's manifest could not be read to count them).
    // Neither the pack nor any sound is named.
    params: {
      choice: enumParam(["automatic", "upgrade_anyway"]),
      missing_sound_count: optionalCountParam(100),
    },
  },

  library_favourite_changed: {
    phase: 1,
    owners: ["LIB-010", "LIB-011"],
    // One heart press or `L`: added or removed. The sound is deliberately not
    // named, and neither is its pack: what a producer keeps is theirs.
    params: { favourited: boolParam() },
  },

  user_pack_created: {
    phase: 1,
    owners: ["#282"],
    // A producer made a pack of their own: with "Add pack", or by dropping
    // files on empty space, which makes "My Sounds". The pack is never named.
    params: { method: enumParam(["button", "drop"]) },
  },

  sound_imported: {
    phase: 1,
    owners: ["#282"],
    // One file landed in a personal pack. What sort of sound it became and how
    // it came in; never its filename, its name, its pack, or where it is stored.
    params: {
      asset_type: enumParam(["one_shot", "loop"]),
      method: enumParam(["drop", "picker"]),
    },
  },

  sound_import_failed: {
    phase: 1,
    owners: ["#282"],
    // An import that did not land, by a stable code: the file's type or size,
    // the account's allowance, a file that would not decode, or a refused or
    // dropped upload. A cancelled import is the producer's choice, not a
    // failure, and is not reported.
    params: { error_code: enumParam(ERROR_CODES) },
  },

  asset_load_failed: {
    phase: 1,
    owners: ["LOOP-006", "LOOP-013"],
    params: {
      asset_type: enumParam(["one_shot", "loop", "instrument_preset"]),
      error_code: enumParam(ERROR_CODES),
    },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
