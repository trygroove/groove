/**
 * "Make a beat" (GRV-43): pick a kick in the Library, write the kick's
 * pattern, set the tempo and hear it, add the backbeat and the hats, and
 * loop it. The pattern
 * and the words follow the producer's genre (`style.ts`).
 */
import { CONTROL_PARTS, controlAddress } from "../commands/controlAddress";
import { parameterTargetControl, setParameter } from "../commands/definitions/parameters";
import { updatePlacement } from "../commands/definitions/placements";
import { addTrack } from "../commands/definitions/tracks";
import type { DrumPad, Project } from "../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createNoteClip,
  createPlacement,
  createTrack,
} from "../domain/factories";
import { SONG_TEMPO } from "../domain/parameters";
import { TICKS_PER_BAR, toTicks } from "../domain/time";
import {
  anyOtherPadHits,
  beatTrack,
  clearPad,
  type DrumRole,
  type DrumTrack,
  factorySound,
  hitsExactly,
  isDrumTrack,
  kickPad,
  noteClips,
  otherPadsHitting,
  padSilent,
  writePadPart,
  writePattern,
} from "./drums";
import { BEAT_PATTERNS, stepList } from "./style";
import type {
  LessonBite,
  LessonChapter,
  LessonSettings,
  LessonStep,
  LessonWorld,
} from "./types";

/** How long the loop bite asks the beat to run. */
export const LOOP_BARS = 4;

const beatOf = (world: LessonWorld): DrumTrack | null => beatTrack(world.project);

/** "BD's BD pad", or "BD's pad" when the two share a name. */
function padName(track: DrumTrack): string {
  const pad = kickPad(track);
  if (!pad || pad.name === track.name) return `${track.name}'s pad`;
  return `${track.name}'s ${pad.name} pad`;
}

/** Passed over unless the song has no drum machine for the lesson. */
const addDrums: LessonStep = {
  id: "drums",
  applies: (world) => beatOf(world) === null,
  instruction: () =>
    "First, a drum machine: in the [Mixer](mixer), press Add drum machine track.",
  target: () => controlAddress("song", CONTROL_PARTS.tracks),
  done: (world) => beatOf(world) !== null,
  showMe(world, _settings, context) {
    const { assetId, commands } = factorySound(world.project, "starterKick", context);
    const pad = createDrumPad(context, { name: "Kick", assetId });
    const track = createTrack(context, {
      name: "Drums",
      order: world.project.song.tracks.length,
      instrument: createDrumMachineInstrument([pad]),
    });
    const clip = createNoteClip(context, {
      trackId: track.id,
      name: "Beat",
      lengthTicks: TICKS_PER_BAR,
      color: track.color,
    });
    const placement = createPlacement(context, {
      clipId: clip.id,
      trackId: track.id,
      startTicks: 0,
      durationTicks: TICKS_PER_BAR,
    });
    return {
      kind: "commands",
      commands: [
        ...commands,
        addTrack(track, { clips: [clip], placements: [placement] }),
      ],
    };
  },
};

const library: LessonBite = {
  id: "beat-library",
  chapter: "beat",
  title: "Pick a kick",
  skill: "finding a sound in the Library by ear and putting it on a drum pad",
  quiz: "Where in Groove do you find a new sound for a pad? (The Library, key 4.)",
  steps: [
    addDrums,
    {
      id: "kick",
      instruction: (world) => {
        const track = beatOf(world);
        const where = track ? padName(track) : "the kick pad";
        return `Open the [Library](library) (press 4), listen to a few kicks, and put the [kick](kick) you like best on ${where}.`;
      },
      target(world) {
        const pad = (() => {
          const track = beatOf(world);
          return track ? kickPad(track) : null;
        })();
        return pad ? controlAddress(pad.id, CONTROL_PARTS.sample) : null;
      },
      done(world, start) {
        const before = beatOf(start);
        const pad = before ? kickPad(before) : null;
        if (!pad) return false;
        const now = beatOf(world)?.instrument.pads.find((found) => found.id === pad.id);
        return now !== undefined && now.assetId !== null && now.assetId !== pad.assetId;
      },
      showMe(world) {
        const track = beatOf(world);
        const pad = track ? kickPad(track) : null;
        return track && pad
          ? { kind: "sound", role: "kick", trackId: track.id, padId: pad.id }
          : null;
      },
    },
  ],
};

