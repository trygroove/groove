/**
 * Multi-turn eval sessions (GRV-145): a case that runs as a conversation,
 * driven by a **scripted producer**, rather than as one turn.
 *
 * Some requests are a process, not one answer: "make me a full track" may be
 * built over several proposals, each ending with a question about the next
 * step. Judging only the first turn would score that as incomplete, so a case
 * that names `session` runs like this:
 *
 * 1. The case's request goes out as its turn would (`run.ts`).
 * 2. The scripted producer applies the turn's proposal, as the panel's Apply
 *    does, so the next turn sees the song it left.
 * 3. If the turn asked a question (`ask_producer`), the producer answers it
 *    with the option the assistant suggested (the first option when it
 *    suggested none), as the panel sends an answer, and the next turn runs.
 * 4. The session ends when a turn asks nothing, when it errors, when its
 *    proposal does not apply, or when it reaches the case's cap of turns
 *    ({@link DEFAULT_SESSION_TURNS} unless the case says otherwise).
 *
 * The session comes back as one {@link EvalTurn}: the case's checks judge the
 * final song, reached by applying every turn's proposal in order to the song
 * the turn before left ({@link sessionJudgement}), so no one proposal has to
 * hold the whole session's calls and a saved report replays from its turns;
 * its time, tokens and steps are the session's sums; and each turn is kept in
 * {@link EvalSession.turns} with its own tokens and latency. A session one of
 * whose turns errored is an errored run, judged by no check, as a single
 * errored turn is. Every turn's own proposal is judged against the song it was
 * made on by check 1 and the checks every case is judged by (16 and 20), in
 * {@link sessionTurnChecks}.
 *
 * Nothing here calls the model: the caller hands in how one turn runs.
 */

import { type ControlAddress, uniqueControls } from "../../commands/controlAddress";
import type { RawCommandInput } from "../../commands/types";
import type { Project } from "../../domain/entities";
import { type AskAnswer, type AssistantAsk, answerMessage, pickedLabels } from "../ask";
import { type HistoryEntry, historyOf } from "../history";
import type { AssistantLessonContext } from "../lesson";
import type { AssistantProposal } from "../protocol";
import { splitRecommendations } from "../recommendation";
import type { ProviderUsage } from "../streamEvents";
import { withFirstTake } from "../takes";
import { caseChecksFor, isEveryCaseCheck, runCaseCheck } from "./caseChecks";
import type { EvalCase } from "./cases";
import {
  type CheckId,
  type CheckResult,
  checkAtomicUndo,
  checkValid,
  skip,
} from "./checks";
import type { EvalTokens, EvalTurn } from "./run";

/** The most turns a session runs when its case does not say. */
export const DEFAULT_SESSION_TURNS = 5;

/** One turn of a session: what it sent, and what came back. */
export interface EvalSessionTurn extends EvalTurn {
  /** 1-based. */
  readonly turn: number;
  /** The producer's message, as the turn sent it. */
  readonly request: string;
  /** The lesson block the turn sent: a lesson session's turns (GRV-208, `lessonSession.ts`). */
  readonly lesson?: AssistantLessonContext;
  /** The project description's facts the turn sent (`describedFacts`), for a lesson session's checks. */
  readonly described?: string;
}

/** Why a session stopped. */
export type EvalSessionEnd =
  /** A turn asked nothing more. */
  | "done"
  /** It reached its cap with a question still open. */
  | "cap"
  /** A turn errored. */
  | "errored"
  /** A turn's proposal did not apply, so there was no song to go on from. */
  | "refused";

export interface EvalSession {
  readonly turns: readonly EvalSessionTurn[];
  readonly ended: EvalSessionEnd;
  /** The cap it ran under. */
  readonly maxTurns: number;
}

