/**
 * The assistant's tool schema (GRV-4, PRD AI-03 and AI-05).
 *
 * The assistant changes a project only through shared commands, and only
 * through the allowlisted subset below. Each tool is one registered command:
 * its name is the command type with `_` for `.`, its input schema is generated
 * from the command's own Zod payload schema (the create tools take the entity
 * itself instead, see {@link ToolInput}), and a call is turned back into that
 * command with the registered version pinned. Nothing here applies a
 * command — `proposal.ts` validates a set of calls and `proposalExecutor.ts`
 * hands them to the command history as one transaction.
 *
 * ## Appendix A families and the commands that carry them
 *
 * The PRD's Appendix A named the families the allowlist should cover before
 * the command layer existed, so its names are not the registry's. Each family
 * maps onto a capability key (the `capability` analytics parameter) and the
 * registered commands that do its job:
 *
 * | Appendix A family                     | Capability   | Commands |
 * | ------------------------------------- | ------------ | -------- |
 * | `project.setTempo`                    | `tempo`      | `parameter.set` on `song.tempo` and `song.swing` (the groove's timing, GRV-5) only |
 * | `track.add/update/move/duplicate/remove` | `tracks`  | `track.create`, `track.update`, `track.reorder`, `track.delete` |
 * | `clip.add/update/duplicate/remove`    | `clips`      | `clip.create`, `clip.update`, `clip.delete` |
 * | `note.add/update/transform/remove`    | `notes`      | `note.*` and every `notes.*` transform |
 * | `placement.add/update/duplicate/remove` | `placements` | `placement.create`, `placement.update`, `placement.delete` |
 * | `instrument.set/setParameter`         | `instrument` | `instrument.change`, `instrument.setSample`, `drum.setPadAsset`, `drum.setPadParameter`, `parameter.set` on an instrument |
 * | `device.add/update/move/duplicate/remove` | `devices` | `device.add/remove/reorder/duplicate/setBypass/reset`, `parameter.set` on a device in any chain |
 * | `send.setLevel`, `return.add/update/remove` | `returns` | `return.create/update/delete`, `send.add/remove`, `parameter.set` on a send or a return |
 * | `mixer.setParameter`                  | `mixer`      | `parameter.set` on a track strip or the master, `track.setFlag` (mute, solo) |
 * | `transaction.apply`                   | —            | Every proposal is one transaction; a proposal spanning capabilities reports `mixed` |
 * | `section.add/update/move/remove`      | —            | No section command exists yet |
 * | `automation.addLane/setPoints/transform/removeLane` | — | No automation command exists yet |
 *
 * A `duplicate` is a create with new IDs (the command layer has no separate
 * duplicate for tracks, clips or placements; `device.duplicate` is the one
 * that exists). Section and automation commands are a contract change of their
 * own, so until they land those families are absent and their lanes cannot be
 * slipped in through a create's restore fields either (see `refuse` below).
 *
 * The one tool that is not a command, `ask_producer` (GRV-42), lives in
 * `ask.ts`: it asks the producer a question and changes nothing, so it is
 * offered beside these but never reaches a proposal.
 *
 * Commands the assistant may not call at all are pinned in
 * {@link NON_ASSISTANT_COMMANDS}, so a newly registered command needs a
 * decision here before the tests pass.
 */
import { type ZodType, z } from "zod";
import type { ClipCreatePayload } from "../commands/definitions/clips";
import type { DrumSetPadParameterPayload } from "../commands/definitions/drum";
import {
  type ParameterSetPayload,
  parameterDefinitionAt,
} from "../commands/definitions/parameters";
import type { PlacementCreatePayload } from "../commands/definitions/placements";
import type { TrackCreatePayload } from "../commands/definitions/tracks";
import { findCommand } from "../commands/registry";
import type { PayloadParseResult } from "../commands/types";
import {
  clipSchema,
  type Project,
  placementSchema,
  trackSchema,
} from "../domain/entities";
import {
  bareParameterId,
  getParameterDefinition,
  isParameterValueInRange,
  MASTER_VOLUME,
  type ParameterDefinition,
  RETURN_PAN,
  RETURN_VOLUME,
  SAMPLER_PARAMETERS,
  SONG_SWING,
  SONG_TEMPO,
  SYNTH_PARAMETERS,
  TRACK_PAN,
  TRACK_SEND_LEVEL,
  TRACK_VOLUME,
} from "../domain/parameters";
import {
  COMPACT_NOTE_DESCRIPTION,
  compactClipSchema,
  compactNoteAddSchema,
} from "./compactNotes";
import type { TacticValues } from "./tactics";

/**
 * Bumped whenever a tool is added, removed, renamed or changes its rules,
 * `ask_producer` (`ask.ts`) included.
 * 2: `parameter_set` may set the song's swing as well as its tempo (GRV-5).
 * 3: `ask_producer` lets the assistant ask the producer a question (GRV-42).
 * 4: its options may carry references, sounds and predicates (GRV-42).
 * 5: `parameter_set` names its parameter IDs, and `explain_change` carries a
 *    proposal's goal and technique (GRV-5).
 * 6: a turn that carries the library is offered `recommend_sounds`
 *    (`recommendation.ts`, GRV-23).
 * 7: a turn that carries the producer's memory is offered `remember_producer`
 *    (`memory.ts`), and `ask_producer` takes a `memoryQuestion` (GRV-25).
 * 8: `track_create`, `clip_create` and `placement_create` take the entity
 *    itself, flat, and create only it: a track's clips and their placements
 *    are calls of their own (GRV-90).
 * 9: `clip_create` and `note_add` take each note as a short array with no ID,
 *    which the gateway writes out as a note event (`compactNotes.ts`,
 *    GRV-131).
 */