/** The clip the beat is written in, for marking where to act. */
function beatNotes(project: Project): ReturnType<typeof controlAddress> | null {
  const track = beatTrack(project);
  const clip = track ? noteClips(project, track)[0] : undefined;
  return clip ? controlAddress(clip.id, CONTROL_PARTS.notes) : null;
}

const KICK_WORDS = {
  four_on_the_floor: (where: string, steps: string) =>
    `Put the [kick](kick) on every [beat](beat): [steps](step) ${steps} on ${where} row, and nothing else on it, in the [Sequence view](sequence). That's [four on the floor](four-on-the-floor).`,
  boom_bap: (where: string, steps: string) =>
    `Put the [kick](kick) on beat 1 and on the "and" of beat 3: [steps](step) ${steps} on ${where} row, in the [Sequence view](sequence), and turn its other steps off. That's the [boom bap](boom-bap) kick.`,
  trap: (where: string, steps: string) =>
    `Put the [kick](kick) on beat 1 and on the "and" of beat 2: [steps](step) ${steps} on ${where} row, in the [Sequence view](sequence), and turn its other steps off. Sparse kicks leave room for [trap](trap)'s 808s.`,
} as const;

/** The beat's drum machine and its kick pad, when it has both. */
function kickOf(world: LessonWorld): { track: DrumTrack; pad: DrumPad } | null {
  const track = beatOf(world);
  const pad = track ? kickPad(track) : null;
  return track && pad ? { track, pad } : null;
}

/** Whether the kick already plays the style's pattern and nothing else. */
function kickInPlace(world: LessonWorld, settings: LessonSettings): boolean {
  const found = kickOf(world);
  return (
    found !== null &&
    hitsExactly(
      world.project,
      found.track,
      found.pad.id,
      BEAT_PATTERNS[settings.style].kick,
    )
  );
}

/**
 * Run only when the kick already plays the pattern, as the starter's four on
 * the floor does for house: the producer clears the row so the next step has
 * them build it themselves, rather than finding it done.
 */
const clearKick: LessonStep = {
  id: "clear",
  applies: kickInPlace,
  instruction(world, settings) {
    const track = beatOf(world);
    const where = track ? `${track.name}'s` : "the kick's";
    const { term, termId } = BEAT_PATTERNS[settings.style];
    return `${where[0].toUpperCase()}${where.slice(1)} row already plays [${term}](${termId}). To build it yourself, clear the row first: turn each of its [steps](step) off in the [Sequence view](sequence).`;
  },
  target: (world) => beatNotes(world.project),
  done(world) {
    const found = kickOf(world);
    return found !== null && padSilent(world.project, found.track, found.pad.id);
  },
  showMe(world) {
    const found = kickOf(world);
    if (!found) return null;
    const commands = clearPad(world.project, found.track, found.pad.id);
    return commands.length > 0 ? { kind: "commands", commands } : null;
  },
};

const kick: LessonBite = {
  id: "beat-kick",
  chapter: "beat",
  title: "The kick pattern",
  skill: "placing the kick on the steps that give a beat its feel",
  quiz: "In a bar of sixteen steps, which step is beat 3 on? (Step 9.)",
  steps: [
    addDrums,
    clearKick,
    {
      id: "pattern",
      instruction(world, settings) {
        const track = beatOf(world);
        const where = track ? `${track.name}'s` : "the kick's";
        return KICK_WORDS[settings.style](
          where,
          stepList(BEAT_PATTERNS[settings.style].kick),
        );
      },
      target: (world) => beatNotes(world.project),
      done: (world, _start, settings) => kickInPlace(world, settings),
      showMe(world, settings, context) {
        const found = kickOf(world);
        if (!found) return null;
        const commands = writePattern(
          world.project,
          found.track,
          found.pad.id,
          BEAT_PATTERNS[settings.style].kick,
          context,
        );
        return commands.length > 0 ? { kind: "commands", commands } : null;
      },
    },
  ],
};

