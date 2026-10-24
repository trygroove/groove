/**
 * "Bass" (GRV-44), the second chapter of "Finish a track": pick the song's
 * key, write a bassline under the kick in the piano roll, and round its
 * sound off. The key follows the producer's genre (`STYLE_KEYS`), unless the
 * song already has one.
 */
import { CONTROL_PARTS, controlAddress, SONG_ENTITY } from "../commands/controlAddress";
import { addClip } from "../commands/definitions/clips";
import { setKey } from "../commands/definitions/key";
import { addNotes, removeNotes } from "../commands/definitions/notes";
import type { RawCommandInput } from "../commands/types";
import type { NoteEvent, Project, Track } from "../domain/entities";
import {
  createNoteClip,
  createNoteEvent,
  createPlacement,
  type DomainFactoryContext,
} from "../domain/factories";
import { isChromatic, isPitchInKey, type MusicalKey } from "../domain/musicalKey";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../domain/time";
import { beatTrack, kickPad, noteClips, stepsHit } from "./drums";
import {
  addPartTrack,
  degreePitch,
  keyWords,
  lessonKey,
  PART_TRACK_NAMES,
  partTrack,
  STYLE_KEYS,
} from "./parts";
import { instrumentControl, isSynthTrack, setSynth, synthCutoff } from "./synthParts";
import type { LessonBite, LessonChapter, LessonSettings, LessonStep } from "./types";

/** Below this pitch (middle C) a note is low enough for a bassline. */
export const BASS_CEILING = 60;
/** At or below this cutoff, in hertz, the bass counts as rounded off. */
export const ROUND_CUTOFF_HZ = 600;
/** What Show me turns the bass's cutoff down to. */
const SHOWN_CUTOFF_HZ = 400;
/** The C a bassline's root is counted up from: C2, so A minor's is A2. */
const BASS_C = 36;

const STYLE_KEY_WORDS = {
  four_on_the_floor:
    "Minor keys like it are home to a lot of house: dark, but not heavy.",
  boom_bap: "It suits boom bap's dusty, soulful feel.",
  trap: "It's a trap staple: low and moody.",
} as const;

const bassOf = (project: Project) => partTrack(project, "bass");

/**
 * The steps of the bar the beat's kick hits, from the first clip it plays
 * in; a kick on every beat when the song has no kick yet.
 */
export function kickSteps(project: Project): number[] {
  const track = beatTrack(project);
  const pad = track ? kickPad(track) : null;
  if (track && pad) {
    for (const clip of noteClips(project, track)) {
      const hits = [...stepsHit(clip, pad.id)].sort((a, b) => a - b);
      if (hits.length > 0) return hits;
    }
  }
  return [0, 4, 8, 12];
}

function stepOf(note: NoteEvent): number | null {
  const inBar = note.startTicks % TICKS_PER_BAR;
  return inBar % TICKS_PER_SIXTEENTH === 0 ? inBar / TICKS_PER_SIXTEENTH : null;
}

/** Whether `note` belongs in a bassline in `key`: low, and in the key. */
function fitsBass(note: NoteEvent, key: MusicalKey): boolean {
  return (
    note.trigger.kind === "pitch" &&
    note.trigger.pitch < BASS_CEILING &&
    isPitchInKey(key, note.trigger.pitch)
  );
}

/**
 * Whether one clip of the bass has a note starting on every step the kick
 * hits, and every note of it is low and in the song's key: a bassline under
 * the kick.
 */
export function bassUnderKick(project: Project, settings: LessonSettings): boolean {
  const bass = bassOf(project);
  if (!bass) return false;
  const key = lessonKey(project, settings);
  const kicks = kickSteps(project);
  return noteClips(project, bass).some((clip) => {
    if (clip.content.kind !== "notes" || clip.content.events.length === 0) return false;
    const notes = clip.content.events;
    const starts = new Set(notes.map(stepOf));
    return (
      notes.every((note) => fitsBass(note, key)) && kicks.every((k) => starts.has(k))
    );
  });
}

/** The root on each kick step, each held until the next. */
function bassline(
  project: Project,
  settings: LessonSettings,
  context: DomainFactoryContext,
  skip: ReadonlySet<number> = new Set(),
): NoteEvent[] {
  const kicks = kickSteps(project);
  const pitch = degreePitch(lessonKey(project, settings), 0, BASS_C);
  return kicks.flatMap((step, index) => {
    if (skip.has(step)) return [];
    const until = kicks[index + 1] ?? 16;
    return [
      createNoteEvent(context, {
        startTicks: step * TICKS_PER_SIXTEENTH,
        durationTicks: Math.max(1, until - step) * TICKS_PER_SIXTEENTH,
        pitch,
        velocity: 0.9,
      }),
    ];
  });
}

/** Passed over once the song has a track named for the bass. */
const addBass: LessonStep = {
  id: "bass",
  applies: (world) => bassOf(world.project) === null,
  instruction: () =>
    `First, a track for the bass: in the [Mixer](mixer), press Add synth track, then double-click its name and call it ${PART_TRACK_NAMES.bass}.`,
  target: () => controlAddress(SONG_ENTITY, CONTROL_PARTS.tracks),
  done: (world) => bassOf(world.project) !== null,
  showMe: (world, _settings, context) => ({
    kind: "commands",
    commands: addPartTrack(world.project, "bass", [], context),
  }),
};

