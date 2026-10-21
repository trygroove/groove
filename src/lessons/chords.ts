/**
 * "Chords and hook" (GRV-44), the third chapter of "Finish a track": a chord
 * loop over four bars, a hook on a synth over it, and the hook shaped into a
 * pluck. Every note is in the song's key (`lessonKey`).
 */
import { CONTROL_PARTS, controlAddress, SONG_ENTITY } from "../commands/controlAddress";
import { addClip } from "../commands/definitions/clips";
import type { RawCommandInput } from "../commands/types";
import type { NoteEvent, Project, Track } from "../domain/entities";
import {
  createNoteClip,
  createNoteEvent,
  createPlacement,
  type DomainFactoryContext,
} from "../domain/factories";
import { isPitchInKey, type MusicalKey, SCALE_INTERVALS } from "../domain/musicalKey";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../domain/time";
import { noteClips } from "./drums";
import {
  addPartTrack,
  clearSpan,
  degreePitch,
  lessonKey,
  PART_TRACK_NAMES,
  type PartRole,
  partTrack,
} from "./parts";
import { isPluck } from "./sound";
import { instrumentControl, isSynthTrack, setSynth } from "./synthParts";
import type { LessonBite, LessonChapter, LessonSettings, LessonStep } from "./types";

/** How long the chord loop runs, in bars: one chord a bar. */
export const CHORD_BARS = 4;
/** The fewest notes sounding together that make a chord. */
const CHORD_NOTES = 3;
/** The fewest notes a hook has. */
export const HOOK_NOTES = 4;
/** The C chords and the hook are counted up from: C3 and C4. */
const CHORDS_C = 48;
const HOOK_C = 60;

/** Each chord's root, as a degree of the scale: i–VI–III–VII in minor, I–V–vi–IV in major. */
const MINOR_PROGRESSION = [0, 5, 2, 6] as const;
const MAJOR_PROGRESSION = [0, 4, 5, 3] as const;
/** The hook, as scale degrees on the eighths of one bar. */
const HOOK_DEGREES = [4, 2, 0, 2, 4, 5, 4, 2] as const;

function isMinor(key: MusicalKey): boolean {
  return SCALE_INTERVALS[key.scale].includes(3);
}

/** A chord change: notes starting together, at least {@link CHORD_NOTES} of them. */
function chordsIn(notes: readonly NoteEvent[]): string[] {
  const byStart = new Map<number, number[]>();
  for (const note of notes) {
    if (note.trigger.kind !== "pitch") continue;
    byStart.set(note.startTicks, [
      ...(byStart.get(note.startTicks) ?? []),
      note.trigger.pitch,
    ]);
  }
  return [...byStart.values()]
    .filter((pitches) => new Set(pitches).size >= CHORD_NOTES)
    .map((pitches) => [...new Set(pitches.map((pitch) => pitch % 12))].sort().join(","));
}

function inKey(notes: readonly NoteEvent[], key: MusicalKey): boolean {
  return notes.every(
    (note) => note.trigger.kind === "pitch" && isPitchInKey(key, note.trigger.pitch),
  );
}

/**
 * Whether one clip of the chords part loops through at least two different
 * chords, every note of it in the song's key.
 */
export function chordLoop(project: Project, settings: LessonSettings): boolean {
  const track = partTrack(project, "chords");
  if (!track) return false;
  const key = lessonKey(project, settings);
  return noteClips(project, track).some((clip) => {
    if (clip.content.kind !== "notes") return false;
    const events = clip.content.events;
    return new Set(chordsIn(events)).size >= 2 && inKey(events, key);
  });
}

/**
 * Whether one clip of the hook part is a melody: at least
 * {@link HOOK_NOTES} notes, one at a time, on more than one pitch, every one
 * in the song's key.
 */
export function hookWritten(project: Project, settings: LessonSettings): boolean {
  const track = partTrack(project, "hook");
  if (!track) return false;
  const key = lessonKey(project, settings);
  return noteClips(project, track).some((clip) => {
    if (clip.content.kind !== "notes") return false;
    const events = clip.content.events;
    const starts = new Set(events.map((note) => note.startTicks));
    const pitches = new Set(
      events.map((note) => (note.trigger.kind === "pitch" ? note.trigger.pitch : -1)),
    );
    return (
      events.length >= HOOK_NOTES &&
      starts.size === events.length &&
      pitches.size >= 2 &&
      inKey(events, key)
    );
  });
}

function chordNotes(key: MusicalKey, context: DomainFactoryContext): NoteEvent[] {
  const progression = isMinor(key) ? MINOR_PROGRESSION : MAJOR_PROGRESSION;
  return progression.flatMap((root, bar) =>
    [0, 2, 4].map((third) =>
      createNoteEvent(context, {
        startTicks: bar * TICKS_PER_BAR,
        durationTicks: TICKS_PER_BAR,
        pitch: degreePitch(key, root + third, CHORDS_C),
        velocity: 0.7,
      }),
    ),
  );
}

function hookNotes(key: MusicalKey, context: DomainFactoryContext): NoteEvent[] {
  return HOOK_DEGREES.map((degree, index) =>
    createNoteEvent(context, {
      startTicks: index * 2 * TICKS_PER_SIXTEENTH,
      durationTicks: TICKS_PER_SIXTEENTH,
      pitch: degreePitch(key, degree, HOOK_C),
      velocity: 0.85,
    }),
  );
}

/**
 * The commands that give `role`'s track a fresh clip of `events`, `bars`
 * long, looped from bar 1 for {@link CHORD_BARS} bars in place of what it
 * played there; or a new track for it, when it has none.
 */