/** How far from the style's tempo the song may sit and still be at it, in BPM. */
export const TEMPO_TOLERANCE = 3;

const TEMPO_TARGET = { scope: "song", parameterId: SONG_TEMPO.id } as const;

const TEMPO_WORDS = {
  four_on_the_floor: "house sits around there, steady enough to dance to",
  boom_bap: "boom bap sits laid back, around there",
  trap: "trap sits up there, and its hats make it feel fast while the snare keeps it half-time",
} as const;

/** Whether the song is at the style's tempo, give or take {@link TEMPO_TOLERANCE}. */
export function atStyleTempo(world: LessonWorld, settings: LessonSettings): boolean {
  return (
    Math.abs(world.project.song.tempo - BEAT_PATTERNS[settings.style].tempo) <=
    TEMPO_TOLERANCE
  );
}

/** Passed over when the song is already at the style's tempo. */
const setTempo: LessonStep = {
  id: "tempo",
  applies: (world, settings) => !atStyleTempo(world, settings),
  instruction: (_world, settings) =>
    `First, the [tempo](tempo): set it to ${BEAT_PATTERNS[settings.style].tempo} BPM in the tempo field at the top of the studio. ${TEMPO_WORDS[settings.style][0].toUpperCase()}${TEMPO_WORDS[settings.style].slice(1)}.`,
  target: () => parameterTargetControl(TEMPO_TARGET),
  done: (world, _start, settings) => atStyleTempo(world, settings),
  showMe: (_world, settings) => ({
    kind: "commands",
    commands: [setParameter(TEMPO_TARGET, BEAT_PATTERNS[settings.style].tempo)],
  }),
};

const play: LessonBite = {
  id: "beat-play",
  chapter: "beat",
  title: "Hear it",
  skill:
    "setting the tempo for the style, then playing the song and listening to what the beat does",
  quiz: "Which key starts and stops the song? (Space.)",
  steps: [
    setTempo,
    {
      id: "play",
      instruction: () =>
        "Press [Play](play), or Space, and listen to your kick loop. Notice where it lands against the count.",
      target: () => null,
      done: (world) => world.playing,
      showMe: () => ({ kind: "play" }),
    },
  ],
};

/**
 * Run only when some pad already plays the part (`steps`), as when the
 * chapter is started again in a song that has it: the producer clears that
 * pad's row so the next step has them write the part themselves, rather than
 * finding it done. `part` names it in the instruction.
 */
function clearPart(
  part: string,
  steps: (settings: LessonSettings) => readonly number[],
  besides: DrumRole,
): LessonStep {
  const playing = (world: LessonWorld, settings: LessonSettings) =>
    otherPadsHitting(world.project, steps(settings), besides);
  return {
    id: "clear",
    applies: (world, settings) => playing(world, settings).length > 0,
    instruction(world, settings) {
      const found = playing(world, settings)[0];
      const where = found ? `${found.track.name}'s ${found.pad.name} row` : "A row";
      return `${where} already plays ${part}. To write it yourself, clear the row first: turn each of its [steps](step) off in the [Sequence view](sequence).`;
    },
    target: (world) => beatNotes(world.project),
    // Done once every pad that played the part as the step began is silent.
    done: (world, start, settings) =>
      playing(start, settings).every(({ track, pad }) => {
        const now = world.project.song.tracks.find((one) => one.id === track.id);
        if (!now || !isDrumTrack(now)) return true;
        return (
          !now.instrument.pads.some((one) => one.id === pad.id) ||
          padSilent(world.project, now, pad.id)
        );
      }),
    showMe(world, settings) {
      const commands = playing(world, settings).flatMap(({ track, pad }) =>
        clearPad(world.project, track, pad.id),
      );
      return commands.length > 0 ? { kind: "commands", commands } : null;
    },
  };
}

