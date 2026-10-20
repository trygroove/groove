/**
 * What a lesson tells Coproducer (GRV-43): with each turn while a lesson is
 * under way, a {@link LessonCue} saying where it stands and what just
 * happened; and, as the turn's message, one short line the conversation
 * shows. Coproducer writes the words: explaining the step, commenting on
 * what the producer did (`changes`), celebrating a finished bite, perhaps
 * one quiz question, and a wrap-up with pointers at the chapter's end.
 *
 * Everything here is ours (titles, instructions, the changes' wording)
 * except the track and pad names in `changes`, which the project context
 * already carries to the same provider.
 */
import { chapter } from "./chapters";
import type { BiteEnding, BiteId, ChapterId } from "./ids";
import {
  biteOf,
  chapterOf,
  type LessonEvent,
  type LessonState,
  stepWords,
} from "./session";
import type { BeatStyle } from "./style";
import type { LessonSettings } from "./types";

/** Where the lesson stands as a turn is sent. */
export const LESSON_MOMENTS = [
  "bite_started",
  "step_done",
  "bite_done",
  "chapter_done",
  "under_way",
] as const;
export type LessonMoment = (typeof LESSON_MOMENTS)[number];

export interface LessonCue {
  readonly chapterId: ChapterId;
  readonly chapter: string;
  readonly biteId: BiteId;
  readonly bite: string;
  /** The skill the bite teaches. */
  readonly skill: string;
  /** The bite's place in the chapter, from 1, and how many there are. */
  readonly biteNumber: number;
  readonly biteCount: number;
  readonly moment: LessonMoment;
  /** How the step or bite just ended, for `step_done`, `bite_done` and `chapter_done`. */
  readonly how: BiteEnding | null;
  /** The step under way, in plain words, or null between bites. */
  readonly step: string | null;
  /** What the producer changed during what just ended, a line each. */
  readonly changes: readonly string[];
  /** The beat the chapter teaches, for "Make a beat"; null otherwise. */
  readonly style: BeatStyle | null;
  /** The bite's quiz question and answer, once it is over. */
  readonly quiz: string | null;
  /** The next bite's title after a bite; a few pointers after the chapter. */
  readonly next: readonly string[];
}

/** Where a producer might go after each chapter, besides the other chapters. */
const POINTERS: Readonly<Record<ChapterId, readonly string[]>> = {
  beat: [
    "Add a bassline under the beat",
    "Roll new hat patterns from the Generate panel under the step grid",
  ],
  sound: [
    "Write a melody for the pluck in the piano roll",
    "Add a delay to the pluck in the Mixer",
  ],
  tour: ["Ask Coproducer for a loop to start from"],
};

/**
 * The pointers after `chapterId`: the chapters not yet finished (by `done`),
 * then its own related skills, at most three.
 */
export function wrapUpPointers(chapterId: ChapterId, done: readonly string[]): string[] {
  const finished = new Set(done);
  const others = (["beat", "sound", "tour"] as const)
    .filter((id) => id !== chapterId)
    .map((id) => chapter(id))
    .filter((one) => one.bites.some((each) => !finished.has(each.id)))
    .map((one) => `The "${one.title}" chapter: ${one.summary}`);
  return [...others, ...POINTERS[chapterId]].slice(0, 3);
}

const HOW_WORDS: Readonly<Record<Exclude<BiteEnding, "skipped">, string>> = {
  did_it: "I did it myself",
  show_me: "you showed me",
};

/**
 * The cue for a turn: `event` is what just happened, or null for a turn the
 * producer sent themselves while the lesson is under way. `done` is every
 * bite they have been through, for the wrap-up's pointers.
 */
export function lessonCue(
  state: LessonState,
  event: LessonEvent | null,
  settings: LessonSettings,
  done: readonly string[],
): LessonCue {
  const lessonChapter = chapterOf(state);
  const lessonBite = biteOf(state);
  const moment: LessonMoment =
    event === null
      ? "under_way"
      : event.kind === "bite_done" && event.chapterDone
        ? "chapter_done"
        : event.kind;
  const over = event?.kind === "bite_done";
  const following = lessonChapter.bites[state.biteIndex + 1];
  return {
    chapterId: lessonChapter.id,
    chapter: lessonChapter.title,
    biteId: lessonBite.id,
    bite: lessonBite.title,
    skill: lessonBite.skill,
    biteNumber: state.biteIndex + 1,
    biteCount: lessonChapter.bites.length,
    moment,
    how: event && event.kind !== "bite_started" ? event.how : null,
    step: stepWords(state),
    changes: event && event.kind !== "bite_started" ? event.changes : [],
    style: lessonChapter.id === "beat" ? settings.style : null,
    quiz: over ? lessonBite.quiz : null,
    next:
      moment === "chapter_done"
        ? wrapUpPointers(lessonChapter.id, done)
        : over && following
          ? [following.title]
          : [],
  };
}

/** The line a lesson's turn says, as the conversation shows it. */
export function cueMessage(state: LessonState, event: LessonEvent): string {
  const lessonBite = biteOf(state);
  const title = `"${lessonBite.title}"`;
  switch (event.kind) {
    case "bite_started":
      return `Let's do ${title}.`;
    case "step_done":
      return event.how === "skipped"
        ? `Skipped that step of ${title}.`
        : `Done that step of ${title}: ${HOW_WORDS[event.how]}.`;
    case "bite_done": {
      const said =
        event.how === "skipped"
          ? `Skipped ${title}`
          : `Finished ${title}: ${HOW_WORDS[event.how]}`;
      return event.chapterDone
        ? `${said}. That was the last bite of "${chapterOf(state).title}".`
        : `${said}.`;
    }
  }
}