/** The most turns `evalCase` runs: 1 for a case that is not a session. */
export function sessionTurnCap(evalCase: Pick<EvalCase, "session">): number {
  if (!evalCase.session) return 1;
  return evalCase.session.maxTurns ?? DEFAULT_SESSION_TURNS;
}

/**
 * How the scripted producer answers a question: the option the assistant
 * suggested, or the first when it suggested none.
 */
export function scriptedAnswer(ask: AssistantAsk): AskAnswer {
  const suggested =
    ask.suggested !== undefined && ask.suggested < ask.options.length ? ask.suggested : 0;
  return { picked: [suggested], text: "" };
}

/** What applying one turn's proposal to `project` came to. */
interface Applied {
  /** Check 1 on the proposal's changes; null when it had none (recommendations alone). */
  readonly valid: CheckResult | null;
  /** The song it leaves; null when it did not apply. */
  readonly after: Project | null;
}

/**
 * Applies a turn's proposal as the panel does: its sound recommendations
 * taken out, the changes validated and applied by the executor.
 */
function applyProposal(project: Project, proposal: AssistantProposal): Applied {
  const changes = splitRecommendations(withFirstTake(proposal)).proposal;
  if (!changes) return { valid: null, after: project };
  const valid = checkValid(project, changes);
  return { valid: valid.result, after: valid.applied?.after ?? null };
}

/** The conversation as the panel logs it, from a case's history and request. */
function caseEntries(evalCase: EvalCase): HistoryEntry[] {
  return [
    ...(evalCase.history ?? []).map(
      (message): HistoryEntry =>
        message.role === "user"
          ? { kind: "message", text: message.text }
          : { kind: "reply", text: message.text },
    ),
    { kind: "message", text: evalCase.request },
  ];
}

/** The ad-hoc single-turn case one turn of a session runs as. */
function turnCase(
  evalCase: EvalCase,
  project: Project,
  entries: readonly HistoryEntry[],
): EvalCase {
  const last = entries[entries.length - 1] as Extract<HistoryEntry, { kind: "message" }>;
  const { session: _session, ...single } = evalCase;
  return {
    ...single,
    fixture: () => project,
    history: historyOf(entries.slice(0, -1)),
    request: last.wire ?? last.text,
  };
}

/**
 * Runs `evalCase` as a session, one turn at a time through `runTurn`, the
 * scripted producer applying each proposal and answering each question.
 * Never throws for a failed turn: the session ends on it.
 */
export async function runSession(
  evalCase: EvalCase,
  runTurn: (turnCase: EvalCase) => Promise<EvalTurn>,
): Promise<EvalTurn> {
  const maxTurns = sessionTurnCap(evalCase);
  const fixture = evalCase.fixture();
  const entries = caseEntries(evalCase);
  const turns: EvalSessionTurn[] = [];
  let project = fixture;
  let ended: EvalSessionEnd = "done";
  for (let number = 1; ; number += 1) {
    const single = turnCase(evalCase, project, entries);
    const turn = await runTurn(single);
    turns.push({ ...turn, turn: number, request: single.request });
    if (turn.error) {
      ended = "errored";
      break;
    }
    let appliedChanges = false;
    if (turn.proposal) {
      const applied = applyProposal(project, turn.proposal);
      if (!applied.after) {
        ended = "refused";
        break;
      }
      project = applied.after;
      appliedChanges = applied.valid !== null;
    }
    const ask = turn.ask ?? null;
    if (!ask) break;
    if (number >= maxTurns) {
      ended = "cap";
      break;
    }
    const answer = scriptedAnswer(ask);
    entries.push(
      // The scripted producer applied its proposal, as the next turn says (GRV-150).
      {
        kind: "reply",
        text: turn.text,
        ask,
        ...(appliedChanges ? { proposal: "applied" } : {}),
      },
      {
        kind: "message",
        text: pickedLabels(ask, answer).join(", "),
        wire: answerMessage(ask, answer),
      },
    );
  }
  return sessionTurn(fixture, { turns, ended, maxTurns });
}

