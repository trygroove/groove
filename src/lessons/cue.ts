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
import { bite as biteById, chapter, lesson, TRACK_LESSON } from "./chapters";
import {
  type BeatStyle,
  type BiteEnding,
  type BiteId,
  type ChapterId,
  type LessonId,
  type LessonMoment,
  MAX_EARLIER,
  SOLO_CHAPTER_IDS,
  type SoloChapterId,
} from "./ids";
import {
  biteOf,
  chapterOf,
  followingBite,
  followingChapter,
  hasChapters,
  type LessonEvent,
  type LessonState,
  lessonOf,
  stepWords,
} from "./session";
import type { LessonSettings } from "./types";

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
  readonly changes: string[];
  /** The beat the chapter teaches, for "Make a beat"; null otherwise. */
  readonly style: BeatStyle | null;
  /** The bite's quiz question and answer, once it is over. */
  readonly quiz: string | null;
  /** The next bite's title after a bite; a few pointers after the chapter. */
  readonly next: string[];
  /**
   * "Finish a track" (GRV-44), when this is it: its title, and the chapter's
   * place in it. Null for a chapter taught on its own.
   */
  readonly track: LessonTrack | null;
  /**
   * The titles of the bites passed over as this one started, the song
   * already having them (GRV-44).
   */
  readonly passed: string[];
  /**
   * What happened since Coproducer last spoke that it has not answered yet,
   * oldest first: turns that waited while a reply was on its way, folded
   * into this one ({@link foldTurns}). Empty for a turn that did not wait.
   */
  readonly earlier: LessonEarlier[];
}

/** "Finish a track", as a cue carries it. */
export interface LessonTrack {
  readonly title: string;
  readonly chapterNumber: number;
  readonly chapterCount: number;
}

/** One moment a turn waited with, as the turn that took its place carries it. */
export interface LessonEarlier {
  readonly moment: LessonMoment;
  readonly chapter: string;
  readonly bite: string;
  readonly how: BiteEnding | null;
  readonly changes: string[];
}

/** Where a producer might go after each chapter taught alone, besides the other chapters. */
const POINTERS: Readonly<Record<SoloChapterId, readonly string[]>> = {
  beat: ["Roll new hat patterns from the Generate panel under the step grid"],
  sound: [
    "Write a melody for the pluck in the piano roll",
    "Add a delay to the pluck in the Mixer",
  ],
  tour: ["Ask Coproducer for a loop to start from"],
};

/** Where a producer might go once "Finish a track" is over (GRV-44). */
const TRACK_POINTERS: readonly string[] = [
  "Send the stems to a mix engineer, or bring them into a live set",
  "Start the next track from a loop Coproducer suggests",
];

/** "Finish a track", as a pointer to it. */
const TRACK_POINTER = `The "${TRACK_LESSON.title}" lesson: ${TRACK_LESSON.summary}`;

/**
 * The pointers after chapter `chapterIndex` of `lessonId` (GRV-43): for a
 * chapter taught alone, "Finish a track" after "Make a beat" unless one of
 * its own chapters is begun (by `done`), then the chapters taught alone not
 * yet finished, then the chapter's own related skills, at most three. Inside
 * a lesson of several chapters (GRV-44), the chapter after it; after its
 * last, where to take what it made.
 */
export function wrapUpPointers(
  lessonId: LessonId,
  chapterIndex: number,
  done: readonly string[],
): string[] {
  const finished = new Set(done);
  const definition = lesson(lessonId);
  const chapterId = definition.chapters[chapterIndex].id;
  if (hasChapters(lessonId)) {
    const following = definition.chapters[chapterIndex + 1];
    if (!following)
      return [...TRACK_POINTERS, ...soloLeft(chapterId, finished)].slice(0, 3);
    return [
      `Chapter ${chapterIndex + 2} of "${definition.title}", "${following.title}": ${following.summary}`,
    ];
  }
  const trackStarted = TRACK_LESSON.chapters
    .slice(1)
    .some((one) => one.bites.some((each) => finished.has(each.id)));
  const toTrack = chapterId === "beat" && !trackStarted ? [TRACK_POINTER] : [];
  const own = (SOLO_CHAPTER_IDS as readonly string[]).includes(chapterId)
    ? POINTERS[chapterId as SoloChapterId]
    : [];
  return [...toTrack, ...soloLeft(chapterId, finished), ...own].slice(0, 3);
}

