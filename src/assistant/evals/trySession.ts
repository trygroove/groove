/**
 * A try-it session (GRV-108): the live assistant driven on an eval fixture,
 * one command at a time, by `bun run assistant:try` (`tryCli.ts` parses the
 * commands, `scripts/assistant-try.ts` keeps the session file).
 *
 * A session is plain data, written whole to
 * `tmp/assistant-sessions/<id>.json` after every command: the project, the
 * conversation as the panel logs it, the scope and selection, the proposal
 * and question waiting, the proposals applied (newest last, what `undo`
 * takes back) and the last turn, which `save-case` freezes into an eval case.
 *
 * Every transition is the app's:
 *
 * - `ask` is one turn through the gateway's own turn ({@link runCaseTurn},
 *   what `eval:assistant` runs), with the production prompt, tools and model,
 *   resending the history as the panel builds it ({@link historyOf}). A reply
 *   that only proposed is dropped from what is resent, as the panel drops it.
 * - A proposal is validated by the executor (GRV-4) as the card's controller
 *   validates it, and listed as the card lists it ({@link proposalRows}).
 * - `apply`, `cancel` and `undo` go through the executor on a
 *   {@link CommandHistory}. A history cannot be written to a file, so `undo`
 *   rebuilds it at the project the proposal was applied to, applies the
 *   proposal again (its payload names every ID it creates, so the result is
 *   the same) and undoes it there.
 *
 * Nothing here touches Firestore, user data or the deployed quota, and
 * nothing logs analytics: this is a developer tool.
 */
import { createCommandHistory } from "../../commands/history";
import type { Project } from "../../domain/entities";
import { parseProject } from "../../domain/parse";
import { serializeProject } from "../../domain/serialize";
import {
  type ProposalRow,
  projectAfter,
  proposalRows,
} from "../../editor/assistant/proposalCardModel";
import {
  type AskAnswer,
  type AssistantAsk,
  answerIsEmpty,
  answerMessage,
  pickedLabels,
} from "../ask";
import { ASSISTANT_MODELS, type AssistantModelId } from "../config";
import { historyOf, MAX_MESSAGE_CHARS } from "../history";
import { historyProposalTarget } from "../historyProposalTarget";
import type { ProposalIssue } from "../proposal";
import { createProposalExecutor, type ProposalHandle } from "../proposalExecutor";
import type { AssistantMessage, AssistantProposal } from "../protocol";
import type { AssistantProvider } from "../provider";
import { splitRecommendations } from "../recommendation";
import type { ProviderUsage } from "../streamEvents";
import type { EvalExpectation } from "./caseChecks";
import {
  EVAL_CAPABILITIES,
  type EvalCapability,
  type EvalCase,
  type EvalScope,
  type EvalSelection,
  type JsonEvalCase,
  parseJsonEvalCase,
  resolveScope,
  resolveSelection,
} from "./cases";
import { CHECK_IDS, CHECK_LABELS, type CheckResult, canonicalSongState } from "./checks";
import { EvalUsageError } from "./cli";
import { describeProject, type ProjectOverview } from "./describe";
import { FIXTURE_NAME, namedFixture, TS_FIXTURES } from "./namedFixtures";
import { type EvalTurn, evaluateTurn, runCaseTurn, whyNoProposal } from "./run";
import { turnCostUsd } from "./scorecard";

export const TRY_SESSION_KIND = "groove-assistant-try-session";

/** One thing in the session's conversation, as {@link historyOf} reads it. */
export type TryEntry =
  | { readonly kind: "message"; readonly text: string; readonly wire?: string }
  | { readonly kind: "reply"; readonly text: string; readonly ask?: AssistantAsk };

/** A proposal that was applied, and the project it was applied to. */
export interface AppliedProposal {
  readonly before: Project;
  readonly proposal: AssistantProposal;
}

/** The last turn, as `save-case` freezes it. */
export interface TryTurn {
  /** The producer's words as the log shows them. */
  readonly text: string;
  /** What the turn sent as its last message: the case's request. */
  readonly request: string;
  /** The conversation resent ahead of it. */
  readonly history: readonly AssistantMessage[];
  /** The project as it was just before it. */
  readonly project: Project;
  readonly selection: EvalSelection;
  readonly scope: EvalScope;
  readonly turn: EvalTurn;
}

