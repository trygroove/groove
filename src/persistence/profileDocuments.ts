import { z } from "zod";
import type { JsonObject } from "../domain/serialize";

/**
 * The Firestore layout of a producer's profile (GRV-25): whether they have
 * been through onboarding, and what Cue remembers about them.
 *
 * A profile belongs to the person, never to a project, so it lives under the
 * user, beside their favourites and packs:
 *
 * | Path                         | Contents                         |
 * | ---------------------------- | -------------------------------- |
 * | `users/{uid}/profile/current`| The producer's one profile       |
 *
 * One document, because everything in it is read together (before every
 * reply, and on the Memory page) and it stays small: five answers, a capped
 * list of short notes and a few flags. `firestore.rules` restricts it to its
 * owner and checks its shape; no other account, and no project, ever reads
 * it.
 *
 * **Memory** is the five onboarding questions as typed keys (`taste`,
 * `artists`, `experience`, `goal`, `learn`, `gear`) plus at most
 * {@link MAX_MEMORY_NOTES} free-text notes the producer confirmed. It is the
 * producer's own words, so it never leaves in analytics: only the consented
 * validation event reads it, and only its fixed chips (see
 * `src/onboarding`).
 *
 * Like the project tiers, it carries its own schema version, and every time
 * is integer epoch milliseconds rather than a Firestore `Timestamp`.
 */

/** The schema version every profile document is written at. */
export const PROFILE_SCHEMA_VERSION = 1;

export const PROFILE_COLLECTION = "profile";
/** The one document in a user's profile collection. */
export const PROFILE_DOCUMENT_ID = "current";

/** The most free-text notes memory keeps. */
export const MAX_MEMORY_NOTES = 20;
/** The longest one note may be. */
export const MAX_NOTE_CHARS = 280;
/** The most entries a list field (taste, learn, gear) keeps. */
export const MAX_MEMORY_LIST = 20;
/** The longest one list entry may be. */
export const MAX_MEMORY_ITEM_CHARS = 80;
/** The longest the artists answer may be. */
export const MAX_ARTISTS_CHARS = 300;

/** The five onboarding questions, in the order they are asked. */
export const ONBOARDING_QUESTION_IDS = [
  "taste",
  "experience",
  "goal",
  "learn",
  "gear",
] as const;
export type OnboardingQuestionId = (typeof ONBOARDING_QUESTION_IDS)[number];

/** "How much music have you made?" */
export const EXPERIENCE_LEVELS = [
  "none",
  "played_around",
  "finished_a_few",
  "releases",
] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

/** "A goal, or just curious?" */
export const PRODUCER_GOALS = [
  "first_track",
  "video_or_game",
  "sound_design",
  "curious",
] as const;
export type ProducerGoal = (typeof PRODUCER_GOALS)[number];

/** How onboarding ended, or `null` while it has not. */
export const ONBOARDING_OUTCOMES = ["completed", "skipped"] as const;
export type OnboardingOutcome = (typeof ONBOARDING_OUTCOMES)[number];

/** The keys of memory, as the assistant and the Memory page name them. */
export const MEMORY_FIELDS = [
  "taste",
  "artists",
  "experience",
  "goal",
  "learn",
  "gear",
] as const;
export type MemoryField = (typeof MEMORY_FIELDS)[number];

/** What Cue remembers from the five questions. */
export interface ProducerMemory {
  /** Genres they love. */
  readonly taste: readonly string[];
  /** Artists they love, as they typed them. */
  readonly artists: string;
  readonly experience: ExperienceLevel | null;
  readonly goal: ProducerGoal | null;
  /** What they would like to learn. */
  readonly learn: readonly string[];
  /** The gear they would like to use with Groove. */
  readonly gear: readonly string[];
}

/** One thing the producer confirmed Cue should remember. */
export interface MemoryNote {
  readonly id: string;
  readonly text: string;
  /** When it was confirmed, epoch milliseconds. */
  readonly createdAt: number;
}