const SNARE_WORDS = {
  four_on_the_floor: (steps: string) =>
    `Add a clap on beats 2 and 4, [steps](step) ${steps}, on a pad of its own: that's the [backbeat](backbeat). In house it's usually a clap rather than a [snare](snare).`,
  boom_bap: (steps: string) =>
    `Add a [snare](snare) on beats 2 and 4, [steps](step) ${steps}, on a pad of its own: that's the [backbeat](backbeat), the "bap" in [boom bap](boom-bap).`,
  trap: (steps: string) =>
    `Add a [snare](snare) on beat 3, [step](step) ${steps}, on a pad of its own. In [trap](trap) the [backbeat](backbeat) moves to beat 3, which is what makes it feel half-time.`,
} as const;

const snare: LessonBite = {
  id: "beat-snare",
  chapter: "beat",
  title: "The backbeat",
  skill: "answering the kick with a snare or clap",
  quiz: "Which beats does a backbeat usually land on? (2 and 4.)",
  steps: [
    addDrums,
    clearPart(
      "the [backbeat](backbeat)",
      (settings) => BEAT_PATTERNS[settings.style].snare,
      "hats",
    ),
    {
      id: "snare",
      instruction: (_world, settings) =>
        SNARE_WORDS[settings.style](stepList(BEAT_PATTERNS[settings.style].snare)),
      target: (world) => beatNotes(world.project),
      done: (world, _start, settings) =>
        anyOtherPadHits(world.project, BEAT_PATTERNS[settings.style].snare, "hats"),
      showMe(world, settings, context) {
        const track = beatOf(world);
        if (!track) return null;
        const pattern = BEAT_PATTERNS[settings.style];
        const name = pattern.snareSound === "clap" ? "Clap" : "Snare";
        return {
          kind: "commands",
          commands: writePadPart(
            world.project,
            track,
            "snare",
            pattern.snareSound,
            name,
            pattern.snare,
            context,
          ),
        };
      },
    },
  ],
};

const HAT_WORDS = {
  four_on_the_floor: (steps: string) =>
    `Add [hats](hi-hat) on the [off-beats](off-beat), [steps](step) ${steps}, between the kicks. They push the groove forward.`,
  boom_bap: (steps: string) =>
    `Add [hats](hi-hat) on every eighth note, [steps](step) ${steps}, to keep time between the kick and the snare.`,
  trap: (steps: string) =>
    `Add [hats](hi-hat) on every eighth note, [steps](step) ${steps}. Then, if you like, fill a gap with a quick roll: [trap](trap) lives on them.`,
} as const;

const hats: LessonBite = {
  id: "beat-hats",
  chapter: "beat",
  title: "Hats",
  skill: "keeping time with hi-hats",
  quiz: 'What do you call the point halfway between two beats? (The off-beat, or the "and".)',
  steps: [
    addDrums,
    clearPart(
      "the [hats](hi-hat)",
      (settings) => BEAT_PATTERNS[settings.style].hats,
      "snare",
    ),
    {
      id: "hats",
      instruction: (_world, settings) =>
        HAT_WORDS[settings.style](stepList(BEAT_PATTERNS[settings.style].hats)),
      target: (world) => beatNotes(world.project),
      done: (world, _start, settings) =>
        anyOtherPadHits(world.project, BEAT_PATTERNS[settings.style].hats, "snare"),
      showMe(world, settings, context) {
        const track = beatOf(world);
        if (!track) return null;
        return {
          kind: "commands",
          commands: writePadPart(
            world.project,
            track,
            "hats",
            "hats",
            "Hat",
            BEAT_PATTERNS[settings.style].hats,
            context,
          ),
        };
      },
    },
  ],
};

/** How many ticks of the song `track`'s placements cover, overlaps counted once. */
export function coveredTicks(project: Project, trackId: string): number {
  const spans = project.song.placements
    .filter((placement) => placement.trackId === trackId)
    .map((placement) => [
      placement.startTicks,
      placement.startTicks + placement.durationTicks,
    ])
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let reach = 0;
  for (const [start, end] of spans) {
    const from = Math.max(start, reach);
    if (end > from) covered += end - from;
    reach = Math.max(reach, end);
  }
  return covered;
}

