/**
 * "Mix and export" (GRV-44), the last chapter of "Finish a track": basic
 * mixing on the Mixer, then the stems. Balance the parts (the kick and the
 * bass loudest, the hook and the chords under them), pan the hats and the
 * chords off centre, give the hook one send of reverb, and watch the master
 * meter stay out of the red while the song plays. The last bite opens the
 * Export dialog with stems chosen; pressing Export is the producer's.
 */
import {
  CONTROL_PARTS,
  controlAddress,
  exportControl,
  MASTER_ENTITY,
  parameterControl,
  SONG_ENTITY,
} from "../commands/controlAddress";
import { setPadParameter } from "../commands/definitions/drum";
import { setParameter } from "../commands/definitions/parameters";
import { addReturn, addSend } from "../commands/definitions/returns";
import type { RawCommandInput } from "../commands/types";
import { createDevice } from "../domain/devices";
import type { Project, ReturnBus, Track } from "../domain/entities";
import { createReturnBus, createSend } from "../domain/factories";
import type { DeviceId, PadId } from "../domain/ids";
import {
  MASTER_VOLUME,
  TRACK_PAN,
  TRACK_SEND_LEVEL,
  TRACK_VOLUME,
} from "../domain/parameters";
import { TICKS_PER_BAR } from "../domain/time";
import { DROP } from "./arrange";
import { beatTrack, type DrumTrack, kickPad, padFor } from "./drums";
import { PART_TRACK_NAMES, partTrack } from "./parts";
import type { LessonBite, LessonChapter, LessonStep, LessonWorld } from "./types";

/** How far under the kick and the bass, in dB, the hook and the chords sit once balanced. */
export const UNDER_DB = 1;
/** How far off centre a part is panned once it counts as panned. */
export const OFF_CENTRE = 0.1;
/** How far up a send must be to be heard. */
export const SEND_HEARD = 0.05;
/** How many bars the master is watched for. */
export const WATCH_BARS = 4;

/** The kick's level: its drum machine's fader plus its pad's. */
export function kickLevel(project: Project): number | null {
  const track = beatTrack(project);
  const pad = track ? kickPad(track) : null;
  return track && pad ? track.mixer.volume + pad.mixer.volume : null;
}

function level(track: Track | null): number | null {
  return track ? track.mixer.volume : null;
}

/** The quietest of the kick and the bass, the floor the rest sits under. */
function floorOf(project: Project): number | null {
  const loud = [kickLevel(project), level(partTrack(project, "bass"))].filter(
    (value): value is number => value !== null,
  );
  return loud.length > 0 ? Math.min(...loud) : null;
}

/**
 * Whether the hook and the chords each sit at least {@link UNDER_DB} under
 * both the kick and the bass, of the parts the song has.
 */
export function balanced(project: Project): boolean {
  const floor = floorOf(project);
  if (floor === null) return true;
  return [partTrack(project, "hook"), partTrack(project, "chords")].every(
    (track) => track === null || track.mixer.volume <= floor - UNDER_DB,
  );
}

/** The beat's hats pad, when it has one. */
function hatsOf(
  project: Project,
): { track: DrumTrack; padId: PadId; pan: number } | null {
  const track = beatTrack(project);
  const pad = track ? padFor(track, "hats") : null;
  return track && pad ? { track, padId: pad.id, pan: pad.mixer.pan } : null;
}

/** Whether the hats and the chords, of those the song has, are off centre. */
export function panned(project: Project): boolean {
  const hats = hatsOf(project);
  const chords = partTrack(project, "chords");
  return (
    (hats === null || Math.abs(hats.pan) >= OFF_CENTRE) &&
    (chords === null || Math.abs(chords.mixer.pan) >= OFF_CENTRE)
  );
}

function hasReverb(bus: ReturnBus): boolean {
  return bus.devices.some((device) => device.type === "reverb" && !device.bypassed);
}

/** The first return with a reverb on it. */
export function reverbReturn(project: Project): ReturnBus | null {
  return (
    [...project.song.returns].sort((a, b) => a.order - b.order).find(hasReverb) ?? null
  );
}

