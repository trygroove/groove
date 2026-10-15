/**
 * The basic production actions set (GRV-119): the simple, exact edits
 * producers make all the time, each with one right answer that can be read
 * off the project after the turn.
 *
 * Every case is one plain-English request against a small fixture
 * (`basicActionFixtures.ts`), and names checks 18 and 19: its
 * {@link BasicAction} says what the edit is and what it may touch, and
 * nothing else in the song or its clips may change. The requests use exact
 * words ("longer kick", "lower the cutoff"), never taste words that cannot
 * be checked. Cases 10 and 12 ask two things each, so the set's 30 cases run
 * as 32 requests.
 *
 * Some ask for what the assistant's tools cannot do yet: there is no tool
 * for the song's loop range (5) or key (28), and it cannot bring a sound in
 * from the library (13). Those cases stay, and fail, until it can.
 */
import type { Project } from "../../domain/entities";
import { SYNTH_FILTER_CUTOFF } from "../../domain/parameters";
import type { AssistantMessage } from "../protocol";
import {
  addsTrackOf,
  type BasicAction,
  changesVolumeBy,
  deletesTrack,
  duplicatesAfter,
  extendsLoop,
  loopsBars,
  movesTo,
  movesToTop,
  pansLeft,
  proposesNothing,
  renamesTrack,
  restores,
  setsFlag,
  setsKey,
  setsTempo,
  trimsEnd,
} from "./basicActionChecks";
import {
  createBasicArrangementProject,
  createBasicEffectsProject,
  createBasicKitProject,
  createBasicLoopProject,
  createBasicMixProject,
  createBasicNotesProject,
  createBasicSynthProject,
} from "./basicActionFixtures";
import {
  addsDevice,
  addsPadWithRole,
  clearsClip,
  doublesSpeed,
  humanizes,
  lowersParameter,
  putsBefore,
  quantizes,
  raisesDeviceParameter,
  removesDevice,
  setsUpSend,
  swapsInstrument,
  swapsToLongerSample,
  transposes,
} from "./basicActionSoundChecks";
import type { EvalCase, EvalScope, EvalSelection } from "./cases";

const NOTHING_ELSE = { song: false, master: false, returns: false, sections: false };

/** Check 3's scope: the named tracks, or every one where renumbering touches them all. */
function tracks(...names: string[]): EvalScope {
  return { tracks: names, createTracks: false, ...NOTHING_ELSE };
}
const ALL_TRACKS: EvalScope = { tracks: "all", createTracks: false, ...NOTHING_ELSE };
const NEW_TRACK: EvalScope = { tracks: "all", createTracks: true, ...NOTHING_ELSE };
const SONG_ONLY: EvalScope = {
  tracks: [],
  createTracks: false,
  ...NOTHING_ELSE,
  song: true,
};

interface BasicCaseOptions {
  readonly selection?: EvalSelection;
  readonly history?: readonly AssistantMessage[];
  readonly expect?: EvalCase["expect"];
}

function basicCase(
  id: string,
  request: string,
  fixture: () => Project,
  action: BasicAction,
  scope: EvalScope,
  options: BasicCaseOptions = {},
): EvalCase {
  return {
    id: `basic-${id}`,
    set: "basicActions",
    capability: "basicAction",
    axis: "conventional",
    request,
    history: options.history,
    expect: options.expect ?? "proposal",
    checks: ["exactEdit", "nothingElse"],
    action,
    fixture,
    selection: options.selection ?? null,
    scope,
  };
}

/** A turn before the request, as the panel resends it. */
function after(request: string, reply: string): readonly AssistantMessage[] {
  return [
    { role: "user", text: request },
    { role: "assistant", text: reply },
  ];
}

const mix = () => createBasicMixProject();
const arrangement = createBasicArrangementProject;
const notes = () => createBasicNotesProject();

