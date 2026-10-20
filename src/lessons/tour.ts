/**
 * "Tour the studio" (GRV-43): the editor's five views, one bite each. A
 * bite is done once the producer has gone to its view; Show me goes there.
 * Being on it already is not going there: a bite that starts on its own view
 * (the editor opens on the arrangement) first asks the producer to step away,
 * so they still learn the way back. Skipping that step skips the bite: there
 * is nothing left to open.
 */
import type { EditorViewName } from "../analytics/catalog";
import type { BiteId } from "./ids";
import type { LessonBite, LessonChapter } from "./types";

interface Stop {
  readonly id: BiteId;
  readonly view: EditorViewName;
  readonly title: string;
  readonly skill: string;
  /** What the view is for. */
  readonly about: string;
  /** How to get there. */
  readonly open: string;
  readonly quiz: string;
}

const STOPS: readonly Stop[] = [
  {
    id: "tour-arrangement",
    view: "arrangement",
    title: "The Arrangement",
    skill: "reading the song laid out in time",
    about:
      "The [arrangement](arrangement) is your whole song in time: a row per track, its [clips](clip) along it.",
    open: "Open it with 1, or its tile in the [dock](dock).",
    quiz: "Which key takes you to the arrangement? (1.)",
  },
  {
    id: "tour-sequence",
    view: "sequence",
    title: "The Sequence view",
    skill: "writing a clip's notes",
    about:
      "The [Sequence view](sequence) is where a clip's notes are written: steps for drums, a piano roll for the rest.",
    open: "Open it with 2.",
    quiz: "Where do you draw a clip's notes? (The Sequence view, key 2.)",
  },
  {
    id: "tour-instrument",
    view: "instrument",
    title: "The Instrument view",
    skill: "finding a track's instrument and its controls",
    about:
      "The [Instrument view](instrument) is the selected track's instrument, every control that shapes its sound.",
    open: "Open it with 3.",
    quiz: "Which view shapes the selected track's sound? (The Instrument view, key 3.)",
  },
  {
    id: "tour-library",
    view: "library",
    title: "The Library",
    skill: "browsing sounds and packs",
    about: "The [Library](library) holds every sound, in packs: press one to hear it.",
    open: "Open it with 4.",
    quiz: "Where do you look for a new sound? (The Library, key 4.)",
  },
  {
    id: "tour-mixer",
    view: "mixer",
    title: "The Mixer",
    skill: "balancing tracks and adding new ones",
    about:
      "The [Mixer](mixer) puts every track's volume, pan and effects side by side, and it's where new tracks come from.",
    open: "Open it with 5.",
    quiz: "Where do you add a new track? (The Mixer, key 5.)",
  },
];

/** Where Show me steps away to, from `view`. */
const elsewhere = (view: EditorViewName): EditorViewName =>
  view === "arrangement" ? "sequence" : "arrangement";

function bite(stop: Stop): LessonBite {
  return {
    id: stop.id,
    chapter: "tour",
    title: stop.title,
    skill: stop.skill,
    quiz: stop.quiz,
    steps: [
      {
        id: "away",
        applies: (world) => world.view === stop.view,
        instruction: () =>
          `${stop.about} You're on it already, so step away first: go to any other view, then come back.`,
        target: () => null,
        done: (world) => world.view !== stop.view,
        showMe: () => ({ kind: "view", view: elsewhere(stop.view) }),
      },
      {
        id: "open",
        // Only from another view: once "away" is skipped, the producer is
        // still on this one, and the bite ends with the skip.
        applies: (world) => world.view !== stop.view,
        instruction: () => `${stop.about} ${stop.open}`,
        target: () => null,
        done: (world, start) => world.view === stop.view && start.view !== stop.view,
        showMe: () => ({ kind: "view", view: stop.view }),
      },
    ],
  };
}

export const TOUR_CHAPTER: LessonChapter = {
  id: "tour",
  title: "Tour the studio",
  summary: "the five views of the studio, and the key for each",
  bites: STOPS.map(bite),
};
