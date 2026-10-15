// Onboarding with Cue (GRV-25): the welcome's questions, how it ended, and
// the customer-validation event a producer consents to.
//
// No parameter carries an answer's text. The validation event carries only
// the fixed choices (an experience level, a goal, learn and gear chips), and
// only for a producer who ticked the box to share them: never artists, never
// anything typed, never a note.

import {
  EXPERIENCE_LEVELS,
  MEMORY_FIELDS,
  ONBOARDING_QUESTION_IDS,
  PRODUCER_GOALS,
} from "../../persistence/profileDocuments";
import { type AnalyticsEventDefinition, countParam, enumParam } from "./params";

/** Onboarding's `feature_first_use` keys (see `FEATURE_KEYS`). */
export const ONBOARDING_FEATURE_KEYS = ["onboarding", "memory"] as const;

/**
 * What a memory proposal would change, as `memory_note_*`'s `kind`: a note,
 * or one of memory's six fields. Never its text.
 */
export const MEMORY_PROPOSAL_KINDS = ["note", ...MEMORY_FIELDS] as const;

/** How a question was answered: an option picked, words typed, or skipped. */
export const ONBOARDING_ANSWERS = ["pick", "text", "skipped"] as const;

/** The learn chips, as the validation event names them. */
export const LEARN_CHIP_IDS = [
  "drums",
  "bass",
  "chords",
  "sound_design",
  "arranging",
  "mixing",
] as const;
export type LearnChipId = (typeof LEARN_CHIP_IDS)[number];

/** The gear chips, as the validation event names them. */
export const GEAR_CHIP_IDS = [
  "ableton_move",
  "roland_t8",
  "midi_keyboard",
  "drum_machine",
  "synth",
  "computer_only",
] as const;
export type GearChipId = (typeof GEAR_CHIP_IDS)[number];

/** A question the producer left unanswered, in the validation event. */
export const UNANSWERED = "unanswered";

const QUESTIONS = ONBOARDING_QUESTION_IDS.length;

export const ONBOARDING_EVENTS = {
  onboarding_started: {
    phase: 3,
    owners: ["GRV-25"],
    params: {},
  },

  // One per question: which, and how. Never the answer.
  onboarding_question_answered: {
    phase: 3,
    owners: ["GRV-25"],
    params: {
      question_id: enumParam(ONBOARDING_QUESTION_IDS),
      how: enumParam(ONBOARDING_ANSWERS),
    },
  },

  onboarding_completed: {
    phase: 3,
    owners: ["GRV-25"],
    params: { answered_count: countParam(QUESTIONS) },
  },

  onboarding_skipped: {
    phase: 3,
    owners: ["GRV-25"],
    params: { answered_count: countParam(QUESTIONS) },
  },

  // Customer validation, only with the producer's consent: their experience
  // level and goal...
  onboarding_validation: {
    phase: 3,
    owners: ["GRV-25"],
    params: {
      experience: enumParam([...EXPERIENCE_LEVELS, UNANSWERED]),
      goal: enumParam([...PRODUCER_GOALS, UNANSWERED]),
    },
  },

  // ...and one of these per learn or gear chip they picked.
  onboarding_validation_chip: {
    phase: 3,
    owners: ["GRV-25"],
    params: {
      group: enumParam(["learn", "gear"]),
      chip: enumParam([...LEARN_CHIP_IDS, ...GEAR_CHIP_IDS]),
    },
  },

  // Memory is never written silently: Cue proposes, the producer confirms,
  // and a confirmed change can be undone. Which kind of change, never what.
  memory_note_proposed: {
    phase: 3,
    owners: ["GRV-25"],
    params: { kind: enumParam(MEMORY_PROPOSAL_KINDS) },
  },

  memory_note_confirmed: {
    phase: 3,
    owners: ["GRV-25"],
    params: { kind: enumParam(MEMORY_PROPOSAL_KINDS) },
  },

  memory_note_undone: {
    phase: 3,
    owners: ["GRV-25"],
    params: { kind: enumParam(MEMORY_PROPOSAL_KINDS) },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