function writePart(
  project: Project,
  role: PartRole,
  events: NoteEvent[],
  bars: number,
  context: DomainFactoryContext,
): RawCommandInput[] {
  const track = partTrack(project, role);
  if (!track) return addPartTrack(project, role, events, context, bars, CHORD_BARS);
  const clip = createNoteClip(context, {
    trackId: track.id,
    name: PART_TRACK_NAMES[role],
    lengthTicks: bars * TICKS_PER_BAR,
    color: track.color,
    events,
  });
  const placement = createPlacement(context, {
    clipId: clip.id,
    trackId: track.id,
    startTicks: 0,
    durationTicks: CHORD_BARS * TICKS_PER_BAR,
    looped: bars < CHORD_BARS,
  });
  return [
    ...clearSpan(project, [track.id], { from: 0, to: CHORD_BARS }, context),
    addClip(clip, [placement]),
  ];
}

/** Passed over once the song has a track named for `role`. */
function addPart(role: PartRole, sound: string): LessonStep {
  return {
    id: `${role}-track`,
    applies: (world) => partTrack(world.project, role) === null,
    instruction: () =>
      `First, a track for the ${sound}: in the [Mixer](mixer), press Add synth track, then double-click its name and call it ${PART_TRACK_NAMES[role]}.`,
    target: () => controlAddress(SONG_ENTITY, CONTROL_PARTS.tracks),
    done: (world) => partTrack(world.project, role) !== null,
    showMe: (world, _settings, context) => ({
      kind: "commands",
      commands: addPartTrack(world.project, role, [], context),
    }),
  };
}

/** Where a part's notes are written: its first clip, for the mark. */
function partNotesControl(project: Project, track: Track | null) {
  const clip = track ? noteClips(project, track)[0] : undefined;
  return clip ? controlAddress(clip.id, CONTROL_PARTS.notes) : null;
}

const loop: LessonBite = {
  id: "chords-loop",
  chapter: "chords",
  title: "A chord loop",
  skill: "writing a four-bar chord loop in the song's key",
  quiz: "How many notes does it take to make a chord? (Three or more, sounding together.)",
  steps: [
    addPart("chords", "chords"),
    {
      id: "chords",
      instruction: () =>
        `Write a [chord](chord) loop: in ${PART_TRACK_NAMES.chords}' [piano roll](piano-roll), make the clip ${CHORD_BARS} bars long and put a chord of three notes at the start of each bar, every note in the key. At least two different chords: the change is what moves.`,
      target: (world) =>
        partNotesControl(world.project, partTrack(world.project, "chords")),
      done: (world, _start, settings) => chordLoop(world.project, settings),
      showMe: (world, settings, context) => ({
        kind: "commands",
        commands: writePart(
          world.project,
          "chords",
          chordNotes(lessonKey(world.project, settings), context),
          CHORD_BARS,
          context,
        ),
      }),
    },
  ],
};

const hook: LessonBite = {
  id: "chords-hook",
  chapter: "chords",
  title: "The hook",
  skill: "writing a short, catchy melody over the chords",
  quiz: "What makes a hook stick? (It's short and it repeats, so you can hum it after one listen.)",
  steps: [
    addPart("hook", "hook"),
    {
      id: "hook",
      instruction: () =>
        `Write a [hook](hook) over the chords: in ${PART_TRACK_NAMES.hook}'s [piano roll](piano-roll), a short melody of at least ${HOOK_NOTES} notes, one at a time, in the key and above the chords. Short and repeated is what makes it stick.`,
      target: (world) =>
        partNotesControl(world.project, partTrack(world.project, "hook")),
      done: (world, _start, settings) => hookWritten(world.project, settings),
      showMe: (world, settings, context) => ({
        kind: "commands",
        commands: writePart(
          world.project,
          "hook",
          hookNotes(lessonKey(world.project, settings), context),
          1,
          context,
        ),
      }),
    },
  ],
};

const pluck: LessonBite = {
  id: "chords-pluck",
  chapter: "chords",
  title: "Pluck the hook",
  skill: "shaping the hook's envelope into a pluck, so it cuts through the chords",
  quiz: "Why does a pluck cut through held chords? (It starts hard and dies away, so it never sits on top of them.)",
  steps: [
    addPart("hook", "hook"),
    {
      id: "envelope",
      instruction: () =>
        `Make ${PART_TRACK_NAMES.hook} a [pluck](pluck) in the [Instrument view](instrument): [attack](attack) as short as it goes, [decay](decay) short and [sustain](sustain) all the way down, so it cuts through the chords rather than sitting on them.`,
      target: (world) => {
        const track = partTrack(world.project, "hook");
        return track ? instrumentControl(track, "sustain") : null;
      },
      done(world) {
        const track = partTrack(world.project, "hook");
        return track !== null && isSynthTrack(track) && isPluck(track);
      },
      showMe(world) {
        const track = partTrack(world.project, "hook");
        return track && isSynthTrack(track)
          ? {
              kind: "commands",
              commands: [
                setSynth(track, "attack", 0.002),
                setSynth(track, "decay", 0.25),
                setSynth(track, "sustain", 0),
                setSynth(track, "release", 0.2),
              ],
            }
          : null;
      },
    },
  ],
};

export const CHORDS_CHAPTER: LessonChapter = {
  id: "chords",
  title: "Chords and hook",
  summary: "a four-bar chord loop, and a plucked hook over it",
  bites: [loop, hook, pluck],
};
