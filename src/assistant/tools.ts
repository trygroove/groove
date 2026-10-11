/**
 * The assistant's tool schema (GRV-4, PRD AI-03 and AI-05).
 *
 * The assistant changes a project only through shared commands, and only
 * through the allowlisted subset below. Each tool is one registered command:
 * its name is the command type with `_` for `.`, its input schema is generated
 * from the command's own Zod payload schema, and a call is turned back into
 * that command with the registered version pinned. Nothing here applies a
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
import { z } from "zod";
import type { DrumSetPadParameterPayload } from "../commands/definitions/drum";
import {
  type ParameterSetPayload,
  parameterDefinitionAt,
} from "../commands/definitions/parameters";
import { findCommand } from "../commands/registry";
import type { Project } from "../domain/entities";
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
 */
export const ASSISTANT_TOOLSET_VERSION = 6;

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

/** The allowlist, in the order the tools are offered to the model. */
const TOOL_RULES: readonly ToolRule[] = [
  PARAMETER_SET_RULE,
  rule(
    "track.create",
    "tracks",
    "Add a track, with its instrument, clips and placements. Duplicate a track by creating a copy with new IDs.",
    automationRestore,
  ),
  rule("track.update", "tracks", "Rename or recolour a track."),
  rule("track.reorder", "tracks", "Move a track to a new position in the track list."),
  rule("track.delete", "tracks", "Remove a track and its clips and placements."),
  rule(
    "clip.create",
    "clips",
    "Add a clip to a track, optionally with placements. Duplicate a clip as an independent variation by creating a copy with new IDs.",
  ),
  rule("clip.update", "clips", "Rename, recolour or resize a clip."),
  rule("clip.delete", "clips", "Remove a clip and every placement of it."),
  rule("note.add", "notes", "Add note events to a clip."),
  rule("note.update", "notes", "Move, resize, re-pitch or re-velocity note events."),
  rule("note.remove", "notes", "Remove note events from a clip."),
  rule("notes.transpose", "notes", "Transpose a clip's notes, or some of them."),
  rule("notes.scaleVelocity", "notes", "Scale the velocity of a clip's notes."),
  rule("notes.quantize", "notes", "Quantize a clip's notes to a grid."),
  rule("notes.quantizeToScale", "notes", "Move a clip's notes onto a scale."),
  rule("notes.duplicate", "notes", "Repeat a clip's notes later in the clip."),
  rule("notes.clear", "notes", "Remove every note from a clip."),
  rule("notes.vary", "notes", "Vary a clip's notes deterministically from a seed."),
  rule("placement.create", "placements", "Place a clip on its track's timeline."),
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
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(command.schema, {
    io: "input",
  }) as JsonSchema;
  return {
    name: toolNameFor(entry.commandType),
    description: entry.description,
    inputSchema,
    commandType: entry.commandType,
    commandVersion: command.version,
    capabilities: entry.capabilities,
  };
}

let toolCache: readonly AssistantToolDefinition[] | null = null;

/** Every tool the assistant may call, generated once from the registry. */
export function assistantTools(): readonly AssistantToolDefinition[] {
  toolCache ??= TOOL_RULES.map(toolDefinition);
  return toolCache;
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
  const parsed = command.parsePayload(input);
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
