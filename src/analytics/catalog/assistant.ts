// The assistant: messages, suggestions, the questions it asks, and the
// proposals it makes.

import { ASSISTANT_ERROR_CODES, TAKE_PART_TYPES } from "../../assistant/protocol";
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
  "assistant_follow_up",
  "assistant_proposal",
  "assistant_proposal_part",
  "assistant_recommendation",
  "assistant_ask",
  "assistant_takes",
  "assistant_drum_takes",
  "assistant_retention",
  "assistant_disclosure",
  "assistant_video",
  "assistant_rating",
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

/** How many takes one offer holds (`TAKE_COUNT`, GRV-207). */
const MAX_TAKES = 4;

/** The most "4 more" presses one part's events count before they clamp. */
const MAX_TAKES_REROLLS = 20;

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

/**
 * Why a proposal was refused, as `assistant_proposal_rejected`'s
 * `issue_code` (GRV-98). Pinned against `PROPOSAL_ISSUE_CODES` in
 * `src/assistant/proposalIssues.ts` by `catalog.test.ts`, so a new way to
 * refuse a proposal needs a decision here.
 */
export const ASSISTANT_PROPOSAL_ISSUE_CODES = [
  "malformed",
  "too_many_commands",
  "stale_revision",
  "unknown_tool",
  "invalid_payload",
  "unauthorized",
  "toolset_mismatch",
  "out_of_range",
  "rejected",
  "invalid_project",
] as const;

/**
 * What a refused proposal was trying to change: a capability as the other
 * proposal events carry it, or `unknown` when none of its calls named a tool
 * the assistant has with a payload it could read.
 */
export const ASSISTANT_REJECTED_CAPABILITIES = [
  ...ASSISTANT_PROPOSAL_CAPABILITIES,
  "unknown",
] as const;

/**
 * Why an assistant session went sad (GRV-103), as `assistant_session_sad`'s
 * `reason`: a turn that failed, was cut off or refused; a proposal rejected
 * as invalid or stale; one undone within a minute of applying or turned
 * down; or a reply rated down.
 */
export const ASSISTANT_SAD_REASONS = [
  "turn_error",
  "max_tokens",
  "refusal",
  "proposal_invalid",
  "proposal_stale",
  "proposal_undone_fast",
  "proposal_cancelled",
  "rated_down",
] as const;

/**
 * Who a sad signal blames: the system (`hard`), the producer's reaction to a
 * proposal (`soft`), or the producer's own rating (`explicit`).
 */
export const ASSISTANT_SAD_SIGNAL_CLASSES = ["hard", "soft", "explicit"] as const;

/** The two sad-session rates an `assistant_session_sad` counts towards. */
export const ASSISTANT_SAD_RATES = ["full", "hard"] as const;

/** The most issues `assistant_proposal_rejected` counts (`MAX_TRANSCRIPT_ISSUES`). */
const MAX_PROPOSAL_ISSUES = 20;

/** The most parts one proposal has (`MAX_PROPOSAL_COMMANDS`). */
const MAX_PROPOSAL_PARTS = 100;

/** The most sounds one recommendation suggests (`ASSISTANT_LIBRARY_LIMITS`). */
const MAX_RECOMMENDED_SOUNDS = 3;

