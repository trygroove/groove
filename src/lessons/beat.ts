/**
 * "Make a beat" (GRV-43): pick a kick in the Library, write the kick's
 * pattern, hear it, add the backbeat and the hats, and loop it. The pattern
 * and the words follow the producer's genre (`style.ts`).
 */
import { CONTROL_PARTS, controlAddress } from "../commands/controlAddress";
import { updatePlacement } from "../commands/definitions/placements";
import { addTrack } from "../commands/definitions/tracks";
import type { Project } from "../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createNoteClip,
  createPlacement,
  createTrack,
} from "../domain/factories";
import { TICKS_PER_BAR, toTicks } from "../domain/time";
import {
  anyOtherPadHits,
  beatTrack,
  type DrumTrack,
  factorySound,
  hitsAll,
  kickPad,
  noteClips,
  writeHits,
  writePadPart,
} from "./drums";
import { BEAT_PATTERNS, stepList } from "./style";
import type { LessonBite, LessonChapter, LessonStep, LessonWorld } from "./types";

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
    `Put the [kick](kick) on every [beat](beat): [steps](step) ${steps} on ${where} row, in the [Sequence view](sequence). That's [four on the floor](four-on-the-floor).`,
  boom_bap: (where: string, steps: string) =>
    `Put the [kick](kick) on beat 1 and on the "and" of beat 3: [steps](step) ${steps} on ${where} row, in the [Sequence view](sequence). That's the [boom bap](boom-bap) kick.`,
  trap: (where: string, steps: string) =>
    `Put the [kick](kick) on beat 1 and on the "and" of beat 2: [steps](step) ${steps} on ${where} row, in the [Sequence view](sequence). Sparse kicks leave room for [trap](trap)'s 808s.`,
} as const;

const kick: LessonBite = {
  id: "beat-kick",
  chapter: "beat",
  title: "The kick pattern",
  skill: "placing the kick on the steps that give a beat its feel",
  quiz: "In a bar of sixteen steps, which step is beat 3 on? (Step 9.)",
  steps: [
    addDrums,
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
      done(world, _start, settings) {
        const track = beatOf(world);
        const pad = track ? kickPad(track) : null;
        return (
          track !== null &&
          pad !== null &&
          hitsAll(world.project, track, pad.id, BEAT_PATTERNS[settings.style].kick)
        );
      },
      showMe(world, settings, context) {
        const track = beatOf(world);
        const pad = track ? kickPad(track) : null;
        if (!track || !pad) return null;
        const commands = writeHits(
          world.project,
          track,
          pad.id,
          BEAT_PATTERNS[settings.style].kick,
          context,
        );
        return commands.length > 0 ? { kind: "commands", commands } : null;
      },
    },
  ],
};

const play: LessonBite = {
  id: "beat-play",
  chapter: "beat",
  title: "Hear it",
  skill: "playing the song and listening to what the beat does",
  quiz: "Which key starts and stops the song? (Space.)",
  steps: [
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
    {
      id: "snare",
      instruction: (_world, settings) =>
        SNARE_WORDS[settings.style](stepList(BEAT_PATTERNS[settings.style].snare)),
      target: (world) => beatNotes(world.project),
      done: (world, _start, settings) =>
        anyOtherPadHits(world.project, BEAT_PATTERNS[settings.style].snare),
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
    {
      id: "hats",
      instruction: (_world, settings) =>
        HAT_WORDS[settings.style](stepList(BEAT_PATTERNS[settings.style].hats)),
      target: (world) => beatNotes(world.project),
      done: (world, _start, settings) =>
        anyOtherPadHits(world.project, BEAT_PATTERNS[settings.style].hats),
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

const loop: LessonBite = {
  id: "beat-loop",
  chapter: "beat",
  title: "Loop it",
  skill: "looping a one-bar clip so the beat runs on in the arrangement",
  quiz: "How do you make one bar play for four on the arrangement? (Loop its clip, and stretch it.)",
  steps: [
    addDrums,
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
