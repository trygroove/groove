// The assistant: messages, suggestions, the questions it asks, and the
// proposals it makes.

import {
  type AnalyticsEventDefinition,
  boolParam,
  bucketParam,
  countParam,
  enumParam,
} from "./params";

/** The assistant's `feature_first_use` keys (see `FEATURE_KEYS`). */
export const ASSISTANT_FEATURE_KEYS = [
  "assistant",
  "assistant_message",
  "assistant_proposal",
  "assistant_recommendation",
  "assistant_ask",
  "assistant_retention",
] as const;

/**
 * How the producer answered a question the assistant asked (GRV-42), as
 * `assistant_ask_answered`'s `how`: picked an option (with or without typing
 * too), typed an answer of their own, made the change in the editor instead,
 * or dismissed it.
 */
export const ASSISTANT_ASK_ANSWERS = ["pick", "text", "did_it", "dismissed"] as const;

/** The most options a question can offer (`ASK_LIMITS.maxOptions`). */
const MAX_ASK_OPTIONS = 8;

/** The assistant panel's shortcut actions, as `shortcut_used`'s `action_id` (see `SHORTCUT_ACTION_IDS`). */
export const ASSISTANT_SHORTCUT_ACTION_IDS = [
  "assistant.toggle",
  "assistant.grow",
  "assistant.shrink",
  "assistant.grow_more",
  "assistant.shrink_more",
  "assistant.send",
  "assistant.ask_option_1",
  "assistant.ask_option_2",
  "assistant.ask_option_3",
  "assistant.ask_option_4",
  "assistant.ask_option_5",
  "assistant.ask_option_6",
  "assistant.ask_option_7",
  "assistant.ask_option_8",
  "assistant.ask_finish",
  "assistant.ask_hear",
] as const;

/**
 * The suggestion chips' IDs, as `assistant_suggestion_clicked`'s
 * `suggestion_id` (GRV-26): #70's published next steps, and the panel's
 * focused ones for the view and the scope. Pinned against
 * `SUGGESTION_IDS` in `src/projection/projectAnalysisProjection.ts` by
 * `catalog.test.ts`, so a suggestion added there needs a decision here.
 */
export const ASSISTANT_SUGGESTION_IDS = [
  "create_arrangement",
  "add_variation",
  "build_transition",
  "balance_section",
  "add_track",
  "fill_empty_track",
  "vary_notes",
  "vary_clips",
  "develop_part",
  "write_fill",
  "shape_sound",
  "balance_mix",
  "find_sound",
] as const;

/**
 * What an assistant proposal changes, as `assistant_proposal_*`'s
 * `capability`: one key per Appendix A command family the assistant's tool
 * set carries, or `mixed` for a proposal spanning several. Pinned against
 * `src/assistant/tools.ts` by `catalog.test.ts`.
 */
export const ASSISTANT_PROPOSAL_CAPABILITIES = [
  "tempo",
  "tracks",
  "clips",
  "notes",
  "placements",
  "instrument",
  "devices",
  "returns",
  "mixer",
  "mixed",
] as const;

/**
 * Why a recommendation was refused, as `assistant_recommendation_refused`'s
 * `reason` (GRV-23). Pinned against `RECOMMENDATION_ISSUE_CODES` in
 * `src/assistant/recommendation.ts` by `catalog.test.ts`.
 */
export const ASSISTANT_RECOMMENDATION_REFUSALS = [
  "malformed",
  "unknown_pack",
  "unknown_sound",
] as const;

/** The most sounds one recommendation suggests (`ASSISTANT_LIBRARY_LIMITS`). */
const MAX_RECOMMENDED_SOUNDS = 3;