export const ASSISTANT_TOOLSET_VERSION = 9;

/** The song's own parameters the assistant may set: its tempo and its swing. */
const SONG_PARAMETER_IDS: readonly string[] = [SONG_TEMPO.id, SONG_SWING.id];

/** One key per Appendix A family the allowlist carries. */
export const ASSISTANT_CAPABILITIES = [
  "tempo",
  "tracks",
  "clips",
  "notes",
  "placements",
  "instrument",
  "devices",
  "returns",
  "mixer",
] as const;
export type AssistantCapability = (typeof ASSISTANT_CAPABILITIES)[number];

/** What a proposal reports when its commands span more than one capability. */
export const MIXED_CAPABILITY = "mixed";
export type ProposalCapability = AssistantCapability | typeof MIXED_CAPABILITY;

/** The `capability` analytics values a proposal can produce. */
export const PROPOSAL_CAPABILITIES: readonly ProposalCapability[] = [
  ...ASSISTANT_CAPABILITIES,
  MIXED_CAPABILITY,
];

/** The Appendix A families, as the PRD named them, and where each one went. */
export const APPENDIX_A_FAMILIES: Readonly<
  Record<string, AssistantCapability | "transaction" | "unavailable">
> = {
  "project.setTempo": "tempo",
  "track.add": "tracks",
  "track.update": "tracks",
  "track.move": "tracks",
  "track.duplicate": "tracks",
  "track.remove": "tracks",
  "clip.add": "clips",
  "clip.update": "clips",
  "clip.duplicate": "clips",
  "clip.remove": "clips",
  "note.add": "notes",
  "note.update": "notes",
  "note.transform": "notes",
  "note.remove": "notes",
  "placement.add": "placements",
  "placement.update": "placements",
  "placement.duplicate": "placements",
  "placement.remove": "placements",
  "section.add": "unavailable",
  "section.update": "unavailable",
  "section.move": "unavailable",
  "section.remove": "unavailable",
  "instrument.set": "instrument",
  "instrument.setParameter": "instrument",
  "device.add": "devices",
  "device.update": "devices",
  "device.move": "devices",
  "device.duplicate": "devices",
  "device.remove": "devices",
  "send.setLevel": "returns",
  "return.add": "returns",
  "return.update": "returns",
  "return.remove": "returns",
  "automation.addLane": "unavailable",
  "automation.setPoints": "unavailable",
  "automation.transform": "unavailable",
  "automation.removeLane": "unavailable",
  "mixer.setParameter": "mixer",
  "transaction.apply": "transaction",
};

/**
 * Registered commands the assistant cannot call, and why. Pinned so that a
 * command added to the registry has to be allowlisted or listed here.
 */
export const NON_ASSISTANT_COMMANDS: Readonly<Record<string, string>> = {
  "pack.add": "Pack dependencies are library state, derived from assets",
  "pack.remove": "Pack dependencies are library state, derived from assets",
  "pack.setVersion": "Pack versions are the producer's choice",
  "asset.add":
    "Sounds come from the library, which the assistant cannot browse yet; it picks among the project's own assets",
  "asset.remove": "Assets are removed by the producer",
  "device.restoreParameters": "Only the inverse of device.reset",
  "drum.renamePad": "Not in the alpha capability set",
  "drum.setPadFlag": "Not in the alpha capability set",
  "drum.setPadChoke": "Not in the alpha capability set",
  "drum.addPad": "Not in the alpha capability set",
  "drum.removePad": "Not in the alpha capability set",
  "drum.reorderPad": "Not in the alpha capability set",
  "loop.setRange": "The loop is the producer's playback state",
  "loop.setEnabled": "The loop is the producer's playback state",
  "key.set": "Not in the alpha capability set",
  "project.rename": "The project's name is the producer's",
};

type ParameterScope = ParameterSetPayload["target"]["scope"];

/** Which capability `parameter.set` falls under, by its target's scope. */
const PARAMETER_SCOPE_CAPABILITY: Record<ParameterScope, AssistantCapability> = {
  song: "tempo",
  instrument: "instrument",
  trackDevice: "devices",
  returnDevice: "devices",
  masterDevice: "devices",
  send: "returns",
  return: "returns",
  track: "mixer",
  master: "mixer",
};

function automationRestore(payload: unknown): string | null {
  const automation = (payload as { automation?: readonly unknown[] }).automation;
  return automation && automation.length > 0
    ? "Automation lanes are not in the assistant's tool set yet"
    : null;
}

interface ToolRule {
  readonly commandType: string;
  readonly description: string;
  /** The capability one parsed payload falls under. */
  readonly capability: (payload: unknown) => AssistantCapability;
  /** Every capability the tool can fall under, for the family tables. */
  readonly capabilities: readonly AssistantCapability[];
  /** Why this parsed payload is not allowed, or null when it is. */
  readonly refuse?: (payload: unknown) => string | null;
  /**
   * Why this payload's value is not allowed against `project`, the state the
   * command would apply to, or null when it is. A command clamps a value into
   * its parameter's range; the assistant's is refused instead (PRD AI-03:
   * invalid values are rejected before mutation).
   */
  readonly refuseValue?: (payload: unknown, project: Project) => string | null;
  /** What the tool takes, when that is not the command's payload. */
  readonly input?: ToolInput;
  /**
   * What the model is offered, when the gateway rewrites it into the tool's
   * input before the call joins a proposal: notes as short arrays
   * (`compactNotes.ts`, GRV-131). The browser only ever resolves the input.
   */
  readonly offered?: ZodType<unknown>;
}

