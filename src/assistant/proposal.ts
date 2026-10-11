/**
 * Validating an assistant proposal and describing its impact (GRV-4, PRD
 * AI-03 and AI-06).
 *
 * A proposal is what the model returned — a list of tool calls — plus the
 * project revision the request was built against. {@link validateProposal}
 * turns it into commands or a list of issues, and it never changes a project:
 *
 * 1. the response must have the expected shape and at most
 *    {@link MAX_PROPOSAL_COMMANDS} calls (`malformed`, `too_many_commands`);
 * 2. the revision must still be the project's (`stale_revision`);
 * 3. every call but `explain_change`, which is taken out first and changes
 *    nothing, must name an allowlisted tool with a valid, authorized payload
 *    (`unknown_tool`, `invalid_payload`, `unauthorized`, see `tools.ts`), from
 *    the tool set this code offers (`toolset_mismatch`);
 * 4. every value must be inside its parameter's range, checked command by
 *    command against the state it applies to (`out_of_range`): a manual edit's
 *    value is clamped, the assistant's is refused;
 * 5. the commands are dry-run as one transaction through the same kernel a
 *    manual edit uses, so a missing ID, a combination
 *    that breaks an invariant, or anything else the kernel refuses is reported
 *    (`rejected`, `invalid_project`) before anything is applied.
 *
 * A valid proposal carries an {@link ProposalImpact}: a line per command and
 * the tracks, clips, placements, sections, returns and devices it adds,
 * removes or changes, diffed from the dry run. The intent and the summaries
 * are for the producer to read; nothing in this module logs them.
 */
import { z } from "zod";
import { type ControlAddress, uniqueControls } from "../commands/controlAddress";
import { executeTransaction } from "../commands/execute";
import { requireCommand } from "../commands/registry";
import type { CommandIssue, RawCommandInput } from "../commands/types";
import type { Project } from "../domain/entities";
import {
  ASSISTANT_TOOLSET_VERSION,
  type AssistantCapability,
  EXPLAIN_TOOL_NAME,
  type ProposalCapability,
  type ProposalExplanationInput,
  proposalCapability,
  proposalExplanationSchema,
  refuseCommandValue,
  resolveToolCall,
} from "./tools";

/** The most commands one proposal may carry. */
export const MAX_PROPOSAL_COMMANDS = 100;

/** The longest intent a proposal may state. */
export const MAX_PROPOSAL_INTENT_LENGTH = 1_000;

/**
 * One tool call as the model returned it. Only `name` and `input` are read: a
 * provider's own fields (a call ID, a block type) are allowed and ignored.
 */
const toolCallSchema = z.object({
  name: z.string().min(1).max(200),
  input: z.unknown(),
});

const proposalInputSchema = z.strictObject({
  /** The project revision the request that produced this proposal carried. */
  baseRevision: z.int().min(0),
  /**
   * The tool set version the calls were made against. A proposal from another
   * version is refused: its tools may not mean what this code's do.
   */
  toolsetVersion: z.int().min(1).optional(),
  /** What the change is for, in the assistant's words, for the card. */
  intent: z.string().max(MAX_PROPOSAL_INTENT_LENGTH).optional(),
  calls: z.array(toolCallSchema).min(1),
});

/** A proposal as it arrives from the model, before anything is trusted. */
export type ProposalInput = z.input<typeof proposalInputSchema>;

export type ProposalIssueCode =
  /** The response is not a proposal at all. */
  | "malformed"
  | "too_many_commands"
  /** The project moved on since the request was built. */
  | "stale_revision"
  | "unknown_tool"
  | "invalid_payload"
  | "unauthorized"
  /** The calls were made against another version of the tool set. */
  | "toolset_mismatch"
  /** A value is outside its parameter's range. */
  | "out_of_range"
  /** The kernel refused a command (a missing ID, a wrong kind of track, …). */
  | "rejected"
  /** The commands together would break a domain invariant. */
  | "invalid_project";

export interface ProposalIssue {
  readonly code: ProposalIssueCode;
  /**
   * Position of the offending call among the calls that change something
   * (`explain_change` aside), when one call is to blame.
   */
  readonly callIndex: number | null;
  readonly message: string;
}

/** What one entity kind gains, loses and changes. IDs only. */
export interface EntityChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface ProposalImpactLine {
  readonly commandType: string;
  readonly capability: AssistantCapability;
  /** The command's own one-line summary, as a history entry would read. */
  readonly summary: string;
  /** The on-screen controls this command changes (`UI-004`). */
  readonly controls: readonly ControlAddress[];
}

