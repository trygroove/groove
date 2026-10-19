/**
 * "Tour the studio" (GRV-43): the editor's five views, one bite each. A
 * bite is done once its view is on screen; Show me goes there.
 */
import type { EditorViewName } from "../analytics/catalog";
import type { BiteId } from "./ids";
import type { LessonBite, LessonChapter } from "./types";

interface Stop {
  readonly id: BiteId;
  readonly view: EditorViewName;
  readonly title: string;
  readonly skill: string;
  readonly instruction: string;
  readonly quiz: string;
}

const STOPS: readonly Stop[] = [
  {
    id: "tour-arrangement",
    view: "arrangement",
    title: "The Arrangement",
    skill: "reading the song laid out in time",
    instruction:
      "The [arrangement](arrangement) is your whole song in time: a row per track, its [clips](clip) along it. Open it with 1, or its tile in the [dock](dock).",
    quiz: "Which key takes you to the arrangement? (1.)",
  },
  {
    id: "tour-sequence",
    view: "sequence",
    title: "The Sequence view",
    skill: "writing a clip's notes",
    instruction:
      "The [Sequence view](sequence) is where a clip's notes are written: steps for drums, a piano roll for the rest. Open it with 2.",
    quiz: "Where do you draw a clip's notes? (The Sequence view, key 2.)",
  },
  {
    id: "tour-instrument",
    view: "instrument",
    title: "The Instrument view",
    skill: "finding a track's instrument and its controls",
    instruction:
      "The [Instrument view](instrument) is the selected track's instrument, every control that shapes its sound. Open it with 3.",
    quiz: "Which view shapes the selected track's sound? (The Instrument view, key 3.)",
  },
  {
    id: "tour-library",
    view: "library",
    title: "The Library",
    skill: "browsing sounds and packs",
    instruction:
      "The [Library](library) holds every sound, in packs: press one to hear it. Open it with 4.",
    quiz: "Where do you look for a new sound? (The Library, key 4.)",
  },
  {
    id: "tour-mixer",
    view: "mixer",
    title: "The Mixer",
    skill: "balancing tracks and adding new ones",
    instruction:
      "The [Mixer](mixer) puts every track's volume, pan and effects side by side, and it's where new tracks come from. Open it with 5.",
    quiz: "Where do you add a new track? (The Mixer, key 5.)",
  },
];

function bite(stop: Stop): LessonBite {
  return {
    id: stop.id,
    chapter: "tour",
    title: stop.title,
    skill: stop.skill,
    quiz: stop.quiz,
    steps: [
      {
        id: "open",
        instruction: () => stop.instruction,
        target: () => null,
        done: (world) => world.view === stop.view,
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