function rule(
  commandType: string,
  capability: AssistantCapability,
  description: string,
  refuse?: ToolRule["refuse"],
): ToolRule {
  return {
    commandType,
    description,
    capability: () => capability,
    capabilities: [capability],
    refuse,
  };
}

/** Why `value` is outside `definition`'s range, or null when it is inside. */
function outOfRange(
  definition: ParameterDefinition | undefined,
  value: number,
): string | null {
  // A target that does not resolve is the kernel's to refuse, with its reason.
  if (!definition || isParameterValueInRange(definition, value)) return null;
  return `${definition.label} must be between ${definition.min} and ${definition.max}; ${value} is out of range`;
}

const UNIT_WORDS: Readonly<Record<ParameterDefinition["unit"], string>> = {
  bars: " bars",
  bpm: " BPM",
  decibels: " dB",
  normalized: "",
  bipolar: ", -1 left to 1 right",
  hertz: " Hz",
  percent: "%",
  seconds: " s",
  semitones: " semitones",
};

/** `track.volume (-60 to 6 dB)`: an ID as the target takes it, and its range. */
function describeParameter(definition: ParameterDefinition, id = definition.id): string {
  return `${id} (${definition.min} to ${definition.max}${UNIT_WORDS[definition.unit]})`;
}

function describeParameters(definitions: readonly ParameterDefinition[], bare = false) {
  return definitions
    .map((definition) =>
      describeParameter(
        definition,
        bare ? bareParameterId(definition.id) : definition.id,
      ),
    )
    .join(", ");
}

/**
 * Which `parameterId` each target scope takes, generated from the parameter
 * definitions. Without it a model guesses (`volume` for `track.volume`), and
 * every such proposal is refused.
 */
export const PARAMETER_SET_DESCRIPTION = [
  "Set one numeric parameter. A value outside the parameter's range is refused, never clamped. The parameterId must be exactly one of these, by the target's scope:",
  `song: ${describeParameters([SONG_TEMPO, SONG_SWING])}, where swing 50 is straight;`,
  `track (a track's mixer strip): ${describeParameters([TRACK_VOLUME, TRACK_PAN])};`,
  `send: ${describeParameters([TRACK_SEND_LEVEL])};`,
  `return: ${describeParameters([RETURN_VOLUME, RETURN_PAN])};`,
  `master: ${describeParameters([MASTER_VOLUME])};`,
  `instrument, on a synth track: ${describeParameters(SYNTH_PARAMETERS, true)};`,
  `instrument, on a sampler track: ${describeParameters(SAMPLER_PARAMETERS, true)};`,
  "trackDevice, returnDevice, masterDevice: the device's parameter name, without the device type.",
  "A track's volume and pan are its mixer fader and pan, in the project description as each track's volume and pan.",
].join(" ");

const PARAMETER_SET_RULE: ToolRule = {
  commandType: "parameter.set",
  description: PARAMETER_SET_DESCRIPTION,
  capability: (payload) =>
    PARAMETER_SCOPE_CAPABILITY[(payload as ParameterSetPayload).target.scope],
  capabilities: [...new Set(Object.values(PARAMETER_SCOPE_CAPABILITY))],
  refuse(payload) {
    const { target } = payload as ParameterSetPayload;
    if (target.scope === "song" && !SONG_PARAMETER_IDS.includes(target.parameterId)) {
      return `Only ${SONG_PARAMETER_IDS.join(" and ")} may be set at song scope`;
    }
    return null;
  },
  refuseValue(payload, project) {
    const { target, value } = payload as ParameterSetPayload;
    return outOfRange(parameterDefinitionAt(project, target), value);
  },
};

const DRUM_PAD_PARAMETER_RULE: ToolRule = {
  ...rule(
    "drum.setPadParameter",
    "instrument",
    "Set a drum pad's volume, pan, pitch, attack or decay. A value outside the parameter's range is refused, never clamped.",
  ),
  refuseValue(payload) {
    const { parameterId, value } = payload as DrumSetPadParameterPayload;
    return outOfRange(getParameterDefinition(parameterId), value);
  },
};

/**
 * A tool whose input is not its command's payload as it stands. The three
 * create tools take the entity itself, flat, and one entity per call (GRV-90):
 * the model wrapped `track.create`'s `{track, clips, placements}` in a second
 * `track` key in most runs that created a track, whatever the description
 * said, and the same with `clip.create`'s `{clip, placements}`. A track, its
 * clips and their placements are three calls in order instead, which also
 * keeps each call's input small.
 */
interface ToolInput {
  /** What the model sends; the tool's input schema is generated from it. */
  readonly schema: ZodType<unknown>;
  /** The command payload a parsed input stands for. */
  readonly toPayload: (input: unknown) => unknown;
  /**
   * The calls a parsed payload stands for, in order, or null when no calls
   * can express it (a create carrying automation lanes).
   */
  readonly fromPayload: (payload: unknown) => readonly AssistantToolInvocation[] | null;
}

/** One call as the model makes it: a tool's name and its input. */
export interface AssistantToolInvocation {
  readonly name: string;
  readonly input: unknown;
}

const placementCalls = (placements: readonly unknown[]): AssistantToolInvocation[] =>
  placements.map((input) => ({ name: "placement_create", input }));

/**
 * The flat inputs the create tools take, each accepted as it stands. The
 * track's and the placement's are shown to the model in their tools'
 * descriptions; the clip's is not, since its notes are written out: it is
 * what the gateway makes of {@link OFFERED_CLIP_EXAMPLE}, which is shown, in a
 * turn whose stem is `BassNote000000000` (`compactNotes.ts`).
 */