export interface ProposalImpact {
  /** One line for the whole change, as its history entry will read. */
  readonly summary: string;
  readonly lines: readonly ProposalImpactLine[];
  /** Every control the proposal changes, without repeats. */
  readonly controls: readonly ControlAddress[];
  readonly tracks: EntityChanges;
  readonly clips: EntityChanges;
  readonly placements: EntityChanges;
  readonly sections: EntityChanges;
  readonly returns: EntityChanges;
  readonly devices: EntityChanges;
  /** True when the song's own settings (tempo, swing, key, …) change. */
  readonly songSettingsChanged: boolean;
  /** True when the master bus (volume or its chain) changes. */
  readonly masterChanged: boolean;
}

export interface ValidProposal {
  readonly baseRevision: number;
  readonly intent: string | null;
  /**
   * The goal and technique the assistant gave through `explain_change`, or
   * null when it gave none (or one that does not parse, which never costs the
   * proposal itself).
   */
  readonly explanation: ProposalExplanationInput | null;
  /** The commands, each pinned to the version the tool was generated from. */
  readonly commands: readonly RawCommandInput[];
  readonly capabilities: readonly AssistantCapability[];
  /** The proposal's one capability, or `mixed`. */
  readonly capability: ProposalCapability;
  readonly impact: ProposalImpact;
}

export type ProposalValidation =
  | { readonly ok: true; readonly proposal: ValidProposal }
  | { readonly ok: false; readonly issues: readonly ProposalIssue[] };

function invalid(issues: readonly ProposalIssue[]): ProposalValidation {
  return { ok: false, issues };
}

