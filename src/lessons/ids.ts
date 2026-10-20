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

/** The chapters, in the order they are offered. */
export const CHAPTER_IDS = ["beat", "sound", "tour"] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];

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

export function isBiteId(value: string): value is BiteId {
  return (BITE_IDS as readonly string[]).includes(value);
}