export const ASSISTANT_EVENTS = {
  /**
   * A turn went to the assistant. `automatic` is true for the follow-up the
   * assistant takes by itself after a proposal is applied (GRV-195), once per
   * follow-up; false for everything the producer sent.
   */
  assistant_message_sent: {
    phase: 3,
    owners: ["AI-004", "GRV-195"],
    params: {
      scope: enumParam(["clip", "track", "section", "song"]),
      automatic: boolParam(),
    },
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

  // Four takes of a part to pick from (GRV-207). Never a take's notes, its
  // label or the part's name: only where the pick was, how many takes fitted
  // the song, how many times "4 more" was pressed for the part, and whether
  // the part was melodic or a drum pattern (`part_type`, GRV-213).
  assistant_take_picked: {
    phase: 3,
    owners: ["GRV-207", "GRV-213"],
    params: {
      position: countParam(MAX_TAKES),
      take_count: countParam(MAX_TAKES),
      reroll_count: countParam(MAX_TAKES_REROLLS),
      part_type: enumParam(TAKE_PART_TYPES),
    },
  },

  assistant_takes_declined: {
    phase: 3,
    owners: ["GRV-207", "GRV-213"],
    params: {
      take_count: countParam(MAX_TAKES),
      reroll_count: countParam(MAX_TAKES_REROLLS),
      part_type: enumParam(TAKE_PART_TYPES),
    },
  },

  assistant_takes_rerolled: {
    phase: 3,
    owners: ["GRV-207", "GRV-213"],
    params: {
      reroll_count: countParam(MAX_TAKES_REROLLS),
      part_type: enumParam(TAKE_PART_TYPES),
    },
  },

  /**
   * A takes card arrived with not one take that fits the song, though the
   * song had not moved under it: why the first take was refused, as
   * `assistant_proposal_rejected` says it of a proposal. Once per card.
   */
  assistant_takes_unfit: {
    phase: 3,
    owners: ["GRV-207"],
    params: {
      issue_code: enumParam(ASSISTANT_PROPOSAL_ISSUE_CODES),
      take_count: countParam(MAX_TAKES),
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

  /**
   * The first part of a proposal streamed part by part reached its card
   * (GRV-144): how long after the message was sent, bucketed. Once per
   * proposal.
   */
  assistant_proposal_first_part_shown: {
    phase: 3,
    owners: ["GRV-144"],
    params: { elapsed_ms_bucket: bucketParam("elapsed_ms") },
  },

  /**
   * One part of a streamed proposal was applied on its own (GRV-144): its
   * place among the proposal's parts, from 0, and whether the turn was still
   * writing the rest.
   */
  assistant_proposal_part_applied: {
    phase: 3,
    owners: ["GRV-144"],
    params: {
      part_index: countParam(MAX_PROPOSAL_PARTS),
      turn_running: boolParam(),
    },
  },

  /**
   * A proposal's preview opened on the arrangement (GRV-193): once per
   * preview shown. `automatic` is true when the assistant turned it on as the
   * proposal arrived, false when the producer clicked Preview. A preview
   * that follows a streamed proposal's later parts is the same preview.
   */
  assistant_proposal_previewed: {
    phase: 3,
    owners: ["GRV-193"],
    params: { automatic: boolParam() },
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
   * A proposal the assistant made did not reach the producer as something to
   * apply (GRV-98): once per proposal, when its card shows it. `kind` is
   * `stale` when the song had moved on since the request, otherwise
   * `invalid`. `issue_code` is the first issue's code (the one the card
   * explains), `issue_code_count` how many different codes it had. Codes
   * only: never a message, a path, a tool's input or an ID; a kept
   * transcript holds the rest.
   */
  assistant_proposal_rejected: {
    phase: 3,
    owners: ["AI-003"],
    params: {
      kind: enumParam(["invalid", "stale"]),
      capability: enumParam(ASSISTANT_REJECTED_CAPABILITIES),
      command_count_bucket: bucketParam("command_count"),
      issue_code: enumParam(ASSISTANT_PROPOSAL_ISSUE_CODES),
      issue_code_count: countParam(MAX_PROPOSAL_ISSUES),
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
   * A tutorial video the assistant recommended was shown, as a still card
   * that has loaded nothing from YouTube (GRV-16). Never the video's ID,
   * title, channel or URL.
   */
  assistant_video_shown: {
    phase: 3,
    owners: ["GRV-16"],
    params: {},
  },

  /** Play on a recommended video: the player loads from YouTube and starts. */
  assistant_video_played: {
    phase: 3,
    owners: ["GRV-16"],
    params: {},
  },

  /** A playing video was opened full screen. */
  assistant_video_expanded: {
    phase: 3,
    owners: ["GRV-16"],
    params: {},
  },

  /** A video's player did not load, and the card said so. */
  assistant_video_failed: {
    phase: 3,
    owners: ["GRV-16"],
    params: {},
  },

  /**
   * A conversation's first sent message (GRV-103): the denominator of the
   * sad-session rate. Never the conversation's ID or anything it said.
   */
  assistant_session_started: {
    phase: 3,
    owners: ["GRV-103"],
    params: {},
  },

  /**
   * A conversation had a bad response (GRV-103): the numerator of the
   * sad-session rate. At most twice per conversation: once with
   * `counts_for: full` on its first bad signal of any class, and once with
   * `counts_for: hard` on its first hard or explicit one (both on the same
   * signal when the first is hard or explicit). `turn_index_bucket` is the
   * turn the signal came from.
   */
  assistant_session_sad: {
    phase: 3,
    owners: ["GRV-103"],
    params: {
      reason: enumParam(ASSISTANT_SAD_REASONS),
      signal_class: enumParam(ASSISTANT_SAD_SIGNAL_CLASSES),
      turn_index_bucket: bucketParam("turn_index"),
      counts_for: enumParam(ASSISTANT_SAD_RATES),
    },
  },

  /**
   * A turn failed (GRV-206): once per failed turn, with the gateway's (or the
   * browser client's) error code, a fixed list and never the provider's
   * words. A turn the producer stopped or cancelled is not one. What a
   * PostHog alert on `provider_error` and `provider_unavailable` watches, for
   * every producer whatever the assistant's traces may send.
   * `turn_index_bucket` is the turn of the conversation that failed.
   */
  assistant_turn_failed: {
    phase: 3,
    owners: ["GRV-206"],
    params: {
      code: enumParam(ASSISTANT_ERROR_CODES),
      turn_index_bucket: bucketParam("turn_index"),
    },
  },

  /** Thumbs up or down on a reply (GRV-103), once per change; clearing logs nothing. */
  assistant_reply_rated: {
    phase: 3,
    owners: ["GRV-103"],
    params: { rating: enumParam(["up", "down"]) },
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
