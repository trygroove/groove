/**
 * "Shape a sound" (GRV-43): on a synth, pick a waveform, darken it with the
 * filter, and shape the amp envelope into a pluck. A song with no synth, or
 * one with no notes, gets one first, so there is something to hear.
 */
import {
  CONTROL_PARTS,
  controlAddress,
  parameterControl,
} from "../commands/controlAddress";
import { addClip } from "../commands/definitions/clips";
import { addNotes } from "../commands/definitions/notes";
import { setParameter } from "../commands/definitions/parameters";
import { addTrack } from "../commands/definitions/tracks";
import type { RawCommandInput } from "../commands/types";
import type { NoteEvent, Project, Track } from "../domain/entities";
import {
  createNoteClip,
  createNoteEvent,
  createPlacement,
  createSynthInstrument,
  createTrack,
  type DomainFactoryContext,
} from "../domain/factories";
import {
  bareParameterId,
  type ParameterDefinition,
  readInstrumentParameter,
  SYNTH_AMP_ATTACK,
  SYNTH_AMP_DECAY,
  SYNTH_AMP_RELEASE,
  SYNTH_AMP_SUSTAIN,
  SYNTH_FILTER_CUTOFF,
  SYNTH_WAVEFORM,
  SYNTH_WAVEFORMS,
} from "../domain/parameters";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../domain/time";
import { noteClips } from "./drums";
import type { LessonBite, LessonChapter, LessonStep, LessonWorld } from "./types";

/** At or below this cutoff, in hertz, a sound counts as darkened. */
export const DARK_CUTOFF_HZ = 1_500;
/** What Show me turns the cutoff down to. */
const SHOWN_CUTOFF_HZ = 900;

/** A pluck's envelope: the most each of its parts may be. */
export const PLUCK = { attack: 0.02, decay: 0.5, sustain: 0.1 } as const;

/** The short C minor riff a synth gets when it has nothing to play. */
const RIFF: readonly (readonly [step: number, pitch: number])[] = [
  [0, 60],
  [2, 63],
  [4, 67],
  [6, 70],
  [8, 67],
  [10, 63],
  [12, 60],
  [14, 67],
];

type SynthTrack = Track & { readonly instrument: { readonly kind: "synth" } };

function isSynth(track: Track): track is SynthTrack {
  return track.instrument?.kind === "synth";
}

/** The lesson's synth: the last in track order, the one most likely just added. */
export function lessonSynth(project: Project): SynthTrack | null {
  return [...project.song.tracks].sort((a, b) => b.order - a.order).find(isSynth) ?? null;
}

const synthOf = (world: LessonWorld) => lessonSynth(world.project);

function hasNotes(project: Project, track: Track): boolean {
  return noteClips(project, track).some(
    (clip) => clip.content.kind === "notes" && clip.content.events.length > 0,
  );
}

function riff(context: DomainFactoryContext): NoteEvent[] {
  return RIFF.map(([step, pitch]) =>
    createNoteEvent(context, {
      startTicks: step * TICKS_PER_SIXTEENTH,
      durationTicks: 2 * TICKS_PER_SIXTEENTH,
      pitch,
    }),
  );
}

/** A synth parameter's value on `track`. */
function synthValue(track: SynthTrack, definition: ParameterDefinition): number {
  return readInstrumentParameter(definition, track.instrument.parameters);
}

function set(
  track: Track,
  definition: ParameterDefinition,
  value: number,
): RawCommandInput {
  return setParameter(
    {
      scope: "instrument",
      trackId: track.id,
      parameterId: bareParameterId(definition.id),
    },
    value,
  );
}

const control = (track: Track, definition: ParameterDefinition) =>
  parameterControl(track.id, definition.id);

/** Passed over unless the song has no synth. */
const addSynth: LessonStep = {
  id: "synth",
  applies: (world) => synthOf(world) === null,
  instruction: () =>
    "First, a [synth](synth): in the [Mixer](mixer), press Add synth track.",
  target: () => controlAddress("song", CONTROL_PARTS.tracks),
  done: (world) => synthOf(world) !== null,
  showMe(world, _settings, context) {
    const track = createTrack(context, {
      name: "Synth",
      order: world.project.song.tracks.length,
      instrument: createSynthInstrument(),
    });
    const clip = createNoteClip(context, {
      trackId: track.id,
      name: "Riff",
      lengthTicks: TICKS_PER_BAR,
      color: track.color,
      events: riff(context),
    });
    const placement = createPlacement(context, {
      clipId: clip.id,
      trackId: track.id,
      startTicks: 0,
      durationTicks: 4 * TICKS_PER_BAR,
      looped: true,
    });
    return {
      kind: "commands",
      commands: [addTrack(track, { clips: [clip], placements: [placement] })],
    };
  },
};