/** Whether the hook is sent, audibly, to a return with a reverb on it. */
export function hookSent(project: Project): boolean {
  const hook = partTrack(project, "hook");
  if (!hook) return false;
  return hook.sendConfig.some((send) => {
    const bus = project.song.returns.find((each) => each.id === send.returnId);
    return bus !== undefined && hasReverb(bus) && send.level >= SEND_HEARD;
  });
}

const trackVolume = (track: Track, value: number): RawCommandInput =>
  setParameter(
    { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
    value,
  );

const balance: LessonBite = {
  id: "mix-balance",
  chapter: "mix",
  title: "Balance",
  skill:
    "balancing the parts with their faders: the kick and the bass loudest, the rest under them",
  quiz: "Which two parts usually sit loudest in a dance or hip hop mix? (The kick and the bass.)",
  steps: [
    {
      id: "balance",
      instruction: () =>
        `[Balance](balance) the parts in the [Mixer](mixer): the kick and the bass loudest, the chords and the [hook](hook) a few dB under them. Pull the ${PART_TRACK_NAMES.chords} and ${PART_TRACK_NAMES.hook} [faders](fader) down until they sit under the beat.`,
      target: (world) => {
        const hook = partTrack(world.project, "hook");
        return hook ? parameterControl(hook.id, TRACK_VOLUME.id) : null;
      },
      done: (world) => balanced(world.project),
      showMe(world) {
        const floor = floorOf(world.project);
        if (floor === null) return null;
        const commands = (
          [
            [partTrack(world.project, "hook"), 4],
            [partTrack(world.project, "chords"), 6],
          ] as const
        ).flatMap(([track, under]) =>
          track && track.mixer.volume > floor - UNDER_DB
            ? [trackVolume(track, Math.max(TRACK_VOLUME.min, floor - under))]
            : [],
        );
        return commands.length > 0 ? { kind: "commands", commands } : null;
      },
    },
  ],
};

const pan: LessonBite = {
  id: "mix-pan",
  chapter: "mix",
  title: "Pan",
  skill:
    "panning parts off centre so each has its own place, the kick and the bass staying in the middle",
  quiz: "Which parts stay in the middle of a mix? (The kick and the bass, the low end.)",
  steps: [
    {
      id: "pan",
      instruction: () =>
        `[Pan](pan) the hats and the chords off centre, to opposite sides: the hats' pad a little left on the drum machine in the [Instrument view](instrument), ${PART_TRACK_NAMES.chords} a little right in the [Mixer](mixer). The kick and the bass stay in the middle.`,
      target: (world) => {
        const chords = partTrack(world.project, "chords");
        return chords ? parameterControl(chords.id, TRACK_PAN.id) : null;
      },
      done: (world) => panned(world.project),
      showMe(world) {
        const hats = hatsOf(world.project);
        const chords = partTrack(world.project, "chords");
        const commands: RawCommandInput[] = [
          ...(hats && Math.abs(hats.pan) < OFF_CENTRE
            ? [setPadParameter(hats.track.id, hats.padId, TRACK_PAN.id, -0.3)]
            : []),
          ...(chords && Math.abs(chords.mixer.pan) < OFF_CENTRE
            ? [
                setParameter(
                  { scope: "track", trackId: chords.id, parameterId: TRACK_PAN.id },
                  0.3,
                ),
              ]
            : []),
        ];
        return commands.length > 0 ? { kind: "commands", commands } : null;
      },
    },
  ],
};

/** Passed over once the song has a return with a reverb on it. */
const reverbBus: LessonStep = {
  id: "return",
  applies: (world) => reverbReturn(world.project) === null,
  instruction: () =>
    "First, somewhere for the reverb to live: in the [Mixer](mixer), press Add return, then put a [Reverb](reverb) on that [return](return)'s chain, below the desk.",
  target: () => controlAddress(SONG_ENTITY, CONTROL_PARTS.returns),
  done: (world) => reverbReturn(world.project) !== null,
  showMe(world, _settings, context) {
    const returns = world.project.song.returns;
    const bus = createReturnBus(context, {
      name: `Reverb`,
      order: returns.length,
    });
    const reverb = createDevice(context.ids("device") as DeviceId, "reverb", 0);
    return {
      kind: "commands",
      commands: [
        addReturn({
          ...bus,
          devices: [{ ...reverb, parameters: { ...reverb.parameters, wet: 1 } }],
        }),
      ],
    };
  },
};

const reverb: LessonBite = {
  id: "mix-reverb",
  chapter: "mix",
  title: "Reverb on the hook",
  skill: "giving one part space with a send to a reverb return, while the beat stays dry",
  quiz: "Why send to a reverb on a return rather than put one on the track? (Every part can share it, and the dry sound stays as it was.)",
  steps: [
    reverbBus,
    {
      id: "send",
      instruction: () =>
        `[Send](send) ${PART_TRACK_NAMES.hook} to the reverb's [return](return): on its strip in the [Mixer](mixer), add the send and turn it up a little. The hook gets a room around it while the beat stays dry and close.`,
      target: (world) => {
        const hook = partTrack(world.project, "hook");
        return hook ? controlAddress(hook.id, CONTROL_PARTS.sends) : null;
      },
      // A song with no hook has nothing to send.
      done: (world) =>
        partTrack(world.project, "hook") === null || hookSent(world.project),
      showMe(world) {
        const hook = partTrack(world.project, "hook");
        const bus = reverbReturn(world.project);
        if (!hook || !bus) return null;
        const sent = hook.sendConfig.some((send) => send.returnId === bus.id);
        return {
          kind: "commands",
          commands: [
            sent
              ? setParameter(
                  {
                    scope: "send",
                    trackId: hook.id,
                    returnId: bus.id,
                    parameterId: TRACK_SEND_LEVEL.id,
                  },
                  0.3,
                )
              : addSend(hook.id, createSend(bus.id, 0.3)),
          ],
        };
      },
    },
  ],
};

/**
 * The bars heard, and the master's clips, since the step began: counted from
 * the step's start when the song was already playing then, so a step begun
 * mid-song is still four bars of watching, and from the song's start
 * otherwise. Both counts start again as the song does, so either one below
 * where it stood at the step's start means the song was played again since:
 * a new run, counted from its own start.
 */
export function watched(
  world: LessonWorld,
  start: LessonWorld,
): { readonly bars: number; readonly clips: number } {
  const sameRun =
    start.playing &&
    world.barsHeard >= start.barsHeard &&
    world.masterClips >= start.masterClips;
  return sameRun
    ? {
        bars: world.barsHeard - start.barsHeard,
        clips: world.masterClips - start.masterClips,
      }
    : { bars: world.barsHeard, clips: world.masterClips };
}

const master: LessonBite = {
  id: "mix-master",
  chapter: "mix",
  title: "Watch the master",
  skill: "checking the mix never clips by watching the master meter while the song plays",
  quiz: "What does the master meter going red mean? (The mix went over 0 dBFS and clipped: turn something down.)",
  steps: [
    {
      id: "watch",
      instruction: () =>
        `Play the drop, from bar ${DROP.from + 1}, the loudest part of the song, and watch the [master](master) meter at the right of the [Mixer](mixer) for ${WATCH_BARS} bars: it should never go red, the one red in Groove. If it does, pull the master [fader](fader) or the loudest part down a little and play it again.`,
      target: () => parameterControl(MASTER_ENTITY, MASTER_VOLUME.id),
      done(world, start) {
        const heard = watched(world, start);
        return world.playing && heard.bars >= WATCH_BARS && heard.clips === 0;
      },
      showMe: () => ({ kind: "play", from: DROP.from * TICKS_PER_BAR }),
    },
  ],
};

const stems: LessonBite = {
  id: "mix-export",
  chapter: "mix",
  title: "Export the stems",
  skill: "exporting stems: one file per track, lined up from bar 1",
  quiz: "What are stems for? (A file per part, so a mix engineer, a remixer or a live set can work with each one on its own.)",
  steps: [
    {
      id: "export",
      // Show me opens the dialog beside the lesson, never over it (GRV-190).
      instruction: () =>
        "Open Export at the top of the studio, choose [stems](stems) and keep every track in them: one file per track, all lined up from bar 1. Show me opens it that way. Then press Export to take them with you.",
      target: () => exportControl(),
      done: (world, start) => world.stemExports > start.stemExports,
      showMe: () => ({ kind: "export" }),
    },
  ],
};

export const MIX_CHAPTER: LessonChapter = {
  id: "mix",
  title: "Mix and export",
  short: "Mix",
  summary: "a balanced, panned mix with reverb on the hook, and its stems exported",
  bites: [balance, pan, reverb, master, stems],
};
