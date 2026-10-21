/**
 * "Arrange, subtractively" (GRV-44), the fourth chapter of "Finish a track":
 * the way most producers really arrange. First the whole loop is copied out
 * across {@link SONG_BARS} bars with everything playing; then parts are taken
 * away to make the song. Each bite is one deletion, and the producer hears
 * the shape appear: the hook and the chords out of the intro, the drums out
 * of the breakdown, everything back for the drop, and the end cut to a short
 * outro.
 *
 * Its predicates read the arrangement by what is absent from it: no hook or
 * chords in the intro's bars, no drums in the breakdown's.
 */
import { CONTROL_PARTS, controlAddress } from "../commands/controlAddress";
import type { Project, Track } from "../domain/entities";
import { TICKS_PER_BAR } from "../domain/time";
import {
  arrangedDrums,
  arrangedParts,
  arrangedTracks,
  type BarSpan,
  clearSpan,
  fillSpan,
  fills,
  playsIn,
  songEnd,
} from "./parts";
import type { LessonBite, LessonChapter, LessonStep, LessonWorld } from "./types";

/** How far the loop is copied out, in bars. */
export const SONG_BARS = 32;
/** The sections, a run of bars each (bar 1 is 0). */
export const INTRO: BarSpan = { from: 0, to: 8 };
export const BREAKDOWN: BarSpan = { from: 8, to: 16 };
export const DROP: BarSpan = { from: 16, to: 24 };
export const OUTRO: BarSpan = { from: 24, to: 28 };
/** Where the song ends once the outro is cut, in bars. */
export const END_BAR = OUTRO.to;

const WHOLE: BarSpan = { from: 0, to: SONG_BARS };

/** "bars 9 to 16", as the arrangement's ruler counts them. */
export function barsWords(span: BarSpan): string {
  return `bars ${span.from + 1} to ${span.to}`;
}

/** Whether every part of the song plays through all of `span`. */
export function everythingIn(project: Project, span: BarSpan): boolean {
  return arrangedTracks(project).every((track) => fills(project, track.id, span));
}

/** Whether anything at all plays in `span`. */
function somethingIn(project: Project, span: BarSpan): boolean {
  return arrangedTracks(project).some((track) => playsIn(project, track.id, span));
}

/** Whether the hook and the chords are out of the intro, and something plays in it. */
export function introMade(project: Project): boolean {
  return (
    arrangedParts(project, ["hook", "chords"]).every(
      (track) => !playsIn(project, track.id, INTRO),
    ) && somethingIn(project, INTRO)
  );
}

/** Whether no drums play in the breakdown, and something else does. */
export function breakdownMade(project: Project): boolean {
  return (
    arrangedDrums(project).every((track) => !playsIn(project, track.id, BREAKDOWN)) &&
    somethingIn(project, BREAKDOWN)
  );
}

/** Whether the song ends with the outro, and something plays in the outro. */
export function outroMade(project: Project): boolean {
  return songEnd(project) <= END_BAR * TICKS_PER_BAR && somethingIn(project, OUTRO);
}

/** The first clip on the arrangement, for the mark. */
function firstPlacement(world: LessonWorld) {
  const first = [...world.project.song.placements].sort(
    (a, b) => a.startTicks - b.startTicks,
  )[0];
  return first ? controlAddress(first.id, CONTROL_PARTS.placement) : null;
}

/** A bite's one deletion: `span`'s bars cleared of what `tracks` picks. */
function deletion(
  id: string,
  instruction: string,
  made: (project: Project) => boolean,
  tracks: (project: Project) => readonly Track[],
  span: (project: Project) => BarSpan,
): LessonStep {
  return {
    id,
    instruction: () => instruction,
    target: firstPlacement,
    done: (world) => made(world.project),
    showMe(world, _settings, context) {
      const commands = clearSpan(
        world.project,
        tracks(world.project).map((track) => track.id),
        span(world.project),
        context,
      );
      return commands.length > 0 ? { kind: "commands", commands } : null;
    },
  };
}