export interface TrySession {
  readonly kind: typeof TRY_SESSION_KIND;
  readonly version: 1;
  readonly id: string;
  /** The fixture the session started on. */
  readonly fixture: string;
  readonly model: AssistantModelId;
  readonly project: Project;
  readonly entries: readonly TryEntry[];
  /** What check 3 lets a proposal change. */
  readonly scope: EvalScope;
  /** What the producer has selected, which the turn's context carries. */
  readonly selection: EvalSelection;
  /** The proposal waiting for apply or cancel. */
  readonly pending: AssistantProposal | null;
  /** The question waiting for an answer. */
  readonly pendingAsk: AssistantAsk | null;
  /** The proposals applied, newest last: what `undo` takes back. */
  readonly applied: readonly AppliedProposal[];
  readonly last: TryTurn | null;
}

/** The scope of a fresh session: anything may change. */
export const WHOLE_SONG_SCOPE: EvalScope = {
  tracks: "all",
  createTracks: true,
  song: true,
  master: true,
  returns: true,
  sections: false,
};

/** Analytics the executor is handed: a developer tool logs nothing. */
const NO_ANALYTICS = { log() {} };

// ---------------------------------------------------------------------------
// The session file
// ---------------------------------------------------------------------------

function projectJson(project: Project) {
  return serializeProject(project);
}

function readProject(raw: unknown, where: string): Project {
  const parsed = parseProject(raw);
  if (!parsed.ok)
    throw new EvalUsageError(`The session's ${where} is not a valid project`);
  return parsed.value;
}

/** The session as its file holds it. */
export function sessionToJson(session: TrySession): string {
  return `${JSON.stringify(
    {
      ...session,
      project: projectJson(session.project),
      applied: session.applied.map((entry) => ({
        ...entry,
        before: projectJson(entry.before),
      })),
      last: session.last
        ? { ...session.last, project: projectJson(session.last.project) }
        : null,
    },
    null,
    2,
  )}\n`;
}

