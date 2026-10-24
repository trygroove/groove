/**
 * Lesson sessions (GRV-208): a case that runs one bite of a lesson as the
 * panel does, through the real gateway, with a **scripted producer** who does
 * each step by pressing Show me (or skips it).
 *
 * 1. The lesson is walked, by Show me and with no model, from its start (the
 *    starter project, `src/testing/lessonWorld.ts`) to the bite the case
 *    teaches ({@link lessonWalk}). The project it has made by then is the
 *    case's fixture, and the bite's start is the session's first turn.
 * 2. Each turn sends what the panel's `sendLesson` sends: the moment's line
 *    (`cueMessage`) as the producer's message, the lesson block
 *    (`lessonCue`) and the producer's memory, after the conversation so far.
 * 3. Between turns the producer does the step under way: its own Show me,
 *    applied to the project through the command kernel, or Skip; the
 *    lesson's own predicate ends it, and `changes` is what
 *    `describeChanges` says it changed. A step whose Show me is the
 *    editor's to do (a library sound) is skipped. So every moment
 *    (`bite_started`, `step_done`, `bite_done`, `chapter_done`) is sent
 *    against the project the step really left.
 * 4. A question the reply asks (`ask_producer`, a quiz) is answered with its
 *    suggested option, as an ordinary turn with the lesson under way
 *    (`under_way`), before the lesson goes on.
 * 5. The session ends once the bite's last turn has had its reply, when a
 *    turn errors, or at its cap of turns.
 *
 * The producer never applies a proposal: a lesson turn should change nothing
 * (`LESSON_RULES`), and check 8 fails one that does. Each turn keeps the
 * lesson block and the project facts it sent, so checks 25 to 28 judge every
 * turn against its own and a saved report replays.
 *
 * Nothing here calls the model: the caller hands in how one turn runs.
 */
import type { Project } from "../../domain/entities";
import { cueMessage, lessonCue } from "../../lessons/cue";
import { type BiteId, type ChapterId, isLessonId } from "../../lessons/ids";
import {
  biteOf,
  type LessonState,
  type LessonTransition,
  markShown,
  observe,
  skip,
  startLesson,
  startNextBite,
} from "../../lessons/session";
import type { LessonSettings, LessonWorld } from "../../lessons/types";
import { applyShowMe, lessonContext, starterWorld } from "../../testing/lessonWorld";
import { answerMessage, pickedLabels } from "../ask";
import { type HistoryEntry, historyOf } from "../history";
import { type AssistantLessonContext, assistantLessonContextSchema } from "../lesson";
import type { EvalCase } from "./cases";
import type { CheckId, CheckResult } from "./checks";
import {
  describedFacts,
  type LessonCheckId,
  type LessonReply,
  type LessonTurnSent,
  runLessonCheck,
  songChangeCalls,
} from "./lessonChecks";
import type { EvalTurn } from "./run";
import {
  type EvalSession,
  type EvalSessionEnd,
  type EvalSessionTurn,
  scriptedAnswer,
  sessionTurn,
} from "./session";

/** The most turns a lesson session runs when its case does not say. */
export const DEFAULT_LESSON_TURNS = 6;

/** One bite of a lesson, as a case runs it. */
export interface EvalLessonScript {
  /** "Finish a track" (GRV-44), or the chapter taught alone. */
  readonly track: boolean;
  /** The chapter the bite is in. */
  readonly chapter: ChapterId;
  /** The bite the session teaches. */
  readonly bite: BiteId;
  /** How the scripted producer ends each of its steps. */
  readonly how: "show_me" | "skipped";
  readonly settings: LessonSettings;
  /** The most turns it runs; {@link DEFAULT_LESSON_TURNS} when absent. */
  readonly maxTurns?: number;
  /**
   * A change to the project the walk makes once bite `after` is over, as a
   * producer's own edit between bites (applied through the command kernel),
   * so the case's bite starts from a project Show me alone would not leave.
   * `id` keeps walks with and without it apart.
   */
  readonly prepare?: EvalLessonPrepare;
}