/** Passed over unless the synth has no notes to play. */
const addNotesStep: LessonStep = {
  id: "notes",
  applies: (world) => {
    const synth = synthOf(world);
    return synth !== null && !hasNotes(world.project, synth);
  },
  instruction: (world) =>
    `Give ${synthOf(world)?.name ?? "the synth"} a few notes to play: open its [clip](clip) in the [Sequence view](sequence) and draw some.`,
  target(world) {
    const synth = synthOf(world);
    const clip = synth ? noteClips(world.project, synth)[0] : undefined;
    return clip ? controlAddress(clip.id, CONTROL_PARTS.notes) : null;
  },
  done(world) {
    const synth = synthOf(world);
    return synth !== null && hasNotes(world.project, synth);
  },
  showMe(world, _settings, context) {
    const synth = synthOf(world);
    if (!synth) return null;
    const clip = noteClips(world.project, synth)[0];
    if (clip) return { kind: "commands", commands: [addNotes(clip.id, riff(context))] };
    const fresh = createNoteClip(context, {
      trackId: synth.id,
      name: "Riff",
      lengthTicks: TICKS_PER_BAR,
      color: synth.color,
      events: riff(context),
    });
    const placement = createPlacement(context, {
      clipId: fresh.id,
      trackId: synth.id,
      startTicks: 0,
      durationTicks: TICKS_PER_BAR,
    });
    return { kind: "commands", commands: [addClip(fresh, [placement])] };
  },
};

const wave: LessonBite = {
  id: "sound-wave",
  chapter: "sound",
  title: "Pick a wave",
  skill: "choosing an oscillator's waveform by how it sounds",
  quiz: "Which waveform is the brightest, with the most harmonics? (Saw.)",
  steps: [
    addSynth,
    addNotesStep,
    {
      id: "wave",
      instruction: (world) =>
        `On ${synthOf(world)?.name ?? "the synth"}'s faceplate in the [Instrument view](instrument), try each [waveform](waveform) while it plays: sine is pure, square hollow, saw bright. Keep the one you like.`,
      target: (world) => {
        const synth = synthOf(world);
        return synth ? control(synth, SYNTH_WAVEFORM) : null;
      },
      done(world, start) {
        const before = synthOf(start);
        const now = synthOf(world);
        return (
          before !== null &&
          now !== null &&
          now.id === before.id &&
          synthValue(now, SYNTH_WAVEFORM) !== synthValue(before, SYNTH_WAVEFORM)
        );
      },
      showMe(world) {
        const synth = synthOf(world);
        if (!synth) return null;
        const square = SYNTH_WAVEFORMS.indexOf("square");
        const saw = SYNTH_WAVEFORMS.indexOf("sawtooth");
        const next = synthValue(synth, SYNTH_WAVEFORM) === square ? saw : square;
        return { kind: "commands", commands: [set(synth, SYNTH_WAVEFORM, next)] };
      },
    },
  ],
};

/**
 * Run only when the synth's filter is already down (GRV-190), as when the
 * chapter is started again on a sound shaped before: the producer opens it
 * back up, so turning it down is theirs to do and to hear.
 */
const openFilter: LessonStep = {
  id: "open",
  applies: (world) => {
    const synth = synthOf(world);
    return synth !== null && synthValue(synth, SYNTH_FILTER_CUTOFF) <= DARK_CUTOFF_HZ;
  },
  instruction: (world) =>
    `${synthOf(world)?.name ?? "The synth"}'s [filter](filter) is already down. To darken it yourself, open it back up first: turn the [cutoff](cutoff) up, above ${DARK_CUTOFF_HZ.toLocaleString("en")} Hz.`,
  target: (world) => {
    const synth = synthOf(world);
    return synth ? control(synth, SYNTH_FILTER_CUTOFF) : null;
  },
  done(world) {
    const synth = synthOf(world);
    return synth !== null && synthValue(synth, SYNTH_FILTER_CUTOFF) > DARK_CUTOFF_HZ;
  },
  showMe(world) {
    const synth = synthOf(world);
    return synth
      ? {
          kind: "commands",
          commands: [set(synth, SYNTH_FILTER_CUTOFF, SYNTH_FILTER_CUTOFF.defaultValue)],
        }
      : null;
  },
};