const copy: LessonBite = {
  id: "arrange-copy",
  chapter: "arrange",
  title: "Copy the loop out",
  skill:
    "copying the full loop across the whole song first, so arranging is taking parts away rather than building them up",
  quiz: "Why start an arrangement from the full loop? (It's the ceiling: every section is the loop with something taken away, which is faster than building each one up.)",
  steps: [
    {
      id: "copy",
      instruction: () =>
        `Copy the whole loop out to bar ${SONG_BARS + 1} on the [arrangement](arrangement), every part playing all the way: select the clips and [duplicate](duplicate) them (⌘D or Ctrl+D) until they reach it, or drag each looped clip's end out. The full loop is the ceiling; the song is what you take away from it.`,
      target: firstPlacement,
      done: (world) => everythingIn(world.project, WHOLE),
      showMe(world, _settings, context) {
        const commands = arrangedTracks(world.project)
          .filter((track) => !fills(world.project, track.id, WHOLE))
          .flatMap((track) => fillSpan(world.project, track, WHOLE, context));
        return commands.length > 0 ? { kind: "commands", commands } : null;
      },
    },
  ],
};

const intro: LessonBite = {
  id: "arrange-intro",
  chapter: "arrange",
  title: "An intro",
  skill: "making an intro by taking the hook and the chords out of the first bars",
  quiz: "What does an intro hold back? (The hook: the beat and the bass set the groove, and the hook arrives later as the payoff.)",
  steps: [
    deletion(
      "intro",
      `Make ${barsWords(INTRO)} an [intro](intro): take the [hook](hook) and the [chords](chord) out of them, so the beat and the bass play alone. Split their clips at bar ${INTRO.to + 1} (E) and delete what's before it.`,
      introMade,
      (project) => arrangedParts(project, ["hook", "chords"]),
      () => INTRO,
    ),
  ],
};

const breakdown: LessonBite = {
  id: "arrange-breakdown",
  chapter: "arrange",
  title: "A breakdown",
  skill: "making a breakdown by pulling the drums out",
  quiz: "Why pull the drums out before a drop? (The space makes the listener miss them, so their return hits harder.)",
  steps: [
    deletion(
      "breakdown",
      `Make ${barsWords(BREAKDOWN)} a [breakdown](breakdown): take the drums out of them, so the chords and the hook float on their own. Split the beat's clips at bars ${BREAKDOWN.from + 1} and ${BREAKDOWN.to + 1} and delete what's between.`,
      breakdownMade,
      arrangedDrums,
      () => BREAKDOWN,
    ),
  ],
};

const drop: LessonBite = {
  id: "arrange-drop",
  chapter: "arrange",
  title: "The drop",
  skill: "bringing everything back at once for the drop, and hearing the contrast",
  quiz: "What makes a drop feel big? (Everything returns at once after the breakdown took something away.)",
  steps: [
    {
      id: "back",
      applies: (world) => !everythingIn(world.project, DROP),
      instruction: () =>
        `Bring everything back for ${barsWords(DROP)}, the [drop](drop): every part should play all the way through them.`,
      target: firstPlacement,
      done: (world) => everythingIn(world.project, DROP),
      showMe(world, _settings, context) {
        const commands = arrangedTracks(world.project)
          .filter((track) => !fills(world.project, track.id, DROP))
          .flatMap((track) => fillSpan(world.project, track, DROP, context));
        return commands.length > 0 ? { kind: "commands", commands } : null;
      },
    },
    {
      id: "listen",
      instruction: () =>
        `Play from bar ${DROP.from - 3} and hear the breakdown end and everything come back at bar ${DROP.from + 1}: that's the [drop](drop). Click the ruler at bar ${DROP.from - 3} to put the playhead there, then press [Play](play).`,
      target: () => null,
      done: (world) => world.playing && world.bar >= DROP.from && world.bar < DROP.to,
      showMe: () => ({ kind: "play", from: (DROP.from - 4) * TICKS_PER_BAR }),
    },
  ],
};

const outro: LessonBite = {
  id: "arrange-outro",
  chapter: "arrange",
  title: "A short outro",
  skill: "ending the song with a short outro instead of letting the loop run on",
  quiz: "Why give a song an outro? (It tells the listener it's ending, and gives a DJ bars to mix out of.)",
  steps: [
    deletion(
      "outro",
      `Cut the song to a short [outro](outro): delete everything after bar ${END_BAR}, so ${barsWords(OUTRO)} play out and the song ends there. Split the clips at bar ${END_BAR + 1} and delete what's after it.`,
      outroMade,
      arrangedTracks,
      (project) => ({
        from: END_BAR,
        to: Math.max(END_BAR + 1, Math.ceil(songEnd(project) / TICKS_PER_BAR)),
      }),
    ),
  ],
};

export const ARRANGE_CHAPTER: LessonChapter = {
  id: "arrange",
  title: "Arrange, subtractively",
  summary:
    "the loop copied across the song, then parts taken away for an intro, a breakdown, a drop and an outro",
  bites: [copy, intro, breakdown, drop, outro],
};