/**
 * Every turn's proposal as one, against the case's fixture: their calls in
 * order, kept on the session's record to show what it proposed. It is
 * display-only: no check reads it. Judging goes through
 * {@link sessionJudgement}, turn by turn, never through this one proposal,
 * which may hold more calls than any one proposal may. Null when no turn
 * proposed anything.
 */
export function sessionProposal(
  fixture: Project,
  turns: readonly EvalTurn[],
): AssistantProposal | null {
  const proposals = turns
    .map((turn) => turn.proposal)
    .filter((proposal): proposal is AssistantProposal => !!proposal);
  const [first] = proposals;
  if (!first) return null;
  return {
    baseRevision: fixture.metadata.revision,
    toolsetVersion: first.toolsetVersion,
    calls: proposals.flatMap((proposal) => proposal.calls),
  };
}

/** What a session's proposals, applied turn by turn, came to (GRV-145). */
export interface SessionJudgement {
  /**
   * Check 1 on the session: passes when every turn's changes applied to the
   * song the turn before left; fails on the first turn whose changes did not,
   * or when no turn proposed a change.
   */
  readonly valid: CheckResult;
  /** What the turns applied, and the song they left; null when one did not apply. */
  readonly applied: {
    /** Every applied turn's commands, in order. */
    readonly commands: readonly RawCommandInput[];
    /** Every control a turn changed, without repeats. */
    readonly controls: readonly ControlAddress[];
    readonly after: Project;
  } | null;
  /** Check 4 on each turn's own proposal: the first that fails, or a pass. */
  readonly atomicUndo: CheckResult;
  /** Every turn's sound recommendations, in order. */
  readonly recommendations: AssistantProposal["calls"];
}

/**
 * Applies each turn's proposal to the song the turn before left, from the
 * case's fixture, as the scripted producer did. `noProposal` says why there
 * was no change when no turn proposed one.
 */