export const ASSISTANT_EVENTS = {
  assistant_message_sent: {
    phase: 3,
    owners: ["AI-004"],
    params: { scope: enumParam(["clip", "track", "section", "song"]) },
  },

  assistant_suggestion_clicked: {
    phase: 3,
    owners: ["AI-004"],
    params: { suggestion_id: enumParam(ASSISTANT_SUGGESTION_IDS) },
  },

  // A question the assistant asked (GRV-42). Never its wording, an option's,
  // or what the producer typed: only how many options it had and how it was
  // answered.
  assistant_ask_shown: {
    phase: 3,
    owners: ["AI-004"],
    params: {
      option_count: countParam(MAX_ASK_OPTIONS),
      multi_select: boolParam(),
      has_suggestion: boolParam(),
    },
  },

  assistant_ask_answered: {
    phase: 3,
    owners: ["AI-004"],
    params: {
      how: enumParam(ASSISTANT_ASK_ANSWERS),
      option_count: countParam(MAX_ASK_OPTIONS),
      suggested_taken: boolParam(),
    },
  },

  assistant_proposal_shown: {
    phase: 3,
    owners: ["AI-003"],
    params: {
      capability: enumParam(ASSISTANT_PROPOSAL_CAPABILITIES),
      command_count_bucket: bucketParam("command_count"),
    },
  },

  assistant_proposal_applied: {
    phase: 3,
    owners: ["AI-003"],
    params: {
      capability: enumParam(ASSISTANT_PROPOSAL_CAPABILITIES),
      command_count_bucket: bucketParam("command_count"),
      seconds_to_decision_bucket: bucketParam("elapsed_seconds"),
    },
  },

  assistant_proposal_cancelled: {
    phase: 3,
    owners: ["AI-003"],
    params: {
      capability: enumParam(ASSISTANT_PROPOSAL_CAPABILITIES),
      command_count_bucket: bucketParam("command_count"),
      seconds_to_decision_bucket: bucketParam("elapsed_seconds"),
    },
  },

  assistant_proposal_undone: {
    phase: 3,
    owners: ["AI-003"],
    params: {
      capability: enumParam(ASSISTANT_PROPOSAL_CAPABILITIES),
      command_count_bucket: bucketParam("command_count"),
      seconds_to_undo_bucket: bucketParam("elapsed_seconds"),
    },
  },

  /**
   * A producer edited, by hand, a control an applied proposal changed: once
   * per proposal, which then stops being watched (GRV-5). `capability` is the
   * proposal's, as its `assistant_proposal_applied` carried it.
   */
  assistant_result_edited: {
    phase: 3,
    owners: ["AI-004"],
    params: { capability: enumParam(ASSISTANT_PROPOSAL_CAPABILITIES) },
  },

  /**
   * A recommended pack's card was shown (GRV-23). `pack_in_project`: whether
   * the project already used the pack. Never the pack's, a sound's or the
   * request's words.
   */
  assistant_recommendation_shown: {
    phase: 3,
    owners: ["GRV-23"],
    params: {
      pack_in_project: boolParam(),
      sound_count: countParam(MAX_RECOMMENDED_SOUNDS),
    },
  },

  /** A recommendation named a pack or sound the library does not hold, and was refused. */
  assistant_recommendation_refused: {
    phase: 3,
    owners: ["GRV-23"],
    params: { reason: enumParam(ASSISTANT_RECOMMENDATION_REFUSALS) },
  },

  /** Try on ‹slot›: a recommended sound plays through the slot, unsaved. */
  assistant_recommendation_tried: {
    phase: 3,
    owners: ["GRV-23"],
    params: { pack_in_project: boolParam() },
  },

  /** Keep: the sound being tried went into the slot, as one undo step. */
  assistant_recommendation_kept: {
    phase: 3,
    owners: ["GRV-23"],
    params: {
      pack_in_project: boolParam(),
      seconds_to_decision_bucket: bucketParam("elapsed_seconds"),
    },
  },

  /** Put back: the sound being tried was dropped and the slot's own came back. */
  assistant_recommendation_put_back: {
    phase: 3,
    owners: ["GRV-23"],
    params: {
      pack_in_project: boolParam(),
      seconds_to_decision_bucket: bucketParam("elapsed_seconds"),
    },
  },

  /**
   * A producer answered whether Groove keeps their assistant conversations,
   * in the first-run disclosure or the setting (GRV-8): the answer and
   * nothing else. Logged once the answer is stored, and nothing about keeping
   * a conversation depends on it arriving.
   */
  assistant_retention_changed: {
    phase: 3,
    owners: ["AI-009"],
    params: { state: enumParam(["on", "off"]) },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