/** A producer's edit between two bites of the walk: see {@link EvalLessonScript.prepare}. */
export interface EvalLessonPrepare {
  readonly id: string;
  readonly after: BiteId;
  readonly apply: (project: Project) => Project;
}

/** Where a lesson stands once walked to a bite's start, with no model. */
export interface LessonWalk {
  readonly world: LessonWorld;
  readonly transition: LessonTransition;
  /** The bites finished on the way, for the wrap-up's pointers. */
  readonly done: readonly BiteId[];
}

/** Where a lesson starts: "Finish a track" from its first chapter, or the chapter's first bite. */
function lessonStart(
  script: Pick<EvalLessonScript, "track" | "chapter" | "settings">,
  world: LessonWorld,
): LessonTransition {
  const lesson = script.track ? "track" : script.chapter;
  const start = isLessonId(lesson)
    ? startLesson(lesson, null, world, script.settings)
    : null;
  if (!start) throw new Error(`The "${script.chapter}" lesson has nothing to teach`);
  return start;
}

/** Applies a Show me as the editor does: a play runs on four bars, an export is pressed. */
function show(
  state: LessonState,
  world: LessonWorld,
  settings: LessonSettings,
  seed: number,
): { state: LessonState; world: LessonWorld } | null {
  if (!state.step) return null;
  const step = biteOf(state).steps[state.step.index];
  const shown = step?.showMe(world, settings, lessonContext(seed)) ?? null;
  if (!shown || shown.kind === "sound") return null;
  const marked = markShown(state);
  if (shown.kind === "export") {
    return { state: marked, world: { ...world, stemExports: world.stemExports + 1 } };
  }
  const after = applyShowMe(world, shown);
  return {
    state: marked,
    world: shown.kind === "play" ? { ...after, bar: after.bar + 4, barsHeard: 4 } : after,
  };
}

/**
 * Ends the step under way as the producer would: by Show me, read by the
 * step's own predicate, or by Skip. Stopped between steps, as they would.
 */
function doStep(
  state: LessonState,
  world: LessonWorld,
  settings: LessonSettings,
  how: EvalLessonScript["how"],
  seed: number,
): { transition: LessonTransition; world: LessonWorld } {
  const shown = how === "show_me" ? show(state, world, settings, seed) : null;
  const transition = shown
    ? observe(shown.state, shown.world, settings)
    : skip(state, world, settings);
  if (!transition) {
    throw new Error(`${biteOf(state).id}: Show me did not finish its step`);
  }
  const now = shown ? shown.world : world;
  return { transition, world: { ...now, playing: false } };
}

/** One turn a walked lesson would have sent: its line and its moment. */
export interface LessonLine {
  readonly text: string;
  readonly moment: AssistantLessonContext["moment"];
}

interface Walked extends LessonWalk {
  readonly lines: readonly LessonLine[];
}

/**
 * Walks the lesson from its start, every step by Show me, until `stop` holds
 * for a transition; or, with no `stop`, to the lesson's end.
 */
function walkLesson(
  script: Pick<EvalLessonScript, "track" | "chapter" | "settings" | "prepare">,
  stop?: (transition: LessonTransition) => boolean,
): Walked | null {
  let world = starterWorld();
  let transition: LessonTransition | null = lessonStart(script, world);
  let last = transition;
  const done: BiteId[] = [];
  const lines: LessonLine[] = [];
  let seed = 1;
  for (let guard = 0; transition && guard < 500; guard += 1) {
    last = transition;
    const { state, event } = transition;
    if (stop?.(transition)) return { world, transition, done, lines };
    lines.push({
      text: cueMessage(state, event),
      moment: lessonCue(state, event, script.settings, done).moment,
    });
    if (state.step) {
      const next = doStep(state, world, script.settings, "show_me", seed++);
      transition = next.transition;
      world = next.world;
      continue;
    }
    const over = biteOf(state).id;
    done.push(over);
    if (script.prepare?.after === over) {
      world = { ...world, project: script.prepare.apply(world.project) };
    }
    transition = startNextBite(state, world, script.settings);
  }
  return stop ? null : { world, transition: last, done, lines };
}

const walks = new Map<string, LessonWalk>();