export const CREATE_EXAMPLES = {
  track: {
    id: "trk_BassTrack000000000001",
    name: "Bass",
    color: "#808080",
    order: 1,
    type: "instrument",
    instrument: { kind: "synth", parameters: {} },
    devices: [],
    sendConfig: [],
    mixer: { volume: 0, pan: 0, muted: false, soloed: false },
  },
  clip: {
    id: "clp_BassLine0000000000001",
    trackId: "trk_BassTrack000000000001",
    name: "Bassline",
    color: "#808080",
    lengthTicks: 768,
    content: {
      kind: "notes",
      events: [
        {
          id: "evt_BassNote000000000n001",
          trigger: { kind: "pitch", pitch: 36 },
          startTicks: 0,
          durationTicks: 192,
          velocity: 0.8,
          probability: null,
        },
      ],
    },
  },
  placement: {
    id: "plc_BassPlace000000000001",
    clipId: "clp_BassLine0000000000001",
    trackId: "trk_BassTrack000000000001",
    startTicks: 0,
    durationTicks: 768,
    clipOffsetTicks: 0,
    looped: true,
  },
} as const;

/**
 * The clip `clip_create`'s description shows: its notes as the model writes
 * them (GRV-131).
 */
export const OFFERED_CLIP_EXAMPLE = {
  ...CREATE_EXAMPLES.clip,
  content: { kind: "notes", events: [[0, 36, 192, 0.8]] },
} as const;

const TRACK_INPUT: ToolInput = {
  schema: trackSchema,
  toPayload: (track) => ({ track, clips: [], placements: [], automation: [] }),
  fromPayload(payload) {
    const { track, clips, placements, automation } = payload as TrackCreatePayload;
    if (automation.length > 0) return null;
    return [
      { name: "track_create", input: track },
      ...clips.map((input) => ({ name: "clip_create", input })),
      ...placementCalls(placements),
    ];
  },
};

const CLIP_INPUT: ToolInput = {
  schema: clipSchema,
  toPayload: (clip) => ({ clip, placements: [] }),
  fromPayload(payload) {
    const { clip, placements } = payload as ClipCreatePayload;
    return [{ name: "clip_create", input: clip }, ...placementCalls(placements)];
  },
};

const PLACEMENT_INPUT: ToolInput = {
  schema: placementSchema,
  toPayload: (placement) => ({ placement }),
  fromPayload: (payload) =>
    placementCalls([(payload as PlacementCreatePayload).placement]),
};

const TRACK_CREATE_DESCRIPTION = [
  "Add a track with its instrument and no clips. The input is the track itself, its fields at the top level: id, name, color, order, type, instrument, devices, sendConfig, mixer.",
  "Give it clips with clip_create and place them with placement_create, as later calls in the same reply.",
  "Duplicate a track by creating a copy with new IDs, then copies of its clips and placements.",
  `Example input: ${JSON.stringify(CREATE_EXAMPLES.track)}`,
].join(" ");

const CLIP_CREATE_DESCRIPTION = [
  "Add a clip to a track: one in the project, or one track_create made earlier in this reply. The input is the clip itself, its fields at the top level: id, trackId, name, color, lengthTicks, content.",
  "A clip plays only once placed: follow it with placement_create.",
  "Duplicate a clip as an independent variation by creating a copy with a new clip ID (its notes, as always here, take no ID).",
  `Each note in content.events is an array, [startTicks, pitch, durationTicks, velocity], with no ID; a drum hit has its pad's ID in place of the pitch, e.g. [0, "pad_...", 48, 0.9]; an optional fifth number is its probability.`,
  `Example input: ${JSON.stringify(OFFERED_CLIP_EXAMPLE)}`,
].join(" ");

const NOTE_ADD_DESCRIPTION = [
  "Add notes to a clip.",
  `Each note is an array, [startTicks, pitch, durationTicks, velocity], with no ID; a drum hit has its pad's ID in place of the pitch, e.g. [0, "pad_...", 48, 0.9]; an optional fifth number is its probability.`,
  `Example input: ${JSON.stringify({
    clipId: CREATE_EXAMPLES.clip.id,
    notes: [
      [0, 36, 192, 0.8],
      [384, 43, 192, 0.7],
    ],
  })}`,
].join(" ");

const PLACEMENT_CREATE_DESCRIPTION = [
  "Place a clip on its track's timeline: a clip in the project, or one clip_create made earlier in this reply. The input is the placement itself, its fields at the top level: id, clipId, trackId, startTicks, durationTicks, clipOffsetTicks, looped.",
  `Example input: ${JSON.stringify(CREATE_EXAMPLES.placement)}`,
].join(" ");

/** A rule whose tool takes {@link ToolInput} rather than the command's payload. */
function flatRule(
  commandType: string,
  capability: AssistantCapability,
  description: string,
  input: ToolInput,
): ToolRule {
  return { ...rule(commandType, capability, description), input };
}