const key: LessonBite = {
  id: "bass-key",
  chapter: "bass",
  title: "Pick a key",
  skill: "choosing a key for the song, so every part after the beat agrees on its notes",
  quiz: "What does choosing a key decide? (Which notes belong: the scale every part is written in.)",
  made: (world) => !isChromatic(world.project.song.key) && bassOf(world.project) !== null,
  steps: [
    addBass,
    {
      id: "key",
      instruction: (_world, settings) => {
        const chosen = STYLE_KEYS[settings.style];
        return `Give the song a [key](key): open ${PART_TRACK_NAMES.bass}'s clip in the [Sequence view](sequence), and in the Key panel under the [piano roll](piano-roll), pick ${keyWords(chosen)}. ${STYLE_KEY_WORDS[settings.style]}`;
      },
      target: () => controlAddress(SONG_ENTITY, CONTROL_PARTS.key),
      // The key asked for, not just any (GRV-44): the bassline, the chords and
      // the hook are written in it.
      done: (world, _start, settings) => {
        const chosen = STYLE_KEYS[settings.style];
        const { root, scale } = world.project.song.key;
        return root === chosen.root && scale === chosen.scale;
      },
      showMe: (_world, settings) => ({
        kind: "commands",
        commands: [setKey(STYLE_KEYS[settings.style])],
      }),
    },
  ],
};

/** The commands that make the bass's first clip a bassline under the kick. */
function writeBassline(
  project: Project,
  bass: Track,
  settings: LessonSettings,
  context: DomainFactoryContext,
): RawCommandInput[] {
  const key = lessonKey(project, settings);
  const clip = noteClips(project, bass)[0];
  if (!clip || clip.content.kind !== "notes") {
    const fresh = createNoteClip(context, {
      trackId: bass.id,
      name: PART_TRACK_NAMES.bass,
      lengthTicks: TICKS_PER_BAR,
      color: bass.color,
      events: bassline(project, settings, context),
    });
    const placement = createPlacement(context, {
      clipId: fresh.id,
      trackId: bass.id,
      startTicks: 0,
      durationTicks: 4 * TICKS_PER_BAR,
      looped: true,
    });
    return [addClip(fresh, [placement])];
  }
  // What stays: the notes that already fit. What goes: the rest.
  const stray = clip.content.events.filter((note) => !fitsBass(note, key));
  const kept = clip.content.events.filter((note) => fitsBass(note, key));
  const covered = new Set(kept.map(stepOf).filter((step) => step !== null));
  const missing = bassline(project, settings, context, covered);
  return [
    ...(stray.length > 0
      ? [
          removeNotes(
            clip.id,
            stray.map((note) => note.id),
          ),
        ]
      : []),
    ...(missing.length > 0 ? [addNotes(clip.id, missing)] : []),
  ];
}

const line: LessonBite = {
  id: "bass-line",
  chapter: "bass",
  title: "Under the kick",
  skill: "writing a bassline that lands with the kick, on the key's root",
  quiz: "Why put the bass notes where the kick is? (They hit together as one low punch, instead of fighting for the same space.)",
  steps: [
    addBass,
    {
      id: "line",
      instruction: (world, settings) => {
        const root = keyWords(lessonKey(world.project, settings)).split(" ")[0];
        return `Write a [bassline](bassline) under the kick: in ${PART_TRACK_NAMES.bass}'s [piano roll](piano-roll), put a note on every step the kick plays, low down on the key's [root](root), ${root}, below middle C. Stay in the key, and hold each note until the next.`;
      },
      target: (world) => {
        const bass = bassOf(world.project);
        const clip = bass ? noteClips(world.project, bass)[0] : undefined;
        return clip ? controlAddress(clip.id, CONTROL_PARTS.notes) : null;
      },
      done: (world, _start, settings) => bassUnderKick(world.project, settings),
      showMe(world, settings, context) {
        const bass = bassOf(world.project);
        if (!bass) return null;
        const commands = writeBassline(world.project, bass, settings, context);
        return commands.length > 0 ? { kind: "commands", commands } : null;
      },
    },
  ],
};

const sound: LessonBite = {
  id: "bass-sound",
  chapter: "bass",
  title: "Round it off",
  skill: "taking the buzz off a synth bass with the filter, so it sits low and round",
  quiz: "What does closing a bass's filter take away? (The buzzy top, leaving the round low end.)",
  steps: [
    addBass,
    {
      id: "cutoff",
      instruction: () =>
        `On ${PART_TRACK_NAMES.bass}'s faceplate in the [Instrument view](instrument), turn the [filter](filter)'s [cutoff](cutoff) down below ${ROUND_CUTOFF_HZ} Hz, and listen to the buzz go and a round low end stay.`,
      target: (world) => {
        const bass = bassOf(world.project);
        return bass ? instrumentControl(bass, "cutoff") : null;
      },
      done(world) {
        const bass = bassOf(world.project);
        return (
          bass !== null && isSynthTrack(bass) && synthCutoff(bass) <= ROUND_CUTOFF_HZ
        );
      },
      showMe(world) {
        const bass = bassOf(world.project);
        return bass && isSynthTrack(bass)
          ? { kind: "commands", commands: [setSynth(bass, "cutoff", SHOWN_CUTOFF_HZ)] }
          : null;
      },
    },
  ],
};

export const BASS_CHAPTER: LessonChapter = {
  id: "bass",
  title: "Bass",
  short: "Bass",
  summary: "a bassline under the kick, in the song's key",
  bites: [key, line, sound],
};