/**
 * The lesson walked from its start, every step by Show me, to the start of
 * `script.bite`: the same every time, so the case's fixture and its first
 * turn agree.
 */
export function lessonWalk(
  script: Pick<EvalLessonScript, "track" | "chapter" | "bite" | "settings" | "prepare">,
): LessonWalk {
  const key = JSON.stringify([
    script.track,
    script.chapter,
    script.bite,
    script.settings,
    script.prepare?.id ?? null,
  ]);
  const kept = walks.get(key);
  if (kept) return kept;
  const walked = walkLesson(
    script,
    ({ state, event }) =>
      event.kind === "bite_started" && biteOf(state).id === script.bite,
  );
  if (!walked) throw new Error(`The lesson never reached "${script.bite}"`);
  const walk = { world: walked.world, transition: walked.transition, done: walked.done };
  walks.set(key, walk);
  return walk;
}

/**
 * A chapter taught alone, walked by Show me from its start to its end: the
 * project it leaves, and the line of each turn it sent on the way.
 */
export function finishedChapter(
  chapter: ChapterId,
  settings: LessonSettings,
): { readonly project: Project; readonly lines: readonly LessonLine[] } {
  const walked = walkLesson({ track: false, chapter, settings });
  if (!walked) throw new Error(`The "${chapter}" chapter never ended`);
  return { project: walked.world.project, lines: walked.lines };
}

/** The project the lesson has made by the start of the case's bite. */
export function lessonFixture(script: EvalLessonScript): () => Project {
  return () => lessonWalk(script).world.project;
}

/** The line the conversation shows as the case's bite starts: the case's request. */
export function lessonOpening(script: EvalLessonScript): string {
  const { transition } = lessonWalk(script);
  return cueMessage(transition.state, transition.event);
}

/** The lesson block for `state` after `event` (null: the producer wrote), as the panel sends it. */
export function lessonBlockFor(
  state: LessonState,
  event: LessonTransition["event"] | null,
  settings: LessonSettings,
  done: readonly string[],
): AssistantLessonContext {
  return assistantLessonContextSchema.parse(lessonCue(state, event, settings, done));
}

/** The conversation entries a case's history stands for. */
function historyEntries(evalCase: EvalCase): HistoryEntry[] {
  return (evalCase.history ?? []).map(
    (message): HistoryEntry =>
      message.role === "user"
        ? { kind: "message", text: message.text }
        : { kind: "reply", text: message.text },
  );
}

/**
 * Runs `evalCase`'s bite as a lesson session, one turn at a time through
 * `runTurn`. Never throws for a failed turn: the session ends on it.
 */