/** The allowlist, in the order the tools are offered to the model. */
const TOOL_RULES: readonly ToolRule[] = [
  PARAMETER_SET_RULE,
  flatRule("track.create", "tracks", TRACK_CREATE_DESCRIPTION, TRACK_INPUT),
  rule("track.update", "tracks", "Rename or recolour a track."),
  rule("track.reorder", "tracks", "Move a track to a new position in the track list."),
  rule("track.delete", "tracks", "Remove a track and its clips and placements."),
  {
    ...flatRule("clip.create", "clips", CLIP_CREATE_DESCRIPTION, CLIP_INPUT),
    offered: compactClipSchema,
  },
  rule("clip.update", "clips", "Rename, recolour or resize a clip."),
  rule("clip.delete", "clips", "Remove a clip and every placement of it."),
  { ...rule("note.add", "notes", NOTE_ADD_DESCRIPTION), offered: compactNoteAddSchema },
  rule("note.update", "notes", "Move, resize, re-pitch or re-velocity note events."),
  rule("note.remove", "notes", "Remove note events from a clip."),
  rule("notes.transpose", "notes", "Transpose a clip's notes, or some of them."),
  rule("notes.scaleVelocity", "notes", "Scale the velocity of a clip's notes."),
  rule("notes.quantize", "notes", "Quantize a clip's notes to a grid."),
  rule("notes.quantizeToScale", "notes", "Move a clip's notes onto a scale."),
  rule(
    "notes.duplicate",
    "notes",
    "Repeat a clip's notes later in the clip. newIds holds one new note ID per note copied (every note in the clip when eventIds is null), in order, made from this turn's stem.",
  ),
  rule("notes.clear", "notes", "Remove every note from a clip."),
  rule("notes.vary", "notes", "Vary a clip's notes deterministically from a seed."),
  flatRule(
    "placement.create",
    "placements",
    PLACEMENT_CREATE_DESCRIPTION,
    PLACEMENT_INPUT,
  ),
  rule("placement.update", "placements", "Move, resize, trim or loop a placement."),
  rule("placement.delete", "placements", "Remove a placement from the timeline."),
  rule(
    "instrument.change",
    "instrument",
    "Replace a track's instrument (sampler, synth or drum machine).",
  ),
  rule(
    "instrument.setSample",
    "instrument",
    "Point a sampler at an asset already in the project.",
  ),
  rule(
    "drum.setPadAsset",
    "instrument",
    "Point a drum pad at an asset already in the project.",
  ),
  DRUM_PAD_PARAMETER_RULE,
  rule("device.add", "devices", "Add a device to a track, return or master chain."),
  rule("device.remove", "devices", "Remove a device from its chain."),
  rule("device.reorder", "devices", "Move a device within its chain."),
  rule("device.duplicate", "devices", "Duplicate a device next to itself."),
  rule("device.setBypass", "devices", "Bypass or re-enable a device."),
  rule("device.reset", "devices", "Return a device's parameters to their defaults."),
  rule("return.create", "returns", "Add a return bus.", automationRestore),
  rule("return.update", "returns", "Rename a return bus."),
  rule("return.delete", "returns", "Remove a return bus and every send to it."),
  rule("send.add", "returns", "Send a track to a return bus.", automationRestore),
  rule("send.remove", "returns", "Remove a track's send to a return bus."),
  rule("track.setFlag", "mixer", "Mute, unmute, solo or unsolo a track."),
];

/**
 * The tool definitions' text at each level of the `toolText` tactic (GRV-146).
 *
 * `full` is every description as written above, in {@link TOOL_RULES} and in
 * the schemas' `.describe()` calls. The two trimmed levels sit here beside
 * them, so one diff shows what each cut, and {@link withToolText} swaps them
 * in. Only words change: the tools, their names and their schemas do not. A
 * rule many tools repeated (IDs, tick units, a create's flat shape, a note's
 * array, a duplicate's new IDs) is said once in the prompt's shared tool rules
 * (`prompt.ts`), which is sent whenever a trimmed level is, and a range that
 * comes from `parameters.ts` is still generated from there.
 *
 * - `moderate` cuts repetition and examples the schema already makes plain
 *   and keeps every constraint in plain words.
 * - `aggressive` is one line a tool, constraints only, and no example.
 *
 * A tool with no entry keeps its full description at every level: its text is
 * a line already.
 */
export type ToolTextLevel = TacticValues["toolText"];

interface TrimmedText {
  readonly moderate: string;
  readonly aggressive: string;
}