function describeShape(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function fromCommandIssue(issue: CommandIssue): ProposalIssue {
  const code: ProposalIssueCode =
    issue.code === "invalid_project"
      ? "invalid_project"
      : issue.code === "revision_conflict"
        ? "stale_revision"
        : issue.code === "invalid_payload"
          ? "invalid_payload"
          : "rejected";
  return { code, callIndex: issue.commandIndex, message: issue.message };
}

/**
 * Validates a model's proposal against `project`, the committed project it
 * would apply to. Returns the commands and their impact, or every reason it
 * cannot apply. Never throws and never changes `project`.
 */
export function validateProposal(project: Project, input: unknown): ProposalValidation {
  const shape = proposalInputSchema.safeParse(input);
  if (!shape.success) {
    return invalid([
      { code: "malformed", callIndex: null, message: describeShape(shape.error) },
    ]);
  }
  const { baseRevision, toolsetVersion, intent } = shape.data;
  const calls = shape.data.calls.filter((call) => call.name !== EXPLAIN_TOOL_NAME);
  if (calls.length === 0) {
    return invalid([
      { code: "malformed", callIndex: null, message: "The proposal changes nothing" },
    ]);
  }
  if (toolsetVersion !== undefined && toolsetVersion !== ASSISTANT_TOOLSET_VERSION) {
    return invalid([
      {
        code: "toolset_mismatch",
        callIndex: null,
        message: `The proposal uses tool set version ${toolsetVersion}, but this is version ${ASSISTANT_TOOLSET_VERSION}`,
      },
    ]);
  }
  if (calls.length > MAX_PROPOSAL_COMMANDS) {
    return invalid([
      {
        code: "too_many_commands",
        callIndex: null,
        message: `A proposal carries at most ${MAX_PROPOSAL_COMMANDS} commands; this one has ${calls.length}`,
      },
    ]);
  }
  if (baseRevision !== project.metadata.revision) {
    return invalid([
      {
        code: "stale_revision",
        callIndex: null,
        message: `The proposal was built against revision ${baseRevision}, but the project is at revision ${project.metadata.revision}`,
      },
    ]);
  }

  const commands: RawCommandInput[] = [];
  const capabilities: AssistantCapability[] = [];
  const issues: ProposalIssue[] = [];
  calls.forEach((call, callIndex) => {
    const resolution = resolveToolCall(call.name, call.input);
    if (!resolution.ok) {
      issues.push({ code: resolution.code, callIndex, message: resolution.message });
      return;
    }
    commands.push({
      type: resolution.commandType,
      version: resolution.commandVersion,
      payload: resolution.payload,
    });
    capabilities.push(resolution.capability);
  });
  if (issues.length > 0) return invalid(issues);
  const rangeIssues = valueIssues(project, commands);
  if (rangeIssues.length > 0) return invalid(rangeIssues);

  // The dry run: the same transaction the apply will run, against the same
  // project, without committing a revision.
  const dryRun = executeTransaction(project, commands, {
    actor: "assistant",
    baseRevision,
    commitRevision: false,
  });
  if (!dryRun.ok) return invalid(dryRun.issues.map(fromCommandIssue));

  const lines = describeLines(project, commands, capabilities);
  return {
    ok: true,
    proposal: {
      baseRevision,
      intent: intent ?? null,
      explanation: explanationOf(shape.data.calls),
      commands,
      capabilities,
      capability: proposalCapability(capabilities),
      impact: {
        summary: dryRun.summary,
        lines,
        controls: uniqueControls(lines.flatMap((line) => line.controls)),
        ...diffProjects(project, dryRun.project),
      },
    },
  };
}

/** The first `explain_change` call that parses, or null. */
function explanationOf(
  calls: readonly { readonly name: string; readonly input: unknown }[],
): ProposalExplanationInput | null {
  for (const call of calls) {
    if (call.name !== EXPLAIN_TOOL_NAME) continue;
    const parsed = proposalExplanationSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Every value outside its parameter's range, each command checked against the
 * state the commands before it leave. A command the kernel cannot apply ends
 * the walk; the dry run that follows reports it.
 */
function valueIssues(
  project: Project,
  commands: readonly RawCommandInput[],
): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  let working = project;
  for (const [callIndex, command] of commands.entries()) {
    const reason = refuseCommandValue(command.type, command.payload, working);
    if (reason) issues.push({ code: "out_of_range", callIndex, message: reason });
    const step = requireCommand(command.type).apply(working, command.payload);
    if (!step.ok) break;
    working = step.project;
  }
  return issues;
}

/**
 * A summary and the touched controls for each command, each read against the
 * state that command applies to. Only called after the whole transaction has
 * dry-run successfully, so every step here applies.
 */
function describeLines(
  project: Project,
  commands: readonly RawCommandInput[],
  capabilities: readonly AssistantCapability[],
): ProposalImpactLine[] {
  let working = project;
  return commands.map((command, index) => {
    const definition = requireCommand(command.type);
    const line: ProposalImpactLine = {
      commandType: command.type,
      capability: capabilities[index],
      summary: definition.summarize(command.payload, working),
      controls: uniqueControls(definition.touches(command.payload, working)),
    };
    const step = definition.apply(working, command.payload);
    if (step.ok) working = step.project;
    return line;
  });
}

interface Identified {
  readonly id: string;
}

function diffEntities(
  before: readonly Identified[],
  after: readonly Identified[],
): EntityChanges {
  const beforeById = new Map(before.map((entity) => [entity.id, entity]));
  const afterIds = new Set(after.map((entity) => entity.id));
  const added: string[] = [];
  const changed: string[] = [];
  for (const entity of after) {
    const previous = beforeById.get(entity.id);
    if (!previous) added.push(entity.id);
    else if (previous !== entity && JSON.stringify(previous) !== JSON.stringify(entity)) {
      changed.push(entity.id);
    }
  }
  const removed = before
    .filter((entity) => !afterIds.has(entity.id))
    .map((entity) => entity.id);
  return { added, removed, changed };
}

function allDevices(project: Project): Identified[] {
  const { song } = project;
  return [
    ...song.tracks.flatMap((track) => track.devices),
    ...song.returns.flatMap((bus) => bus.devices),
    ...song.master.devices,
  ];
}

function songSettings(project: Project): string {
  const {
    tracks: _tracks,
    returns: _returns,
    placements: _placements,
    sections: _sections,
    automation: _automation,
    assets: _assets,
    master: _master,
    ...settings
  } = project.song;
  return JSON.stringify(settings);
}

/** What the proposal adds, removes and changes, entity by entity. */
function diffProjects(
  before: Project,
  after: Project,
): Omit<ProposalImpact, "summary" | "lines" | "controls"> {
  return {
    tracks: diffEntities(before.song.tracks, after.song.tracks),
    clips: diffEntities(before.clips, after.clips),
    placements: diffEntities(before.song.placements, after.song.placements),
    sections: diffEntities(before.song.sections, after.song.sections),
    returns: diffEntities(before.song.returns, after.song.returns),
    devices: diffEntities(allDevices(before), allDevices(after)),
    songSettingsChanged: songSettings(before) !== songSettings(after),
    masterChanged:
      JSON.stringify(before.song.master) !== JSON.stringify(after.song.master),
  };
}