export async function runLessonSession(
  evalCase: EvalCase,
  runTurn: (turnCase: EvalCase) => Promise<EvalTurn>,
): Promise<EvalTurn> {
  const script = evalCase.lessonSession;
  if (!script) throw new Error(`"${evalCase.id}" is not a lesson session`);
  const maxTurns = script.maxTurns ?? DEFAULT_LESSON_TURNS;
  const walk = lessonWalk(script);
  const fixture = walk.world.project;
  const done: string[] = [...walk.done];
  const entries = historyEntries(evalCase);
  const turns: EvalSessionTurn[] = [];
  let world = walk.world;
  let transition = walk.transition;
  let message = {
    text: cueMessage(transition.state, transition.event),
    wire: undefined as string | undefined,
  };
  let lesson = lessonBlockFor(transition.state, transition.event, script.settings, done);
  let biteOver = false;
  let ended: EvalSessionEnd = "done";
  let seed = 10_000;
  const { session: _session, lessonSession: _script, ...single } = evalCase;
  for (let number = 1; ; number += 1) {
    const project = world.project;
    const request = message.wire ?? message.text;
    const turnCase: EvalCase = {
      ...single,
      fixture: () => project,
      history: historyOf(entries),
      request,
      lesson,
    };
    const turn = await runTurn(turnCase);
    turns.push({
      ...turn,
      turn: number,
      request,
      lesson,
      described: describedFacts(project),
    });
    if (turn.error) {
      ended = "errored";
      break;
    }
    const ask = turn.ask ?? null;
    entries.push(
      {
        kind: "message",
        text: message.text,
        ...(message.wire ? { wire: message.wire } : {}),
      },
      { kind: "reply", text: turn.text, ...(ask ? { ask } : {}) },
    );
    if (!ask && biteOver) break;
    if (number >= maxTurns) {
      ended = "cap";
      break;
    }
    if (ask) {
      // The producer answers, as an ordinary message with the lesson under way.
      const answer = scriptedAnswer(ask);
      message = {
        text: pickedLabels(ask, answer).join(", "),
        wire: answerMessage(ask, answer),
      };
      lesson = lessonBlockFor(transition.state, null, script.settings, done);
      continue;
    }
    const next = doStep(transition.state, world, script.settings, script.how, seed++);
    transition = next.transition;
    world = next.world;
    if (transition.event.kind === "bite_done") {
      biteOver = true;
      done.push(biteOf(transition.state).id);
    }
    message = { text: cueMessage(transition.state, transition.event), wire: undefined };
    lesson = lessonBlockFor(transition.state, transition.event, script.settings, done);
  }
  const session: EvalSession = { turns, ended, maxTurns };
  return sessionTurn(fixture, session);
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

/** What a single-turn lesson case sent: its lesson block, its request, its fixture. */
function caseSent(evalCase: EvalCase): LessonTurnSent {
  return {
    lesson: evalCase.lesson ?? null,
    request: evalCase.request,
    described: describedFacts(evalCase.fixture()),
  };
}

/** What one turn of a lesson session sent. */
function turnSent(turn: EvalSessionTurn): LessonTurnSent {
  return {
    lesson: turn.lesson ?? null,
    request: turn.request,
    described: turn.described ?? "",
  };
}

function judge(
  ids: readonly LessonCheckId[],
  reply: LessonReply,
  sent: LessonTurnSent,
  evalCase: EvalCase,
): Partial<Record<CheckId, CheckResult>> {
  return Object.fromEntries(
    ids.map((id) => [id, runLessonCheck(id, reply, sent, evalCase.startsLesson)]),
  );
}

/** The first failure over a session's turns, or a pass when every turn passed. */
function overTurns(
  id: LessonCheckId,
  turns: readonly Partial<Record<CheckId, CheckResult>>[],
): CheckResult {
  const judged = turns
    .map((checks, index) => ({ result: checks[id], turn: index + 1 }))
    .filter((entry): entry is { result: CheckResult; turn: number } => !!entry.result);
  const failed = judged.find((entry) => entry.result.status === "fail");
  if (failed)
    return { status: "fail", detail: `Turn ${failed.turn}: ${failed.result.detail}` };
  const passed = judged.filter((entry) => entry.result.status === "pass").length;
  return passed > 0
    ? { status: "pass", detail: `Every turn (${passed} of ${judged.length})` }
    : { status: "skip", detail: "No turn could be judged" };
}

/**
 * A lesson case's lesson checks: on its one turn, or on each turn of its
 * session (kept per turn in `turnChecks`, and for the record the first turn
 * that failed).
 */
export function lessonChecksOf(
  evalCase: EvalCase,
  turn: EvalTurn,
): {
  readonly checks: Partial<Record<CheckId, CheckResult>>;
  readonly turnChecks?: readonly Partial<Record<CheckId, CheckResult>>[];
} {
  const ids = evalCase.lessonChecks ?? [];
  if (!turn.session) return { checks: judge(ids, turn, caseSent(evalCase), evalCase) };
  const turnChecks = turn.session.turns.map((each) =>
    each.error ? {} : judge(ids, each, turnSent(each), evalCase),
  );
  return {
    checks: Object.fromEntries(ids.map((id) => [id, overTurns(id, turnChecks)])),
    turnChecks,
  };
}

/** The turn's proposal as check 8 reads it on a lesson case: only what changes the song. */
export function songChangesOf(turn: EvalTurn): EvalTurn["proposal"] {
  return songChangeCalls(turn.proposal).length > 0 ? (turn.proposal ?? null) : null;
}