const filter: LessonBite = {
  id: "sound-filter",
  chapter: "sound",
  title: "Darken it",
  skill: "darkening a sound with a low-pass filter's cutoff",
  quiz: "Turning a low-pass filter's cutoff down makes a sound darker or brighter? (Darker.)",
  steps: [
    addSynth,
    openFilter,
    {
      id: "cutoff",
      instruction: (world) =>
        `Turn the [filter](filter)'s [cutoff](cutoff) on ${synthOf(world)?.name ?? "the synth"} down, below about ${DARK_CUTOFF_HZ.toLocaleString("en")} Hz, and listen to it get darker and rounder.`,
      target: (world) => {
        const synth = synthOf(world);
        return synth ? control(synth, SYNTH_FILTER_CUTOFF) : null;
      },
      done(world) {
        const synth = synthOf(world);
        return synth !== null && synthValue(synth, SYNTH_FILTER_CUTOFF) <= DARK_CUTOFF_HZ;
      },
      showMe(world) {
        const synth = synthOf(world);
        return synth
          ? {
              kind: "commands",
              commands: [set(synth, SYNTH_FILTER_CUTOFF, SHOWN_CUTOFF_HZ)],
            }
          : null;
      },
    },
  ],
};

/** Whether `track`'s amp envelope is a pluck's. */
export function isPluck(track: SynthTrack): boolean {
  return (
    synthValue(track, SYNTH_AMP_ATTACK) <= PLUCK.attack &&
    synthValue(track, SYNTH_AMP_DECAY) <= PLUCK.decay &&
    synthValue(track, SYNTH_AMP_SUSTAIN) <= PLUCK.sustain
  );
}

/**
 * Run only when the synth is already a pluck (GRV-190), as when the chapter
 * is started again on a sound shaped before: the producer lets it ring
 * again, so shaping the pluck is theirs.
 */
const openEnvelope: LessonStep = {
  id: "ring",
  applies: (world) => {
    const synth = synthOf(world);
    return synth !== null && isPluck(synth);
  },
  instruction: (world) =>
    `${synthOf(world)?.name ?? "The synth"} is already a [pluck](pluck). To shape it yourself, let it ring first: turn the [sustain](sustain) up.`,
  target: (world) => {
    const synth = synthOf(world);
    return synth ? control(synth, SYNTH_AMP_SUSTAIN) : null;
  },
  done(world) {
    const synth = synthOf(world);
    return synth !== null && !isPluck(synth);
  },
  showMe(world) {
    const synth = synthOf(world);
    return synth
      ? {
          kind: "commands",
          commands: [set(synth, SYNTH_AMP_SUSTAIN, SYNTH_AMP_SUSTAIN.defaultValue)],
        }
      : null;
  },
};

const pluck: LessonBite = {
  id: "sound-pluck",
  chapter: "sound",
  title: "Make it a pluck",
  skill: "shaping an amp envelope into a pluck",
  quiz: "Which part of the envelope do you turn all the way down for a pluck? (Sustain.)",
  steps: [
    addSynth,
    openEnvelope,
    {
      id: "envelope",
      instruction: () =>
        "Shape the amp [envelope](envelope) into a [pluck](pluck): [attack](attack) as short as it goes, [decay](decay) short, and [sustain](sustain) all the way down.",
      target: (world) => {
        const synth = synthOf(world);
        return synth ? control(synth, SYNTH_AMP_SUSTAIN) : null;
      },
      done(world) {
        const synth = synthOf(world);
        return synth !== null && isPluck(synth);
      },
      showMe(world) {
        const synth = synthOf(world);
        if (!synth) return null;
        return {
          kind: "commands",
          commands: [
            set(synth, SYNTH_AMP_ATTACK, 0.002),
            set(synth, SYNTH_AMP_DECAY, 0.25),
            set(synth, SYNTH_AMP_SUSTAIN, 0),
            set(synth, SYNTH_AMP_RELEASE, 0.2),
          ],
        };
      },
    },
  ],
};

export const SOUND_CHAPTER: LessonChapter = {
  id: "sound",
  title: "Shape a sound",
  short: "Sound",
  summary: "a synth pluck, from a raw waveform through the filter and the envelope",
  bites: [wave, filter, pluck],
};