/** A description in the form each trimmed level is written, keyed by tool name. */
export const TOOL_TEXT: Readonly<Record<string, TrimmedText>> = {
  parameter_set: {
    moderate: [
      "Set one numeric parameter. The parameterId must be exactly one of these, by the target's scope:",
      `song: ${describeParameters([SONG_TEMPO, SONG_SWING])}, where swing 50 is straight;`,
      `track: ${describeParameters([TRACK_VOLUME, TRACK_PAN])};`,
      `send: ${describeParameters([TRACK_SEND_LEVEL])};`,
      `return: ${describeParameters([RETURN_VOLUME, RETURN_PAN])};`,
      `master: ${describeParameters([MASTER_VOLUME])};`,
      `instrument, synth track: ${describeParameters(SYNTH_PARAMETERS, true)};`,
      `instrument, sampler track: ${describeParameters(SAMPLER_PARAMETERS, true)};`,
      "trackDevice, returnDevice, masterDevice: the device's parameter name, without the device type.",
    ].join(" "),
    aggressive: [
      "Set one numeric parameter; parameterId must be exactly one of these for the target's scope:",
      `song: ${describeParameters([SONG_TEMPO, SONG_SWING])};`,
      `track: ${describeParameters([TRACK_VOLUME, TRACK_PAN])};`,
      `send: ${describeParameters([TRACK_SEND_LEVEL])};`,
      `return: ${describeParameters([RETURN_VOLUME, RETURN_PAN])};`,
      `master: ${describeParameters([MASTER_VOLUME])};`,
      `synth: ${SYNTH_PARAMETERS.map((definition) => bareParameterId(definition.id)).join(", ")};`,
      `sampler: ${describeParameters(SAMPLER_PARAMETERS, true)};`,
      "devices: the bare parameter name.",
    ].join(" "),
  },
  track_create: {
    moderate:
      "Add a track with its instrument and no clips. The input is the track itself, its fields at the top level: id, name, color, order, type, instrument, devices, sendConfig, mixer. Give it clips with clip_create and place them with placement_create, as later calls in the same reply.",
    aggressive:
      "Add a track with its instrument and no clips; its clips and placements are later calls.",
  },
  clip_create: {
    moderate:
      "Add a clip to a track: one in the project, or one track_create made earlier in this reply. The input is the clip itself, its fields at the top level: id, trackId, name, color, lengthTicks, content. A clip plays only once placed: follow it with placement_create. Each note in content.events is an array with no ID.",
    aggressive:
      "Add a clip to a track in the project or one made earlier in this reply; place it with placement_create.",
  },
  note_add: {
    moderate:
      "Add notes to a clip. Each note is an array, [startTicks, pitch, durationTicks, velocity], with no ID; a drum hit has its pad's ID in place of the pitch.",
    aggressive: "Add notes to a clip.",
  },
  placement_create: {
    moderate:
      "Place a clip on its track's timeline: a clip in the project, or one clip_create made earlier in this reply. The input is the placement itself, its fields at the top level: id, clipId, trackId, startTicks, durationTicks, clipOffsetTicks, looped.",
    aggressive:
      "Place a clip on its track's timeline: one in the project or made earlier in this reply.",
  },
  notes_duplicate: {
    moderate:
      "Repeat a clip's notes later in the clip. newIds holds one new note ID per note copied (every note in the clip when eventIds is null), in order.",
    aggressive:
      "Repeat a clip's notes later in the clip; newIds is one new ID per note copied.",
  },
  drum_setPadParameter: {
    moderate:
      "Set a drum pad's volume, pan, pitch, attack or decay. A value outside the range is refused.",
    aggressive: "Set a drum pad's volume, pan, pitch, attack or decay.",
  },
  explain_change: {
    moderate:
      "Explain the change you are proposing: call it exactly once with every proposal, alongside the calls that make it. It changes nothing.",
    aggressive: "Call exactly once per proposal, with its calls, to explain it.",
  },
  ask_producer: {
    moderate:
      "Ask the producer a question with 2 to 8 options when you need their choice to go on: which direction, which part, how far. One question at a time, only when the answer changes what you do next, and say nothing after it. An option can point at a track, clip or bars (ref), let them hear it (sound), or be answered by them making the change (doneWhen). This changes nothing in the song.",
    aggressive:
      "Ask the producer a question with 2 to 8 options when you need their choice to go on. One at a time, and say nothing after it. Changes nothing in the song.",
  },
};

/**
 * Every `description` a tool's input schema carries, keyed by its full text.
 * A schema's description is found by its words, so the same sentence on two
 * fields (a note, wherever one is taken) is trimmed once.
 */
export const SCHEMA_TEXT: Readonly<Record<string, TrimmedText>> = {
  [COMPACT_NOTE_DESCRIPTION]: {
    moderate:
      "A note: [startTicks, pitch, durationTicks, velocity]; a drum hit's pad ID replaces the MIDI pitch; an optional fifth number is its probability. No ID.",
    aggressive:
      "[startTicks, pitch, durationTicks, velocity, probability?]; a pad ID for a drum hit.",
  },
  "What the producer will hear once it is applied, in one sentence, e.g. 'The beat feels played rather than programmed.' Not the request repeated.":
    {
      moderate:
        "What the producer will hear once it is applied, in one sentence. Not the request repeated.",
      aggressive: "What the producer will hear, in one sentence.",
    },
  "The production technique behind the change and why it gets to the goal, in one or two sentences a producer could reuse, e.g. 'Swing delays every second 16th note, so the hits lean back like a drummer's.' Not the values restated.":
    {
      moderate:
        "The production technique behind the change and why it gets to the goal, in one or two sentences a producer could reuse. Not the values restated.",
      aggressive: "The technique behind the change, in one or two reusable sentences.",
    },
  "The question, short and in the producer's terms.": {
    moderate: "The question, short, in the producer's terms.",
    aggressive: "The question, short.",
  },
  'What the question is about, as a header line, such as "The build, bars 13-16".': {
    moderate:
      'What the question is about, as a header line, e.g. "The build, bars 13-16".',
    aggressive: "A header line: what the question is about.",
  },
  "What the producer picks, in a few words.": {
    moderate: "What the producer picks.",
    aggressive: "What is picked, in a few words.",
  },
  "One line on what picking it means, when the label is not enough.": {
    moderate: "One line on what picking it means.",
    aggressive: "One line on what picking it means.",
  },
  "The first bar, counting from 1.": {
    moderate: "The first bar, from 1.",
    aggressive: "First bar, from 1.",
  },
  "The last bar, inclusive.": {
    moderate: "The last bar, inclusive.",
    aggressive: "Last bar, inclusive.",
  },
  "The track, clip or bars the option is about: highlighted in the editor while the producer hovers it, and selected when they pick it.":
    {
      moderate:
        "The track, clip or bars the option is about, highlighted on hover and selected on pick.",
      aggressive: "The track, clip or bars the option is about.",
    },
  "One of your change tools, such as parameter_set.": {
    moderate: "One of your change tools, such as parameter_set.",
    aggressive: "A change tool's name.",
  },
  "Its input, as you would call it.": {
    moderate: "Its input, as you would call it.",
    aggressive: "Its input.",
  },
  'What the producer hears while hovering the option: a track\'s instrument ("track"), or the song with changes you could make ("preview", the same calls as a proposal; nothing is applied).':
    {
      moderate:
        'What the producer hears on hover: a track\'s instrument ("track"), or the song with changes ("preview", the same calls as a proposal; nothing is applied).',
      aggressive:
        'A track\'s instrument ("track") or a "preview" of calls, nothing applied.',
    },
  "The song's swing, in percent: 50 is straight, 75 the most.": {
    moderate: "The song's swing, in percent: 50 is straight, 75 the most.",
    aggressive: "Swing in percent: 50 straight, 75 most.",
  },
  "Set true when the option says the new track has a part (a pattern, a line, a groove): it then counts only once the track holds a clip with notes. An empty new track never answers such an option.":
    {
      moderate:
        "Set true when the new track has a part (a pattern, a line, a groove): it counts only once the track holds a clip with notes.",
      aggressive: "True when the new track has a part: counts once it holds notes.",
    },
  "A change the producer can make in the editor instead of picking: when it happens, the question is answered as this option.":
    {
      moderate:
        "A change the producer can make in the editor instead of picking; it answers the question as this option.",
      aggressive: "An editor change that answers the question as this option.",
    },
  "2 to 8 answers to pick from. The producer can always type their own.": {
    moderate: "2 to 8 answers to pick from.",
    aggressive: "2 to 8 answers.",
  },
  "The index of the option you would pick, if you have a view.": {
    moderate: "The index of the option you would pick.",
    aggressive: "Index of the option you would pick.",
  },
  "Whether the producer may pick more than one option.": {
    moderate: "Whether more than one may be picked.",
    aggressive: "Whether more than one may be picked.",
  },
  'When this is the question memory names in "askLater", its name, so it is not asked again.':
    {
      moderate: 'The "askLater" question this is, so it is not asked again.',
      aggressive: 'The "askLater" question this asks.',
    },
};

