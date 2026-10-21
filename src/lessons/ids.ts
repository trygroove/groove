/**
 * The lessons' chapters and bites by ID (GRV-43), and nothing else, so the
 * analytics catalog, the profile and the assistant's protocol can name them
 * without importing the lessons themselves.
 *
 * An ID is published: it is stored on the producer's profile as done
 * (`lessonsDone`) and sent in `lesson_*` analytics. Adding one is routine;
 * renaming or removing one is a task of its own, since a stored ID that no
 * longer names a bite would quietly be undone.
 */

/**
 * Every chapter: the three taught on their own (GRV-43), then the four only
 * "Finish a track" teaches (GRV-44), which also starts with "beat".
 */
export const CHAPTER_IDS = [
  "beat",
  "sound",
  "tour",
  "bass",
  "chords",
  "arrange",
  "mix",
] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];

/** The chapters a lesson can be on its own (GRV-43), in the order they are offered. */
export const SOLO_CHAPTER_IDS = [
  "beat",
  "sound",
  "tour",
] as const satisfies readonly ChapterId[];
export type SoloChapterId = (typeof SOLO_CHAPTER_IDS)[number];

/**
 * "Finish a track" (GRV-44): five chapters, in order, from a beat to stems.
 * The first is "Make a beat", the chapter taught on its own too; the rest are
 * taught only here.
 */
export const TRACK_CHAPTER_IDS = [
  "beat",
  "bass",
  "chords",
  "arrange",
  "mix",
] as const satisfies readonly ChapterId[];
export type TrackChapterId = (typeof TRACK_CHAPTER_IDS)[number];

/**
 * Saved with the bites done (`lessonsDone`) once "Finish a track" starts, so
 * the lesson is under way, and resumable, even while it is still on "Make a
 * beat", whose bites alone say nothing about it. Shaped like a bite ID, as
 * the profile requires, and never one.
 */
export const TRACK_UNDER_WAY = "track-under-way";

/** Every bite, chapter by chapter, in the order each chapter teaches them. */
export const BITE_IDS = [
  "beat-library",
  "beat-kick",
  "beat-play",
  "beat-snare",
  "beat-hats",
  "beat-loop",
  "sound-wave",
  "sound-filter",
  "sound-pluck",
  "tour-arrangement",
  "tour-sequence",
  "tour-instrument",
  "tour-library",
  "tour-mixer",
  "bass-key",
  "bass-line",
  "bass-sound",
  "chords-loop",
  "chords-hook",
  "chords-pluck",
  "arrange-copy",
  "arrange-intro",
  "arrange-breakdown",
  "arrange-drop",
  "arrange-outro",
  "mix-balance",
  "mix-pan",
  "mix-reverb",
  "mix-master",
  "mix-export",
] as const;
export type BiteId = (typeof BITE_IDS)[number];

/** How a bite ended: done in the editor, shown by Show me, or skipped. */
export const BITE_ENDINGS = ["did_it", "show_me", "skipped"] as const;
export type BiteEnding = (typeof BITE_ENDINGS)[number];

/** Where a bite was started from. */
export const LESSON_SOURCES = ["asked", "onboarding", "nudge", "next"] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];

export function isChapterId(value: string): value is ChapterId {
  return (CHAPTER_IDS as readonly string[]).includes(value);
}

export function isTrackChapterId(value: string): value is TrackChapterId {
  return (TRACK_CHAPTER_IDS as readonly string[]).includes(value);
}

export function isBiteId(value: string): value is BiteId {
  return (BITE_IDS as readonly string[]).includes(value);
}

/** The beats "Make a beat" teaches, by the genre a producer loves (`style.ts`). */
export const BEAT_STYLES = ["four_on_the_floor", "boom_bap", "trap"] as const;
export type BeatStyle = (typeof BEAT_STYLES)[number];

/** Where a lesson stands as a turn is sent (`cue.ts`). */
export const LESSON_MOMENTS = [
  "bite_started",
  "step_done",
  "bite_done",
  "chapter_done",
  "track_done",
  "under_way",
] as const;
export type LessonMoment = (typeof LESSON_MOMENTS)[number];

/**
 * At most this many earlier moments ride along with one lesson turn
 * (`cue.ts`, `foldTurns`); older ones are dropped.
 */
export const MAX_EARLIER = 6;