/** The chapters taught alone, besides `chapterId`, with a bite not in `finished`. */
function soloLeft(chapterId: ChapterId, finished: ReadonlySet<string>): string[] {
  return SOLO_CHAPTER_IDS.filter((id) => id !== chapterId)
    .map((id) => chapter(id))
    .filter((one) => one.bites.some((each) => !finished.has(each.id)))
    .map((one) => `The "${one.title}" chapter: ${one.summary}`);
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
  const chapters = hasChapters(state.lessonId);
  const moment: LessonMoment =
    event === null
      ? "under_way"
      : event.kind === "bite_done" && event.lessonDone && chapters
        ? "track_done"
        : event.kind === "bite_done" && event.chapterDone
          ? "chapter_done"
          : event.kind;
  const over = event?.kind === "bite_done";
  const following = followingBite(state);
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
      moment === "chapter_done" || moment === "track_done"
        ? wrapUpPointers(state.lessonId, state.chapterIndex, done)
        : over && following
          ? [following.title]
          : [],
    track: chapters
      ? {
          title: lessonOf(state).title,
          chapterNumber: state.chapterIndex + 1,
          chapterCount: lessonOf(state).chapters.length,
        }
      : null,
    passed:
      event?.kind === "bite_started" ? event.passed.map((id) => biteById(id).title) : [],
    earlier: [],
  };
}

/** A lesson's turn: the line the conversation shows, and its cue. */
export interface LessonTurn {
  readonly text: string;
  readonly cue: LessonCue;
}

/**
 * The turns that waited while a reply was on its way, as the one turn that
 * goes once it has arrived: the newest, carrying what came before it in
 * `earlier`, so a finished bite is still celebrated and a step still
 * commented on, in the one reply that also does the newest's job. A bite's
 * intro is dropped once the producer has moved on to another bite, since it
 * no longer says anything useful; at most {@link MAX_EARLIER} moments ride
 * along, the newest of them.
 */
export function foldTurns(turns: readonly [LessonTurn, ...LessonTurn[]]): LessonTurn {
  const newest = turns[turns.length - 1];
  const kept = turns
    .slice(0, -1)
    .filter(
      ({ cue }) =>
        cue.moment !== "under_way" &&
        (cue.moment !== "bite_started" || cue.biteId === newest.cue.biteId),
    )
    .slice(-MAX_EARLIER);
  if (kept.length === 0) return newest;
  return {
    text: [...kept.map(({ text }) => text), newest.text].join(" "),
    cue: { ...newest.cue, earlier: kept.map(({ cue }) => earlierOf(cue)) },
  };
}

function earlierOf(cue: LessonCue): LessonEarlier {
  return {
    moment: cue.moment,
    chapter: cue.chapter,
    bite: cue.bite,
    how: cue.how,
    changes: cue.changes,
  };
}

/** The line a lesson's turn says, as the conversation shows it. */
export function cueMessage(state: LessonState, event: LessonEvent): string {
  const lessonBite = biteOf(state);
  const title = `"${lessonBite.title}"`;
  switch (event.kind) {
    case "bite_started":
      return event.passed.length > 0
        ? `Let's do ${title}: the song already has what comes before it.`
        : `Let's do ${title}.`;
    case "step_done":
      return event.how === "skipped"
        ? `Skipped that step of ${title}.`
        : `Done that step of ${title}: ${HOW_WORDS[event.how]}.`;
    case "bite_done": {
      const said =
        event.how === "skipped"
          ? `Skipped ${title}`
          : `Finished ${title}: ${HOW_WORDS[event.how]}`;
      const lessonTitle = lessonOf(state).title;
      if (event.lessonDone && hasChapters(state.lessonId)) {
        return `${said}. That was the last bite of "${lessonTitle}".`;
      }
      if (!event.chapterDone) return `${said}.`;
      return followingChapter(state)
        ? `${said}. That was the last bite of "${chapterOf(state).title}". Next is chapter ${state.chapterIndex + 2} of "${lessonTitle}".`
        : `${said}. That was the last bite of "${chapterOf(state).title}".`;
    }
  }
}