type TextCarrier = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
};

/** `value` with every schema `description` at `level`; the same object when `level` is full. */
function trimSchemaText(value: unknown, level: "moderate" | "aggressive"): unknown {
  if (Array.isArray(value)) return value.map((item) => trimSchemaText(item, level));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "description" && typeof item === "string"
        ? (SCHEMA_TEXT[item]?.[level] ?? item)
        : trimSchemaText(item, level),
    ]),
  );
}

/**
 * `tool` with its description and its schema's descriptions at `level`
 * (GRV-146). `full` returns the tool itself, byte for byte.
 */
export function withToolText<T extends TextCarrier>(tool: T, level: ToolTextLevel): T {
  if (level === "full") return tool;
  return {
    ...tool,
    description: TOOL_TEXT[tool.name]?.[level] ?? tool.description,
    inputSchema: trimSchemaText(tool.inputSchema, level) as JsonSchema,
  };
}

/** The tool name for a command type: `note.add` is offered as `note_add`. */
export function toolNameFor(commandType: string): string {
  return commandType.replaceAll(".", "_");
}

/** A JSON Schema object, as a provider's tool definition carries it. */
export type JsonSchema = Record<string, unknown>;

/** One tool as it is offered to the model. */
export interface AssistantToolDefinition {
  /** Matches `^[a-zA-Z0-9_-]{1,64}$`, which providers require of tool names. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly commandType: string;
  /** The registered command version a call to this tool is executed at. */
  readonly commandVersion: number;
  readonly capabilities: readonly AssistantCapability[];
}

/** The allowlisted command types, in tool order. */
export const ASSISTANT_COMMAND_TYPES: readonly string[] = TOOL_RULES.map(
  (entry) => entry.commandType,
);

const RULES_BY_NAME: ReadonlyMap<string, ToolRule> = new Map(
  TOOL_RULES.map((entry) => [toolNameFor(entry.commandType), entry]),
);

function toolDefinition(entry: ToolRule): AssistantToolDefinition {
  const command = findCommand(entry.commandType);
  if (!command) {
    throw new TypeError(`Allowlisted command "${entry.commandType}" is not registered`);
  }
  // `input` describes what the model may send: a field with a default is
  // optional to it, which is what the kernel's own parse accepts.
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(
    entry.offered ?? entry.input?.schema ?? command.schema,
    {
      io: "input",
    },
  ) as JsonSchema;
  return {
    name: toolNameFor(entry.commandType),
    description: entry.description,
    inputSchema,
    commandType: entry.commandType,
    commandVersion: command.version,
    capabilities: entry.capabilities,
  };
}

const toolCache = new Map<ToolTextLevel, readonly AssistantToolDefinition[]>();

/**
 * Every tool the assistant may call, generated once per level of text from the
 * registry. The default, `full`, is the text as written in this module.
 */
export function assistantTools(
  level: ToolTextLevel = "full",
): readonly AssistantToolDefinition[] {
  let tools = toolCache.get(level);
  if (!tools) {
    tools = TOOL_RULES.map((entry) => withToolText(toolDefinition(entry), level));
    toolCache.set(level, tools);
  }
  return tools;
}

/** The longest goal or technique an explanation may carry. */
export const MAX_EXPLANATION_LENGTH = 600;

/**
 * What `explain_change` takes: the proposal's audible goal and the technique
 * that gets there, in the assistant's words, for the card's "Why this works".
 */
export const proposalExplanationSchema = z.strictObject({
  goal: z
    .string()
    .trim()
    .min(1)
    .max(MAX_EXPLANATION_LENGTH)
    .describe(
      "What the producer will hear once it is applied, in one sentence, e.g. 'The beat feels played rather than programmed.' Not the request repeated.",
    ),
  technique: z
    .string()
    .trim()
    .min(1)
    .max(MAX_EXPLANATION_LENGTH)
    .describe(
      "The production technique behind the change and why it gets to the goal, in one or two sentences a producer could reuse, e.g. 'Swing delays every second 16th note, so the hits lean back like a drummer's.' Not the values restated.",
    ),
});
export type ProposalExplanationInput = z.infer<typeof proposalExplanationSchema>;