/** Reads a session file back, or says it is not one. */
export function sessionFromJson(text: string): TrySession {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new EvalUsageError("The session file is not JSON");
  }
  if (raw?.kind !== TRY_SESSION_KIND || raw.version !== 1) {
    throw new EvalUsageError("The file is not an assistant:try session");
  }
  const session = raw as unknown as TrySession;
  return {
    ...session,
    project: readProject(raw.project, "project"),
    applied: (session.applied ?? []).map((entry, index) => ({
      ...entry,
      before: readProject(entry.before, `applied proposal ${index + 1}`),
    })),
    last: session.last
      ? { ...session.last, project: readProject(session.last.project, "last turn") }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Results: what each command prints, as data (`--json` prints it as is)
// ---------------------------------------------------------------------------

export interface CheckLine {
  readonly id: string;
  readonly label: string;
  readonly status: CheckResult["status"];
  readonly detail: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly fixture: string;
  readonly model: string;
  readonly scope: EvalScope;
  readonly selection: EvalSelection;
}

export type TryResult =
  | {
      readonly kind: "new";
      readonly session: SessionSummary;
      readonly project: ProjectOverview;
    }
  | {
      readonly kind: "ask";
      readonly session: SessionSummary;
      /** Why the turn errored; null when it came back with a reply. */
      readonly error: string | null;
      readonly reply: string;
      readonly stopReason: string | null;
      /** The proposal's card: its summary and a row per control it changes. */
      readonly proposal: {
        readonly summary: string;
        readonly intent: string | null;
        readonly rows: readonly ProposalRow[];
      } | null;
      /** Why the proposal was refused, as the card would say, when it was. */
      readonly rejected: readonly ProposalIssue[] | null;
      /** Sounds the reply recommends, which the CLI does not show. */
      readonly recommendations: number;
      readonly question: AssistantAsk | null;
      /** Checks 1 to 5 on the proposal; null when there was none. */
      readonly checks: readonly CheckLine[] | null;
      /** Why there was no proposal, when the turn replied with none. */
      readonly noProposal: string | null;
      readonly usage: ProviderUsage | null;
      readonly costUsd: number | null;
      readonly durationMs: number;
    }
  | {
      readonly kind: "apply" | "cancel" | "undo";
      readonly session: SessionSummary;
      readonly ok: boolean;
      /** What was done, or why it was refused. */
      readonly message: string;
      readonly issues: readonly string[];
      readonly revision: number;
    }
  | { readonly kind: "scope" | "select"; readonly session: SessionSummary }
  | {
      readonly kind: "show";
      readonly session: SessionSummary;
      readonly project: ProjectOverview;
      readonly pending: {
        readonly summary: string;
        readonly rows: readonly ProposalRow[];
      } | null;
      readonly question: AssistantAsk | null;
      readonly undoable: number;
      readonly turns: number;
    }
  | {
      readonly kind: "save-case";
      readonly session: SessionSummary;
      readonly caseId: string;
      readonly fixture: string;
      /** The files to write: the case, and its fixture when it is a new one. */
      readonly files: readonly { readonly path: string; readonly content: string }[];
    };

export interface Transition {
  readonly session: TrySession;
  readonly result: TryResult;
}

export function summaryOf(session: TrySession): SessionSummary {
  return {
    id: session.id,
    fixture: session.fixture,
    model: session.model,
    scope: session.scope,
    selection: session.selection,
  };
}

// ---------------------------------------------------------------------------
// new
// ---------------------------------------------------------------------------

export interface NewSessionInput {
  readonly id: string;
  readonly fixture: string;
  readonly model: AssistantModelId;
  readonly fixturesDir?: string;
}

/** A session on the named fixture, whole song in scope, nothing selected. */
export function newSession(input: NewSessionInput): Transition {
  let fixture: () => Project;
  try {
    fixture = namedFixture(input.fixture, input.fixturesDir);
  } catch (error) {
    throw new EvalUsageError(error instanceof Error ? error.message : String(error));
  }
  const session: TrySession = {
    kind: TRY_SESSION_KIND,
    version: 1,
    id: input.id,
    fixture: input.fixture,
    model: input.model,
    project: fixture(),
    entries: [],
    scope: WHOLE_SONG_SCOPE,
    selection: null,
    pending: null,
    pendingAsk: null,
    applied: [],
    last: null,
  };
  return {
    session,
    result: {
      kind: "new",
      session: summaryOf(session),
      project: describeProject(session.project),
    },
  };
}

// ---------------------------------------------------------------------------
// ask and answer
// ---------------------------------------------------------------------------

export interface TurnDeps {
  readonly provider: AssistantProvider;
  readonly now?: () => number;
  readonly turnTimeoutMs?: number;
}

function executorOn(project: Project) {
  const history = createCommandHistory(project);
  const executor = createProposalExecutor({
    target: historyProposalTarget(history),
    analytics: NO_ANALYTICS,
  });
  return { history, executor };
}

/** The card for a proposal in `project`, or why it was refused. */
function cardOf(
  project: Project,
  proposal: AssistantProposal,
):
  | { ok: true; summary: string; intent: string | null; rows: ProposalRow[] }
  | { ok: false; issues: readonly ProposalIssue[] } {
  const proposed = executorOn(project).executor.propose(proposal);
  if (!proposed.ok) return { ok: false, issues: proposed.issues };
  const valid = proposed.handle.proposal;
  return {
    ok: true,
    summary: valid.impact.summary,
    intent: valid.intent,
    rows: proposalRows(project, projectAfter(project, valid), valid.impact.controls),
  };
}

/** Checks the session's names still resolve, before a turn is spent on them. */
function assertNamesResolve(session: TrySession): void {
  try {
    resolveSelection(session.project, session.selection);
    resolveScope(session.project, session.scope);
  } catch (error) {
    throw new EvalUsageError(
      `${error instanceof Error ? error.message : String(error)}. Set the scope or selection again; no model was called.`,
    );
  }
}

/** The ad-hoc case a turn runs and is judged as. */
function turnCase(
  session: TrySession,
  request: string,
  history: readonly AssistantMessage[],
): EvalCase {
  const project = session.project;
  return {
    id: `try-${session.id}`,
    capability: "loopSketch",
    axis: "conventional",
    request,
    history,
    expect: "proposal",
    fixture: () => project,
    selection: session.selection,
    scope: session.scope,
  };
}

const FIRST_FIVE_CHECKS = CHECK_IDS.slice(0, 5);

/** One live turn: the producer's `message`, sent as the panel would send it. */
export async function ask(
  session: TrySession,
  message: { readonly text: string; readonly wire?: string },
  deps: TurnDeps,
): Promise<Transition> {
  const text = message.text.trim();
  if (text.length === 0) throw new EvalUsageError('Say something: ask "<message>"');
  assertNamesResolve(session);
  // The panel cuts a message to what the gateway takes.
  const request = (message.wire ?? text).slice(0, MAX_MESSAGE_CHARS);
  const history = historyOf(session.entries);
  const evalCase = turnCase(session, request, history);
  const model = ASSISTANT_MODELS[session.model];
  const turn = await runCaseTurn(evalCase, {
    provider: deps.provider,
    model,
    now: deps.now,
    turnTimeoutMs: deps.turnTimeoutMs,
  });
  const entries: TryEntry[] = [
    ...session.entries,
    { kind: "message", text, ...(message.wire ? { wire: message.wire } : {}) },
  ];
  // The panel drops a reply that wrote nothing and asked nothing, and with it
  // the message from what the next turn resends; a failed turn likewise.
  if (!turn.error && (turn.text.length > 0 || turn.ask)) {
    entries.push({
      kind: "reply",
      text: turn.text,
      ...(turn.ask ? { ask: turn.ask } : {}),
    });
  }
  const split = turn.proposal ? splitRecommendations(turn.proposal) : null;
  const card = split?.proposal ? cardOf(session.project, split.proposal) : null;
  const judged = turn.proposal && !turn.error ? evaluateTurn(evalCase, 1, turn) : null;
  const checks = judged
    ? FIRST_FIVE_CHECKS.map((id) => {
        const result = judged.checks[id];
        return {
          id,
          label: CHECK_LABELS[id],
          status: result?.status ?? "skip",
          detail: result?.detail ?? "Not judged",
        };
      })
    : null;
  const next: TrySession = {
    ...session,
    entries,
    // A newer proposal or question takes the place of one still waiting.
    pending: card?.ok && split?.proposal ? split.proposal : session.pending,
    pendingAsk: turn.ask ?? session.pendingAsk,
    last: {
      text,
      request,
      history,
      project: session.project,
      selection: session.selection,
      scope: session.scope,
      turn,
    },
  };
  return {
    session: next,
    result: {
      kind: "ask",
      session: summaryOf(next),
      error: turn.error,
      reply: turn.text,
      stopReason: turn.stopReason,
      proposal: card?.ok
        ? { summary: card.summary, intent: card.intent, rows: card.rows }
        : null,
      rejected: card && !card.ok ? card.issues : null,
      recommendations: split?.recommendations.length ?? 0,
      question: turn.ask ?? null,
      checks,
      noProposal: turn.error || turn.proposal ? null : whyNoProposal(turn),
      usage: turn.usage ?? null,
      costUsd: turn.usage ? turnCostUsd(model, turn.usage) : null,
      durationMs: turn.durationMs,
    },
  };
}

/**
 * What the producer said in answer to `question`: option numbers (1-based,
 * comma-separated), an option's label, or their own words.
 */
export function parseAnswer(question: AssistantAsk, said: string): AskAnswer {
  const text = said.trim();
  if (/^\d+(\s*,\s*\d+)*$/.test(text)) {
    const picked = text.split(",").map((part) => Number(part.trim()) - 1);
    const outside = picked.find((index) => index < 0 || index >= question.options.length);
    if (outside !== undefined) {
      throw new EvalUsageError(
        `The question has options 1 to ${question.options.length}; there is no ${outside + 1}`,
      );
    }
    if (picked.length > 1 && !question.multiSelect) {
      throw new EvalUsageError("The question takes one option");
    }
    return { picked, text: "" };
  }
  const label = question.options.findIndex(
    (option) => option.label.toLowerCase() === text.toLowerCase(),
  );
  return label >= 0 ? { picked: [label], text: "" } : { picked: [], text };
}

/** Answers the waiting question as the panel does: the answer is the next turn. */
export async function answer(
  session: TrySession,
  said: string,
  deps: TurnDeps,
): Promise<Transition> {
  const question = session.pendingAsk;
  if (!question) throw new EvalUsageError("No question is waiting for an answer");
  const reply = parseAnswer(question, said);
  if (answerIsEmpty(reply))
    throw new EvalUsageError("Say which option, or answer in words");
  const labels = pickedLabels(question, reply);
  const typed = reply.text.trim();
  return ask(
    { ...session, pendingAsk: null },
    {
      text: [labels.join(", "), typed].filter((part) => part.length > 0).join(" · "),
      wire: answerMessage(question, reply),
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// apply, cancel and undo
// ---------------------------------------------------------------------------

function issueLines(
  issues: readonly { readonly code: string; readonly message: string }[],
) {
  return issues.map((issue) => `${issue.code}: ${issue.message}`);
}

function outcome(
  kind: "apply" | "cancel" | "undo",
  session: TrySession,
  ok: boolean,
  message: string,
  issues: readonly string[] = [],
): Transition {
  return {
    session,
    result: {
      kind,
      session: summaryOf(session),
      ok,
      message,
      issues,
      revision: session.project.metadata.revision,
    },
  };
}

/** Proposes `proposal` on a fresh history at `project`. */
function handleFor(
  project: Project,
  proposal: AssistantProposal,
):
  | { ok: true; handle: ProposalHandle; history: ReturnType<typeof createCommandHistory> }
  | { ok: false; issues: readonly ProposalIssue[] } {
  const { history, executor } = executorOn(project);
  const proposed = executor.propose(proposal);
  return proposed.ok ? { ok: true, handle: proposed.handle, history } : proposed;
}

const STALE =
  "The song moved since the proposal was made, so it can only be cancelled (ask again to refresh it)";

export function apply(session: TrySession): Transition {
  const pending = session.pending;
  if (!pending) throw new EvalUsageError("No proposal is waiting to be applied");
  const proposed = handleFor(session.project, pending);
  if (!proposed.ok) {
    const stale = proposed.issues.some((issue) => issue.code === "stale_revision");
    return outcome(
      "apply",
      session,
      false,
      stale ? STALE : "The executor refused it",
      issueLines(proposed.issues),
    );
  }
  const applied = proposed.handle.apply();
  if (!applied.ok) {
    return outcome(
      "apply",
      session,
      false,
      applied.reason === "stale" ? STALE : `The executor refused it: ${applied.reason}`,
      issueLines(applied.issues),
    );
  }
  const next: TrySession = {
    ...session,
    project: proposed.history.project,
    pending: null,
    applied: [...session.applied, { before: session.project, proposal: pending }],
  };
  return outcome(
    "apply",
    next,
    true,
    `Applied: ${proposed.handle.proposal.impact.summary}`,
  );
}

export function cancel(session: TrySession): Transition {
  const pending = session.pending;
  if (!pending) throw new EvalUsageError("No proposal is waiting to be cancelled");
  const proposed = handleFor(session.project, pending);
  // A stale proposal can always be cancelled; nothing changes either way.
  if (proposed.ok) proposed.handle.cancel();
  return outcome(
    "cancel",
    { ...session, pending: null },
    true,
    "Cancelled; the song is unchanged",
  );
}

export function undo(session: TrySession): Transition {
  const newest = session.applied.at(-1);
  if (!newest) throw new EvalUsageError("No applied proposal to undo");
  const proposed = handleFor(newest.before, newest.proposal);
  if (!proposed.ok) {
    return outcome(
      "undo",
      session,
      false,
      "The proposal no longer applies",
      issueLines(proposed.issues),
    );
  }
  const reapplied = proposed.handle.apply();
  const undone = reapplied.ok ? proposed.handle.undo() : reapplied;
  if (!undone.ok) {
    return outcome(
      "undo",
      session,
      false,
      `The executor refused it: ${undone.reason}`,
      issueLines(undone.issues),
    );
  }
  const next: TrySession = {
    ...session,
    project: proposed.history.project,
    applied: session.applied.slice(0, -1),
  };
  return outcome("undo", next, true, `Undid: ${proposed.handle.proposal.impact.summary}`);
}

// ---------------------------------------------------------------------------
// scope, select and show
// ---------------------------------------------------------------------------

export interface ScopeFlags {
  readonly createTracks?: boolean;
  readonly song?: boolean;
  readonly master?: boolean;
  readonly returns?: boolean;
}

function trackNamesExist(project: Project, names: readonly string[]): void {
  const missing = names.filter(
    (name) => !project.song.tracks.some((track) => track.name === name),
  );
  if (missing.length > 0) {
    throw new EvalUsageError(
      `No track named ${missing.map((name) => `"${name}"`).join(", ")}. Tracks: ${project.song.tracks.map((track) => track.name).join(", ")}`,
    );
  }
}

/**
 * What a proposal may change (check 3): `whole` (anything), or the named
 * tracks, plus new tracks, the song's settings, the master and the returns
 * when their flags say so.
 */
export function setScope(
  session: TrySession,
  args: readonly string[],
  flags: ScopeFlags = {},
): Transition {
  let scope: EvalScope;
  if (args.length === 1 && args[0] === "whole") scope = WHOLE_SONG_SCOPE;
  else if (args.length === 0) {
    throw new EvalUsageError("scope takes whole, or one or more track names");
  } else {
    trackNamesExist(session.project, args);
    scope = {
      tracks: [...args],
      createTracks: flags.createTracks ?? false,
      song: flags.song ?? false,
      master: flags.master ?? false,
      returns: flags.returns ?? false,
      sections: false,
    };
  }
  const next = { ...session, scope };
  return { session: next, result: { kind: "scope", session: summaryOf(next) } };
}

/** What the producer has selected: `none`, `tracks <names>` or `clips <names>`. */
export function setSelection(session: TrySession, args: readonly string[]): Transition {
  const [what, ...names] = args;
  let selection: EvalSelection;
  if (what === "none" && names.length === 0) selection = null;
  else if ((what === "tracks" || what === "clips") && names.length > 0) {
    selection = what === "tracks" ? { tracks: names } : { clips: names };
    try {
      resolveSelection(session.project, selection);
    } catch (error) {
      throw new EvalUsageError(error instanceof Error ? error.message : String(error));
    }
  } else {
    throw new EvalUsageError("select takes none, tracks <names> or clips <names>");
  }
  const next = { ...session, selection };
  return { session: next, result: { kind: "select", session: summaryOf(next) } };
}

export function show(session: TrySession): Transition {
  const card = session.pending ? cardOf(session.project, session.pending) : null;
  return {
    session,
    result: {
      kind: "show",
      session: summaryOf(session),
      project: describeProject(session.project),
      pending: card?.ok ? { summary: card.summary, rows: card.rows } : null,
      question: session.pendingAsk,
      undoable: session.applied.length,
      turns: session.entries.filter((entry) => entry.kind === "message").length,
    },
  };
}

// ---------------------------------------------------------------------------
// save-case
// ---------------------------------------------------------------------------

export interface SaveCaseInput {
  readonly caseId: string;
  readonly capability: string;
  readonly expect?: EvalExpectation;
  readonly axis?: EvalCase["axis"];
  /** Every case ID there is already, which the new one must not take. */
  readonly existingCaseIds: readonly string[];
  readonly casesDir: string;
  readonly fixturesDir: string;
  readonly exists: (path: string) => boolean;
}

/** Path joining that works the same on any platform's separator. */
function inDir(dir: string, file: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${file}`;
}

/**
 * The last turn as an eval case: its request, with the project and history
 * as they were just before it. The project is the session's fixture by name
 * when it is unchanged from it, or a new JSON fixture named for the case.
 */
export function saveCase(session: TrySession, input: SaveCaseInput): Transition {
  const last = session.last;
  if (!last) throw new EvalUsageError("Nothing to save yet: ask something first");
  if (!FIXTURE_NAME.test(input.caseId)) {
    throw new EvalUsageError("A case ID is lower-case words joined by hyphens");
  }
  if (input.existingCaseIds.includes(input.caseId)) {
    throw new EvalUsageError(`There is already a case "${input.caseId}"`);
  }
  if (!(EVAL_CAPABILITIES as readonly string[]).includes(input.capability)) {
    throw new EvalUsageError(
      `Unknown capability "${input.capability}". Capabilities: ${EVAL_CAPABILITIES.join(", ")}`,
    );
  }
  // The song, not the revision: apply then undo leaves the fixture as it was.
  const unchanged =
    canonicalSongState(last.project) ===
    canonicalSongState(namedFixture(session.fixture, input.fixturesDir)());
  const fixture = unchanged ? session.fixture : input.caseId;
  const files: { path: string; content: string }[] = [];
  if (!unchanged) {
    const path = inDir(input.fixturesDir, `${fixture}.json`);
    if (Object.hasOwn(TS_FIXTURES, fixture) || input.exists(path)) {
      throw new EvalUsageError(`There is already a fixture "${fixture}"`);
    }
    files.push({
      path,
      content: `${JSON.stringify(serializeProject(last.project), null, 2)}\n`,
    });
  }
  const json: JsonEvalCase = parseJsonEvalCase(
    {
      id: input.caseId,
      capability: input.capability as EvalCapability,
      axis: input.axis ?? "conventional",
      request: last.request,
      ...(last.history.length > 0 ? { history: last.history } : {}),
      expect: input.expect ?? "proposal",
      fixture,
      selection: last.selection,
      scope: last.scope,
    },
    `The case "${input.caseId}"`,
  );
  const path = inDir(input.casesDir, `${input.caseId}.json`);
  if (input.exists(path)) throw new EvalUsageError(`${path} already exists`);
  files.unshift({ path, content: `${JSON.stringify(json, null, 2)}\n` });
  return {
    session,
    result: {
      kind: "save-case",
      session: summaryOf(session),
      caseId: input.caseId,
      fixture,
      files,
    },
  };
}