export function sessionJudgement(
  fixture: Project,
  session: EvalSession,
  noProposal: string,
): SessionJudgement {
  let project = fixture;
  const commands: RawCommandInput[] = [];
  const controls: ControlAddress[] = [];
  const recommendations: AssistantProposal["calls"][number][] = [];
  let undo: CheckResult | null = null;
  let applied = 0;
  for (const turn of session.turns) {
    if (turn.error || !turn.proposal) continue;
    const split = splitRecommendations(withFirstTake(turn.proposal));
    recommendations.push(...split.recommendations);
    if (!split.proposal) continue;
    const valid = checkValid(project, split.proposal);
    if (!valid.applied) {
      return {
        valid: { ...valid.result, detail: `Turn ${turn.turn}: ${valid.result.detail}` },
        applied: null,
        atomicUndo: skip("The proposal did not apply"),
        recommendations,
      };
    }
    const turnUndo = checkAtomicUndo(project, split.proposal);
    if (turnUndo.status === "fail" && !undo) {
      undo = { ...turnUndo, detail: `Turn ${turn.turn}: ${turnUndo.detail}` };
    }
    commands.push(...valid.applied.proposal.commands);
    controls.push(...valid.applied.proposal.impact.controls);
    project = valid.applied.after;
    applied += 1;
  }
  if (applied === 0) {
    return {
      valid: checkValid(fixture, null, noProposal).result,
      applied: null,
      atomicUndo: skip("The proposal did not apply"),
      recommendations,
    };
  }
  return {
    valid: {
      status: "pass",
      detail: `${commands.length} commands applied over ${applied} ${applied === 1 ? "turn" : "turns"}`,
    },
    applied: { commands, controls: uniqueControls(controls), after: project },
    atomicUndo: undo ?? {
      status: "pass",
      detail: "Each turn: one entry; one undo restores its song exactly",
    },
    recommendations,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** The known values summed; null when none is known. */
function sumKnown(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length === 0 ? null : sum(known);
}

function sessionTokens(turns: readonly EvalTurn[]): EvalTokens | undefined {
  const tokens = turns.map((turn) => turn.tokens).filter((entry) => !!entry);
  if (tokens.length === 0) return undefined;
  return {
    outputTokens: sumKnown(tokens.map((entry) => entry.outputTokens)),
    thinkingChars: sum(tokens.map((entry) => entry.thinkingChars)),
    toolInputChars: sum(tokens.map((entry) => entry.toolInputChars)),
    textChars: sum(tokens.map((entry) => entry.textChars)),
  };
}

function sessionUsage(turns: readonly EvalTurn[]): ProviderUsage | null {
  const usages = turns
    .map((turn) => turn.usage)
    .filter((usage): usage is ProviderUsage => !!usage);
  if (usages.length === 0) return null;
  return {
    inputTokens: sum(usages.map((usage) => usage.inputTokens)),
    outputTokens: sum(usages.map((usage) => usage.outputTokens)),
    cacheCreationInputTokens: sum(usages.map((usage) => usage.cacheCreationInputTokens)),
    cacheReadInputTokens: sum(usages.map((usage) => usage.cacheReadInputTokens)),
  };
}

/**
 * The session as one run: every turn's proposal joined (display-only, see
 * {@link sessionProposal}), the sums, every turn kept.
 */
export function sessionTurn(fixture: Project, session: EvalSession): EvalTurn {
  const { turns } = session;
  const failed = turns.find((turn) => turn.error);
  const last = turns[turns.length - 1];
  const steps = turns.map((turn) => turn.steps).filter((entry) => !!entry);
  const tokens = sessionTokens(turns);
  return {
    durationMs: sum(turns.map((turn) => turn.durationMs)),
    error: failed ? `Turn ${failed.turn}: ${failed.error}` : null,
    turnError: failed?.turnError ?? null,
    stopReason: failed ? null : (last?.stopReason ?? null),
    text: turns
      .map((turn) => turn.text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n"),
    proposal: failed ? null : sessionProposal(fixture, turns),
    ask: failed ? null : (last?.ask ?? null),
    ...(tokens ? { tokens } : {}),
    ...(steps.length > 0
      ? {
          steps: {
            calls: sum(steps.map((entry) => entry.calls)),
            refused: steps.flatMap((entry) => entry.refused),
          },
        }
      : {}),
    usage: sessionUsage(turns),
    firstTextMs: turns[0]?.firstTextMs ?? null,
    // The first turn that streamed a part, from that turn's start: a session
    // often asks before it proposes.
    firstPartMs: turns.find((turn) => turn.firstPartMs != null)?.firstPartMs ?? null,
    // The first turn's, as its first text is; each turn keeps its own.
    toolBundle: turns[0]?.toolBundle ?? null,
    session,
  };
}

/**
 * Each turn's own proposal judged against the song it was made on: check 1
 * and the checks every case is judged by (16 and 20, less those the case is
 * exempt from). A turn that proposed nothing, or errored, has none; the walk
 * stops at a proposal that did not apply, as the session did.
 */
export function sessionTurnChecks(
  evalCase: EvalCase,
  session: EvalSession,
): Partial<Record<CheckId, CheckResult>>[] {
  const everyTurn = caseChecksFor([], evalCase.exempt).filter(isEveryCaseCheck);
  let project: Project | null = evalCase.fixture();
  return session.turns.map((turn) => {
    if (!project || turn.error || !turn.proposal) return {};
    const before: Project = project;
    const applied = applyProposal(before, turn.proposal);
    project = applied.after;
    if (!applied.valid) return {};
    const after = applied.after;
    return {
      valid: applied.valid,
      ...Object.fromEntries(
        everyTurn.map((id) => [
          id,
          after
            ? runCaseCheck(id, before, after, turn.text)
            : skip("The proposal did not apply"),
        ]),
      ),
    };
  });
}