/**
 * The one tool that is not a command (GRV-5): it changes nothing, and says
 * what a proposal is for and how it gets there. `proposal.ts` takes it out of
 * the calls before they are resolved against the allowlist.
 */
export const EXPLAIN_TOOL_NAME = "explain_change";

const { $schema: _explainDialect, ...explainInputSchema } = z.toJSONSchema(
  proposalExplanationSchema,
  { io: "input" },
) as JsonSchema;

/**
 * Whether `calls` change anything: an explanation on its own does not, so
 * calls that are only `explain_change` are no proposal. Whatever takes other
 * calls out of a proposal (asks, videos, recommendations, memory) asks this of
 * what is left.
 */
export function makesChanges(calls: readonly { readonly name: string }[]): boolean {
  return calls.some((call) => call.name !== EXPLAIN_TOOL_NAME);
}

/** `explain_change` as it is offered to the model, beside the command tools. */
export const EXPLAIN_TOOL: Pick<
  AssistantToolDefinition,
  "name" | "description" | "inputSchema"
> = {
  name: EXPLAIN_TOOL_NAME,
  description:
    "Explain the change you are proposing: call it exactly once with every proposal, alongside the calls that make the change. It changes nothing itself.",
  inputSchema: explainInputSchema,
};

/** How one tool call resolves against the allowlist. */
export type ToolCallResolution =
  | {
      readonly ok: true;
      readonly commandType: string;
      readonly commandVersion: number;
      /** The payload as the command's schema parsed it. */
      readonly payload: unknown;
      readonly capability: AssistantCapability;
    }
  | {
      readonly ok: false;
      readonly code: "unknown_tool" | "invalid_payload" | "unauthorized";
      readonly message: string;
    };

/**
 * The payload schema behind the tool called `name`, or null when it is not an
 * assistant tool. For describing a refused call field by field; validate
 * through {@link resolveToolCall}.
 */
export function toolPayloadSchema(name: string): ZodType<unknown> | null {
  const entry = RULES_BY_NAME.get(name);
  return (
    (entry && (entry.input?.schema ?? findCommand(entry.commandType)?.schema)) ?? null
  );
}

/**
 * A call's input parsed into its command's payload. A tool that takes its own
 * shape ({@link ToolInput}) is parsed against that first, so a refusal names
 * the fields the model was shown, not the command's.
 */
function parseToolInput(
  entry: ToolRule,
  command: NonNullable<ReturnType<typeof findCommand>>,
  input: unknown,
): PayloadParseResult {
  if (!entry.input) return command.parsePayload(input);
  const parsed = entry.input.schema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message };
  }
  return command.parsePayload(entry.input.toPayload(parsed.data));
}

/**
 * Resolves one call against the allowlist: the tool must exist, its input
 * must pass the command's payload schema, and the payload must be one the
 * assistant is allowed to send. Never throws.
 */
export function resolveToolCall(name: string, input: unknown): ToolCallResolution {
  const entry = RULES_BY_NAME.get(name);
  const command = entry ? findCommand(entry.commandType) : undefined;
  if (!entry || !command) {
    return {
      ok: false,
      code: "unknown_tool",
      message: `"${name.slice(0, 64)}" is not an assistant tool`,
    };
  }
  const parsed = parseToolInput(entry, command, input);
  if (!parsed.ok) {
    return { ok: false, code: "invalid_payload", message: parsed.message };
  }
  const refusal = entry.refuse?.(parsed.payload) ?? null;
  if (refusal) {
    return { ok: false, code: "unauthorized", message: refusal };
  }
  return {
    ok: true,
    commandType: command.type,
    commandVersion: command.version,
    payload: parsed.payload,
    capability: entry.capability(parsed.payload),
  };
}

/**
 * The calls that stand for `command`, as the model would make them: the
 * inverse of {@link resolveToolCall}, for tests and scripted providers. A
 * create that carries its children becomes its own call followed by one per
 * child. A payload no call can express, or one that does not parse, comes back
 * as one call under the tool's name with the payload as its input, so
 * resolving it refuses it.
 */
export function toolCallsFor(command: {
  readonly type: string;
  readonly payload: unknown;
}): readonly AssistantToolInvocation[] {
  const name = toolNameFor(command.type);
  const entry = RULES_BY_NAME.get(name);
  const parsed = findCommand(command.type)?.parsePayload(command.payload);
  const calls =
    entry?.input && parsed?.ok ? entry.input.fromPayload(parsed.payload) : null;
  return calls ?? [{ name, input: command.payload }];
}

/**
 * Why an allowlisted command's value is refused against `project`, the state
 * it would apply to, or null when it is allowed. `proposal.ts` walks a
 * proposal's commands in order, so a value on something an earlier command
 * creates is checked against that creation.
 */
export function refuseCommandValue(
  commandType: string,
  payload: unknown,
  project: Project,
): string | null {
  return (
    RULES_BY_NAME.get(toolNameFor(commandType))?.refuseValue?.(payload, project) ?? null
  );
}

/** One capability when every call shares it, otherwise `mixed`. */
export function proposalCapability(
  capabilities: readonly AssistantCapability[],
): ProposalCapability {
  const distinct = new Set(capabilities);
  if (distinct.size === 1) return capabilities[0];
  return MIXED_CAPABILITY;
}