/** Whether the beat's track already runs for {@link LOOP_BARS} bars. */
function loopInPlace(world: LessonWorld): boolean {
  const track = beatOf(world);
  return (
    track !== null && coveredTicks(world.project, track.id) >= LOOP_BARS * TICKS_PER_BAR
  );
}

/** The beat's placements, in song order. */
function beatPlacements(world: LessonWorld) {
  const track = beatOf(world);
  return track
    ? world.project.song.placements
        .filter((placement) => placement.trackId === track.id)
        .sort((a, b) => a.startTicks - b.startTicks)
    : [];
}

/**
 * Run only when the beat already runs for the bars the bite asks for, as
 * when the chapter is started again in the same song: the producer shortens
 * it back to a bar, so the next step has them loop it themselves.
 */
const shortenLoop: LessonStep = {
  id: "shorten",
  applies: loopInPlace,
  instruction(world) {
    const track = beatOf(world);
    const name = track ? `${track.name}'s` : "The beat's";
    return `${name} [clip](clip) already runs for ${LOOP_BARS} bars or more. To loop it yourself, first drag its end back to bar 2 on the [arrangement](arrangement).`;
  },
  target(world) {
    const first = beatPlacements(world)[0];
    return first ? controlAddress(first.id, CONTROL_PARTS.placement) : null;
  },
  done: (world) => !loopInPlace(world),
  showMe(world) {
    const placements = beatPlacements(world);
    const only = placements.length === 1 ? placements[0] : undefined;
    return only
      ? {
          kind: "commands",
          commands: [
            updatePlacement(only.id, {
              durationTicks: toTicks(TICKS_PER_BAR),
              looped: false,
            }),
          ],
        }
      : null;
  },
};

const loop: LessonBite = {
  id: "beat-loop",
  chapter: "beat",
  title: "Loop it",
  skill: "looping a one-bar clip so the beat runs on in the arrangement",
  quiz: "How do you make one bar play for four on the arrangement? (Loop its clip, and stretch it.)",
  steps: [
    addDrums,
    shortenLoop,
    {
      id: "loop",
      instruction: (world) => {
        const track = beatOf(world);
        const name = track ? `${track.name}'s` : "the beat's";
        return `Make the beat run for ${LOOP_BARS} bars: on the [arrangement](arrangement), loop ${name} [clip](clip) and drag its end out to bar ${LOOP_BARS + 1}.`;
      },
      target(world) {
        const track = beatOf(world);
        const first = track
          ? world.project.song.placements
              .filter((placement) => placement.trackId === track.id)
              .sort((a, b) => a.startTicks - b.startTicks)[0]
          : undefined;
        return first ? controlAddress(first.id, CONTROL_PARTS.placement) : null;
      },
      done(world) {
        const track = beatOf(world);
        return (
          track !== null &&
          coveredTicks(world.project, track.id) >= LOOP_BARS * TICKS_PER_BAR
        );
      },
      showMe(world) {
        const track = beatOf(world);
        if (!track) return null;
        const placements = world.project.song.placements
          .filter((placement) => placement.trackId === track.id)
          .sort((a, b) => a.startTicks - b.startTicks);
        const first = placements[0];
        if (!first) return null;
        const room =
          (placements[1]?.startTicks ?? Number.POSITIVE_INFINITY) - first.startTicks;
        if (room < LOOP_BARS * TICKS_PER_BAR) return null;
        return {
          kind: "commands",
          commands: [
            updatePlacement(first.id, {
              durationTicks: toTicks(LOOP_BARS * TICKS_PER_BAR),
              looped: true,
            }),
          ],
        };
      },
    },
  ],
};

export const BEAT_CHAPTER: LessonChapter = {
  id: "beat",
  title: "Make a beat",
  summary: "a one-bar beat, kick, backbeat and hats, looped for four bars",
  bites: [library, kick, play, snare, hats, loop],
};
