/**
 * The lesson under way, kept across a reload (GRV-43): which chapter, which
 * bite, and how the chapter's bites have ended so far, so the card comes
 * back where the producer was, beside the conversation it belongs to.
 *
 * Kept like the conversation (`conversationStore.ts`): in this tab's
 * `sessionStorage`, one entry per account and project, so it survives a
 * reload but not the tab. A lesson that ended, or was left, is removed.
 * Whatever cannot be read back is dropped, never repaired.
 *
 * "Finish a track" (GRV-44) keeps that it is the track, and the bites its
 * chapter passed over, so after a reload a chapter's end still offers the
 * next chapter. A lesson kept before those were is a chapter alone.
 */
import { z } from "zod";
import { BITE_ENDINGS, BITE_IDS, CHAPTER_IDS } from "../../lessons/ids";
import { biteOf, type LessonState } from "../../lessons/session";

/** The prefix of every stored lesson's key. */
export const LESSON_STORAGE_PREFIX = "sg_lesson_v1";

/** The key the lesson beside the conversation kept under `conversationKey` is kept under. */
export function lessonStorageKey(conversationKey: string): string {
  return `${LESSON_STORAGE_PREFIX}|${conversationKey}`;
}

const storedLessonSchema = z.object({
  version: z.literal(1),
  chapter: z.enum(CHAPTER_IDS),
  bite: z.enum(BITE_IDS),
  endings: z.partialRecord(z.enum(BITE_IDS), z.enum(BITE_ENDINGS)),
  track: z.boolean().default(false),
  passed: z.array(z.enum(BITE_IDS)).default([]),
});

/** A lesson as it is kept. */
export type StoredLesson = Omit<z.output<typeof storedLessonSchema>, "version">;

/** A lesson to keep: outside "Finish a track", `track` and `passed` may be left out. */
export type LessonToKeep = Omit<z.input<typeof storedLessonSchema>, "version">;

/** What is kept of `state`. */
export function storedLesson(state: LessonState): StoredLesson {
  return {
    chapter: state.chapter,
    bite: biteOf(state).id,
    endings: { ...state.endings },
    track: state.track,
    passed: [...state.passed],
  };
}

/** Where a lesson is kept: one key's reads and writes. */
export interface LessonStore {
  load(key: string): StoredLesson | null;
  /** Keeps `lesson`, or with `null` forgets the one kept. */
  save(key: string, lesson: LessonToKeep | null): void;
}

/** This tab's `sessionStorage`, or `null` where there is none or reading it throws. */
function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * A store over `storage`. Storage that is missing, blocked or full keeps
 * nothing: the lesson carries on in memory.
 */
export function createLessonStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = tabStorage(),
): LessonStore {
  return {
    load(key) {
      try {
        const raw = storage?.getItem(key) ?? null;
        if (raw === null) return null;
        const parsed = storedLessonSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return null;
        const { version: _version, ...lesson } = parsed.data;
        return lesson;
      } catch {
        return null;
      }
    },
    save(key, lesson) {
      if (!storage) return;
      try {
        if (lesson === null) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify({ version: 1, ...lesson }));
      } catch {
        // Full or blocked: this page's lesson is the one in memory.
      }
    },
  };
}