/** A producer's profile, as it is stored and read back. */
export interface ProducerProfile {
  /** How onboarding ended; `null` while it is still to do. */
  readonly onboarding: OnboardingOutcome | null;
  /** When onboarding ended, epoch milliseconds. */
  readonly onboardedAt: number | null;
  readonly memory: ProducerMemory;
  /** Oldest first, at most {@link MAX_MEMORY_NOTES}. */
  readonly notes: readonly MemoryNote[];
  /**
   * Questions skipped in onboarding that Cue may still ask, once each, when
   * the conversation makes them relevant. One leaves the list when it is
   * asked.
   */
  readonly laterQuestions: readonly OnboardingQuestionId[];
  /**
   * Whether the producer ticked the box to share their answers' fixed
   * choices for customer validation. Unticked unless they tick it.
   */
  readonly validationConsent: boolean;
  /** The local day (`YYYY-MM-DD`) Cue last offered a nudge, if ever. */
  readonly lastNudgeDay: string | null;
  /** When the profile was last written, epoch milliseconds. */
  readonly modifiedAt: number;
}

export const EMPTY_MEMORY: ProducerMemory = {
  taste: [],
  artists: "",
  experience: null,
  goal: null,
  learn: [],
  gear: [],
};

/** The profile of someone who has not been through onboarding. */
export function emptyProfile(now: number): ProducerProfile {
  return {
    onboarding: null,
    onboardedAt: null,
    memory: EMPTY_MEMORY,
    notes: [],
    laterQuestions: [],
    validationConsent: false,
    lastNudgeDay: null,
    modifiedAt: now,
  };
}

/** `users/{uid}/profile`. */
export function profileCollectionPath(uid: string): string {
  return `users/${uid}/${PROFILE_COLLECTION}`;
}

/** `users/{uid}/profile/current`. */
export function profileDocumentPath(uid: string): string {
  return `${profileCollectionPath(uid)}/${PROFILE_DOCUMENT_ID}`;
}

const item = z.string().trim().min(1).max(MAX_MEMORY_ITEM_CHARS);
const list = z.array(item).max(MAX_MEMORY_LIST);
const time = z.number().int().nonnegative();

export const producerMemorySchema = z.strictObject({
  taste: list,
  artists: z.string().max(MAX_ARTISTS_CHARS),
  experience: z.enum(EXPERIENCE_LEVELS).nullable(),
  goal: z.enum(PRODUCER_GOALS).nullable(),
  learn: list,
  gear: list,
});

export const memoryNoteSchema = z.strictObject({
  id: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(MAX_NOTE_CHARS),
  createdAt: time,
});

/** A profile's fields, as a caller hands one over to be saved. */
export const producerProfileSchema = z.strictObject({
  onboarding: z.enum(ONBOARDING_OUTCOMES).nullable(),
  onboardedAt: time.nullable(),
  memory: producerMemorySchema,
  notes: z.array(memoryNoteSchema).max(MAX_MEMORY_NOTES),
  laterQuestions: z
    .array(z.enum(ONBOARDING_QUESTION_IDS))
    .max(ONBOARDING_QUESTION_IDS.length),
  validationConsent: z.boolean(),
  lastNudgeDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  modifiedAt: time,
});

const profileDocumentSchema = producerProfileSchema.extend({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
});

/** The stored body of a profile. */
export function encodeProfile(profile: ProducerProfile): JsonObject {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    onboarding: profile.onboarding,
    onboardedAt: profile.onboardedAt,
    memory: {
      taste: [...profile.memory.taste],
      artists: profile.memory.artists,
      experience: profile.memory.experience,
      goal: profile.memory.goal,
      learn: [...profile.memory.learn],
      gear: [...profile.memory.gear],
    },
    notes: profile.notes.map((note) => ({
      id: note.id,
      text: note.text,
      createdAt: note.createdAt,
    })),
    laterQuestions: [...profile.laterQuestions],
    validationConsent: profile.validationConsent,
    lastNudgeDay: profile.lastNudgeDay,
    modifiedAt: profile.modifiedAt,
  };
}

/**
 * Reads a stored profile, or `null` when the document is not one this build
 * understands. Never repairs: a profile that does not parse is refused whole.
 */
export function decodeProfile(data: unknown): ProducerProfile | null {
  const parsed = profileDocumentSchema.safeParse(data);
  if (!parsed.success) return null;
  const { schemaVersion: _version, ...profile } = parsed.data;
  return profile;
}