export const BASIC_ACTION_CASES: readonly EvalCase[] = [
  // Arrangement and loops (1 to 5)
  basicCase(
    "extend-loop",
    "Extend this 1-bar loop to 16 bars",
    createBasicLoopProject,
    extendsLoop("Loop", 16),
    tracks("Drums"),
    { selection: { clips: ["Loop"] } },
  ),
  basicCase(
    "duplicate-chorus",
    "Duplicate the chorus after itself",
    arrangement,
    duplicatesAfter("Chorus"),
    tracks("Lead"),
  ),
  basicCase(
    "trim-drums",
    "Delete the last 4 bars of the drums",
    arrangement,
    trimsEnd("Drums", 4),
    tracks("Drums"),
  ),
  basicCase(
    "move-bass",
    "Move the bass so it starts at bar 9",
    arrangement,
    movesTo("Bass", 9),
    tracks("Bass"),
  ),
  basicCase("loop-bars", "Loop bars 5–8", arrangement, loopsBars(5, 8), SONG_ONLY),
  // Tracks (6 to 12)
  basicCase("delete-pad", "Delete the pad track", mix, deletesTrack("Pad"), ALL_TRACKS),
  basicCase("add-synth", "Add a synth track", mix, addsTrackOf("synth"), NEW_TRACK),
  basicCase(
    "add-drum-machine",
    "Add a drum machine",
    mix,
    addsTrackOf("drumMachine"),
    NEW_TRACK,
  ),
  basicCase(
    "rename-track",
    "Rename track 3 to 'Lead'",
    mix,
    renamesTrack(3, "Lead"),
    tracks("Hats"),
  ),
  basicCase("mute-hats", "Mute the hats", mix, setsFlag("Hats", "muted"), tracks("Hats")),
  basicCase(
    "solo-bass",
    "Solo the bass",
    mix,
    setsFlag("Bass", "soloed"),
    tracks("Bass"),
  ),
  basicCase(
    "vocals-to-top",
    "Move the vocals to the top",
    mix,
    movesToTop("Vocals"),
    ALL_TRACKS,
  ),
  basicCase(
    "kick-down",
    "Turn the kick down 3 dB",
    mix,
    changesVolumeBy("Kick", -3),
    tracks("Kick"),
  ),
  basicCase(
    "pan-guitar",
    "Pan the guitar left",
    mix,
    pansLeft("Guitar"),
    tracks("Guitar"),
  ),
  // Instruments and sounds (13 to 16)
  basicCase(
    "longer-kick",
    "Pick a longer kick sample for this drum machine",
    createBasicKitProject,
    swapsToLongerSample("Drums", "Kick", "kick"),
    tracks("Drums"),
    { selection: { tracks: ["Drums"] } },
  ),
  basicCase(
    "add-clap",
    "Add a clap to the drum machine",
    createBasicKitProject,
    addsPadWithRole("Drums", "clap"),
    tracks("Drums"),
  ),
  basicCase(
    "synth-to-sampler",
    "Swap this synth for a sampler",
    createBasicSynthProject,
    swapsInstrument("Synth", "sampler"),
    tracks("Synth"),
    { selection: { tracks: ["Synth"] } },
  ),
  basicCase(
    "lower-cutoff",
    "Lower the synth's filter cutoff",
    createBasicSynthProject,
    lowersParameter("Synth", SYNTH_FILTER_CUTOFF),
    tracks("Synth"),
  ),
  // Effects (17 to 21)
  basicCase(
    "add-reverb",
    "Add a reverb to the snare",
    mix,
    addsDevice("Snare", "reverb"),
    tracks("Snare"),
  ),
  basicCase(
    "remove-reverb",
    "Take the reverb off again",
    () => createBasicMixProject({ snareReverb: true }),
    removesDevice("Snare", "reverb"),
    tracks("Snare"),
    {
      history: after(
        "Add a reverb to the snare",
        "I've added a Reverb to the Snare track.",
      ),
    },
  ),
  basicCase(
    "wetter-reverb",
    "Make the reverb wetter",
    createBasicEffectsProject,
    raisesDeviceParameter("Vocals", "reverb", "wet"),
    tracks("Vocals"),
  ),
  basicCase(
    "delay-before-reverb",
    "Put the delay before the reverb",
    createBasicEffectsProject,
    putsBefore("Vocals", "delay", "reverb"),
    tracks("Vocals"),
  ),
  basicCase(
    "reverb-send",
    "Set up a reverb send for the vocals and drums",
    arrangement,
    setsUpSend(["Vocals", "Drums"], "reverb"),
    { ...tracks("Vocals", "Drums"), returns: true },
  ),
  // Notes and MIDI (22 to 26)
  basicCase(
    "quantize-hats",
    "Quantize the hi-hats to 16ths",
    () => createBasicNotesProject(true),
    quantizes("Hats"),
    tracks("Hats"),
  ),
  basicCase(
    "transpose-melody",
    "Transpose the melody up an octave",
    notes,
    transposes("Melody", 12),
    tracks("Melody"),
  ),
  basicCase(
    "humanize-hats",
    "Make the hats less robotic",
    notes,
    humanizes("Hats"),
    tracks("Hats"),
  ),
  basicCase(
    "double-speed",
    "Double the bassline speed",
    notes,
    doublesSpeed("Bassline"),
    tracks("Bass"),
  ),
  basicCase(
    "clear-clip",
    "Clear the notes in this clip",
    notes,
    clearsClip("Chords"),
    tracks("Chords"),
    { selection: { clips: ["Chords"] } },
  ),
  // Song-wide (27, 28)
  basicCase(
    "tempo",
    "Change the tempo to 124 BPM",
    arrangement,
    setsTempo(124),
    SONG_ONLY,
  ),
  basicCase(
    "key",
    "Change the key to A minor",
    arrangement,
    setsKey(9, "minor"),
    SONG_ONLY,
  ),
  // Asking instead of guessing (29, 30)
  basicCase(
    "undo",
    "Undo that",
    () => createBasicMixProject({ hatsMuted: true }),
    restores(mix),
    tracks("Hats"),
    {
      history: after("Mute the hats", "I've muted the Hats track."),
    },
  ),
  basicCase(
    "missing-track",
    "Delete the strings track",
    mix,
    proposesNothing("the project has no strings track"),
    tracks(),
    { expect: "explain" },
  ),
];
