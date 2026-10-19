import type { ZodType } from "zod";
import type { Project } from "../domain/entities";
import type { DomainIssue } from "../domain/parse";
import type { ControlAddress } from "./controlAddress";

/**
 * The shared command layer's vocabulary (PRD section 9.6).
 *
 * Every project mutation — pointer gesture, keyboard shortcut, or assistant
 * action — is a command. A command carries a versioned type and a validated
 * payload, an actor and correlation ID, a deterministic pure transition, a
 * generated inverse, a human-readable summary, and the base revision it was
 * built against. Nothing here imports Firebase, Tone, or Solid: the kernel is
 * a pure function of domain state so the editor, the assistant, history, and
 * persistence all integrate through the same tested boundary.
 */

/** Who asked for the change. Assistant and system edits are still commands. */
export type CommandActor = "user" | "assistant" | "system";

/**
 * A command before validation: a registered type plus an unvalidated payload.
 * `version` is optional for locally built commands — it only matters when a
 * command arrives from storage or another client and might predate this build.
 */
export interface RawCommandInput {
  readonly type: string;
  readonly payload: unknown;
  readonly version?: number;
}

/** A command with its payload type known at the call site. */
export interface CommandInput<Payload> {
  readonly type: string;
  readonly payload: Payload;
  readonly version?: number;
}

/**
 * A validated command as it was executed: what ran, who asked for it, which
 * request it belongs to, and which project revision it was built against.
 * Envelopes are what a history entry, an audit log, or a delayed remote
 * application replays.
 */
export interface CommandEnvelope {
  readonly type: string;
  readonly version: number;
  readonly payload: unknown;
  readonly actor: CommandActor;
  readonly correlationId: string;
  readonly baseRevision: number;
}

export type CommandIssueCode =
  /** No command is registered under this type. */
  | "unknown_command"
  /** The caller asked for a command version this build does not implement. */
  | "unsupported_command_version"
  /** The payload failed the command's schema. */
  | "invalid_payload"
  /** The project moved on since the command was built. */
  | "revision_conflict"
  /** The payload is well-formed but the project cannot satisfy it. */
  | "rejected"
  /** The transition would have left the project invalid. */
  | "invalid_project";

export interface CommandIssue {
  readonly code: CommandIssueCode;
  readonly commandType: string;
  /** Position of the offending command inside its transaction. */
  readonly commandIndex: number;
  readonly message: string;
  /** Domain invariant failures, when the transition produced invalid state. */
  readonly domainIssues?: readonly DomainIssue[];
}

export function formatCommandIssue(issue: CommandIssue): string {
  return `[${issue.code}] ${issue.commandType}#${issue.commandIndex}: ${issue.message}`;
}

export class CommandError extends Error {
  readonly issues: readonly CommandIssue[];

  constructor(message: string, issues: readonly CommandIssue[]) {
    super(`${message}: ${issues.map(formatCommandIssue).join("; ")}`);
    this.name = "CommandError";
    this.issues = issues;
  }
}

/**
 * The outcome of one command's transition. A command either produces the next
 * project or rejects with a reason; it never mutates its input and never
 * returns a half-applied project.
 */
export type CommandApplyResult =
  | { readonly ok: true; readonly project: Project }
  | { readonly ok: false; readonly message: string };

export function applied(project: Project): CommandApplyResult {
  return { ok: true, project };
}

export function rejected(message: string): CommandApplyResult {
  return { ok: false, message };
}

export interface CommandDefinition<Payload> {
  /** Stable, namespaced command type, e.g. `note.add`. */
  readonly type: string;
  /** Payload version. A payload shape change is a new version, not an edit. */
  readonly version: number;
  readonly schema: ZodType<Payload>;
  /** One line, suitable for a history entry or an AI proposal diff. */
  summarize(payload: Payload, project: Project): string;
  /**
   * True for a command that only brings along what another command needs (an
   * asset carried in, a pack pin moved). It never names a transaction it shares
   * with a command that is not supporting, so adding a drum machine reads
   * "Add track", not "Add <its first sample> to the project" (GRV-160).
   */
  readonly supporting?: boolean;
  /** Pure, deterministic transition. */
  apply(project: Project, payload: Payload): CommandApplyResult;
  /**
   * Commands that turn `after` back into `before`. Inverses are generated
   * from the state the command actually changed, so undo restores exact
   * previous values rather than re-deriving them.
   */
  invert(payload: Payload, before: Project, after: Project): readonly RawCommandInput[];
  /**
   * The on-screen controls this command changes (`UI-004`), read from its
   * payload. `project` is the state the command applies to, consulted only to
   * find the parent a deleted entity was listed in. Never empty: a command
   * that creates, moves or changes something names it, and one that deletes
   * names its parent, so a reveal always lands somewhere.
   */
  touches(payload: Payload, project: Project): readonly ControlAddress[];
}

/**
 * A registered command with its payload type erased, so one registry can hold
 * every command. The casts live here and nowhere else: `parsePayload` is the
 * only way a raw payload becomes the typed payload the definition sees.
 */
export interface RegisteredCommand {
  readonly type: string;
  readonly version: number;
  /**
   * The payload schema, for describing the payload to something outside the
   * kernel — the assistant's tool definitions (GRV-4) are generated from it.
   * Validate with `parsePayload`, not by parsing against this directly.
   */
  readonly schema: ZodType<unknown>;
  parsePayload(input: unknown): PayloadParseResult;
  summarize(payload: unknown, project: Project): string;
  readonly supporting: boolean;
  apply(project: Project, payload: unknown): CommandApplyResult;
  invert(payload: unknown, before: Project, after: Project): readonly RawCommandInput[];
  touches(payload: unknown, project: Project): readonly ControlAddress[];
}

export type PayloadParseResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly message: string };

/** Identity function that pins a definition's payload type at declaration. */
export function defineCommand<Payload>(
  definition: CommandDefinition<Payload>,
): CommandDefinition<Payload> {
  return definition;
}

export function eraseCommand<Payload>(
  definition: CommandDefinition<Payload>,
): RegisteredCommand {
  return {
    type: definition.type,
    version: definition.version,
    schema: definition.schema,
    parsePayload(input) {
      const result = definition.schema.safeParse(input);
      if (result.success) {
        return { ok: true, payload: result.data };
      }
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { ok: false, message: detail };
    },
    summarize(payload, project) {
      return definition.summarize(payload as Payload, project);
    },
    supporting: definition.supporting ?? false,
    apply(project, payload) {
      return definition.apply(project, payload as Payload);
    },
    invert(payload, before, after) {
      return definition.invert(payload as Payload, before, after);
    },
    touches(payload, project) {
      return definition.touches(payload as Payload, project);
    },
  };
}
