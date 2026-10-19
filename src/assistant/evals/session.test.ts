import { describe, expect, it } from "vitest";
import { addClip, setParameter } from "../../commands";
import type { Project } from "../../domain/entities";
import {
  createFactoryContext,
  createNoteClip,
  createPlacement,
} from "../../domain/factories";
import type { TrackId } from "../../domain/ids";
import { createSeededIdFactory } from "../../domain/ids";
import {
  createScriptedAssistantProvider,
  toolUseEvents,
} from "../../testing/scriptedAssistantProvider";
import { ASK_PRODUCER_TOOL_NAME, type AssistantAsk, answerMessage } from "../ask";
import { MAX_PROPOSAL_COMMANDS } from "../proposal";
import type { AssistantProposal } from "../protocol";
import { continuesTurn } from "../providerRequest";
import { ASSISTANT_TOOLSET_VERSION, toolCallsFor, toolNameFor } from "../tools";
import { type EvalCase, parseJsonEvalCase } from "./cases";
import { createHouseLoopProject } from "./fixtures";
import { renderMarkdown, sessionLines } from "./markdown";
import { type EvalTurn, evaluateRecords, evaluateTurn, runEvals } from "./run";
import { heavySetOf, scorecardOf } from "./scorecard";
import {
  DEFAULT_SESSION_TURNS,
  runSession,
  scriptedAnswer,
  sessionProposal,
  sessionTurnCap,
} from "./session";

const fixedNow = () => Date.parse("2026-10-19T12:00:00Z");

const SESSION_CASE: EvalCase = {
  id: "session-full-track",
  capability: "development",
  axis: "conventional",
  request: "Make this a full track.",
  expect: "proposal",
  fixture: createHouseLoopProject,
  selection: null,
  scope: {
    tracks: "all",
    createTracks: true,
    song: true,
    master: false,
    returns: false,
    sections: false,
  },
  session: {},
};

function trackId(project: Project, name: string): TrackId {
  const track = project.song.tracks.find((entry) => entry.name === name);
  if (!track) throw new Error(`No track ${name}`);
  return track.id;
}

function volumeOf(project: Project, name: string): number {
  const track = project.song.tracks.find((entry) => entry.name === name);
  return track?.mixer.volume ?? Number.NaN;
}

/** A tool call that sets `name`'s fader to `db`. */
function volumeCall(project: Project, name: string, db: number) {
  const command = setParameter(
    { scope: "track", trackId: trackId(project, name), parameterId: "track.volume" },
    db,
  );
  return { name: toolNameFor(command.type), input: command.payload };
}

function proposalOf(
  project: Project,
  calls: readonly { name: string; input: unknown }[],
): AssistantProposal {
  return {
    baseRevision: project.metadata.revision,
    toolsetVersion: ASSISTANT_TOOLSET_VERSION,
    calls: calls.map((call, index) => ({ id: `toolu_${index}`, ...call })),
  };
}

function nextStepAsk(id: string, suggested?: number): AssistantAsk {
  return {
    id,
    question: "What next?",
    options: [{ label: "Write the intro" }, { label: "Write the drop" }],
    multiSelect: false,
    ...(suggested === undefined ? {} : { suggested }),
  };
}

function turn(fields: Partial<EvalTurn>): EvalTurn {
  return {
    durationMs: 1_000,
    error: null,
    turnError: null,
    stopReason: "tool_use",
    text: "",
    proposal: null,
    ask: null,
    usage: {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    ...fields,
  };
}

/**
 * A turn runner that hands back `script(turnCase, index)` for each turn and
 * keeps every case it was given.
 */
function scriptedTurns(script: (turnCase: EvalCase, index: number) => EvalTurn) {
  const seen: EvalCase[] = [];
  return {
    seen,
    runTurn: async (turnCase: EvalCase) => {
      seen.push(turnCase);
      return script(turnCase, seen.length - 1);
    },
  };
}

describe("the scripted producer (GRV-145)", () => {
  it("answers with the suggested option, or the first when none is suggested", () => {
    expect(scriptedAnswer(nextStepAsk("a", 1))).toEqual({ picked: [1], text: "" });
    expect(scriptedAnswer(nextStepAsk("b"))).toEqual({ picked: [0], text: "" });
  });

  it("caps a session at five turns unless the case says otherwise, and a plain case at one", () => {
    expect(DEFAULT_SESSION_TURNS).toBe(5);
    expect(sessionTurnCap(SESSION_CASE)).toBe(5);
    expect(sessionTurnCap({ session: { maxTurns: 2 } })).toBe(2);
    expect(sessionTurnCap({})).toBe(1);
  });

  it("applies each proposal, answers each question with the suggested option, and records every turn", async () => {
    const fixture = createHouseLoopProject();
    const turns = scriptedTurns((turnCase, index) => {
      const project = turnCase.fixture();
      return turn({
        text: `Step ${index + 1}.`,
        proposal: proposalOf(project, [volumeCall(project, "Bass", -1 - index)]),
        ask: index < 2 ? nextStepAsk(`ask_${index}`, 1) : null,
        durationMs: 1_000 * (index + 1),
      });
    });
    const result = await runSession(SESSION_CASE, turns.runTurn);

    // Three turns: the third asked nothing, so the session was done.
    expect(turns.seen).toHaveLength(3);
    expect(result.session?.ended).toBe("done");
    expect(result.session?.turns.map((entry) => entry.turn)).toEqual([1, 2, 3]);
    // Each turn saw the song the one before left.
    expect(turns.seen.map((seen) => volumeOf(seen.fixture(), "Bass"))).toEqual([
      volumeOf(fixture, "Bass"),
      -1,
      -2,
    ]);
    // The answer is the suggested option, sent as the panel sends it, after
    // the reply and its question.
    const answer = answerMessage(nextStepAsk("ask_0", 1), { picked: [1], text: "" });
    expect(turns.seen[0].request).toBe(SESSION_CASE.request);
    expect(turns.seen[1].request).toBe(answer);
    expect(turns.seen[1].request).toContain("Write the drop");
    expect(turns.seen[1].history?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(turns.seen[1].history?.[1].text).toContain("Step 1.");
    expect(turns.seen[1].history?.[1].text).toContain("[I asked the producer");
    expect(turns.seen[2].history).toHaveLength(4);
    expect(turns.seen.every((seen) => seen.session === undefined)).toBe(true);

    // The session as one run: its sums, every turn's text, and one proposal
    // that leaves the final song.
    expect(result.durationMs).toBe(6_000);
    expect(result.usage?.outputTokens).toBe(1_500);
    expect(result.text).toBe("Step 1.\n\nStep 2.\n\nStep 3.");
    expect(result.proposal?.calls).toHaveLength(3);
    expect(result.proposal?.baseRevision).toBe(fixture.metadata.revision);
    expect(result.error).toBeNull();

    const record = evaluateTurn(SESSION_CASE, 1, result);
    expect(record.checks.valid?.status).toBe("pass");
    expect(record.stats?.mixer).toContain("Bass volume=-3 pan=0");
    expect(record.turnChecks?.map((checks) => checks.valid?.status)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
  });

  it("judges the final song turn by turn, so a session may add up to more calls than one proposal may hold", async () => {
    const perTurn = 40;
    const turns = scriptedTurns((turnCase, index) => {
      const project = turnCase.fixture();
      const calls = Array.from({ length: perTurn }, (_, step) =>
        volumeCall(project, "Bass", -1 - ((index * perTurn + step) % 30)),
      );
      return turn({
        proposal: proposalOf(project, calls),
        ask: index < 2 ? nextStepAsk(`ask_${index}`, 0) : null,
      });
    });
    const result = await runSession(SESSION_CASE, turns.runTurn);
    expect(result.session?.ended).toBe("done");
    expect(result.proposal?.calls.length).toBeGreaterThan(MAX_PROPOSAL_COMMANDS);

    const record = evaluateTurn(SESSION_CASE, 1, result);
    expect(record.turnChecks?.map((checks) => checks.valid?.status)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
    expect(record.checks.valid).toEqual({
      status: "pass",
      detail: `${3 * perTurn} commands applied over 3 turns`,
    });
    expect(record.checks.atomicUndo?.status).toBe("pass");
    expect(record.stats?.commandCount).toBe(3 * perTurn);
    // The last call of the last turn sets the fader the final song keeps.
    expect(record.stats?.mixer).toContain(
      `Bass volume=${-1 - ((3 * perTurn - 1) % 30)} pan=0`,
    );

    // A saved report replays the same, from its turns.
    const [replayed] = evaluateRecords(
      [{ ...record, caseId: SESSION_CASE.id }],
      [SESSION_CASE],
    );
    expect(replayed.checks).toEqual(record.checks);
  });

  it("stops at the cap with the question still open", async () => {
    const turns = scriptedTurns((_turnCase, index) =>
      turn({ text: "Asking.", ask: nextStepAsk(`ask_${index}`, 0) }),
    );
    const result = await runSession(
      { ...SESSION_CASE, session: { maxTurns: 2 } },
      turns.runTurn,
    );
    expect(turns.seen).toHaveLength(2);
    expect(result.session?.ended).toBe("cap");
    expect(result.session?.maxTurns).toBe(2);
    expect(result.ask?.id).toBe("ask_1");
    expect(result.proposal).toBeNull();
  });

  it("ends on an errored turn, and the whole run is errored", async () => {
    const turns = scriptedTurns((turnCase, index) => {
      const project = turnCase.fixture();
      if (index === 1) {
        return turn({
          error: "reply_too_long: cut off",
          turnError: {
            code: "reply_too_long",
            message: "cut off",
            providerStatus: null,
            providerFailures: [],
          },
          stopReason: null,
          usage: null,
        });
      }
      return turn({
        proposal: proposalOf(project, [volumeCall(project, "Bass", -6)]),
        ask: nextStepAsk("ask_0", 0),
      });
    });
    const result = await runSession(SESSION_CASE, turns.runTurn);
    expect(result.session?.ended).toBe("errored");
    expect(result.error).toBe("Turn 2: reply_too_long: cut off");
    expect(result.turnError?.code).toBe("reply_too_long");
    expect(result.proposal).toBeNull();
    const record = evaluateTurn(SESSION_CASE, 1, result);
    expect(record.checks).toEqual({});
    // The turn before it is still judged on its own.
    expect(record.turnChecks?.[0].valid?.status).toBe("pass");
    expect(record.turnChecks?.[1]).toEqual({});
  });

  it("ends on a proposal that does not apply, which fails check 1 on the final song", async () => {
    const turns = scriptedTurns((turnCase) => {
      const project = turnCase.fixture();
      return turn({
        proposal: proposalOf(project, [volumeCall(project, "Bass", 99)]),
        ask: nextStepAsk("ask_0", 0),
      });
    });
    const result = await runSession(SESSION_CASE, turns.runTurn);
    expect(turns.seen).toHaveLength(1);
    expect(result.session?.ended).toBe("refused");
    const record = evaluateTurn(SESSION_CASE, 1, result);
    expect(record.checks.valid?.status).toBe("fail");
    expect(record.turnChecks?.[0].valid?.status).toBe("fail");
  });

  it("judges checks 16 and 20 on each turn's own proposal", async () => {
    const turns = scriptedTurns((turnCase, index) => {
      const project = turnCase.fixture();
      if (index === 0) {
        const context = createFactoryContext({ ids: createSeededIdFactory("session") });
        const clip = createNoteClip(context, {
          trackId: trackId(project, "Bass"),
          name: "Empty",
        });
        // A clip with no notes, placed: check 16 fails, check 20 passes.
        const placement = createPlacement(context, {
          clipId: clip.id,
          trackId: clip.trackId,
          // After the loop, which fills the first bars.
          startTicks: clip.lengthTicks * 16,
          durationTicks: clip.lengthTicks,
        });
        const command = addClip(clip, [placement]);
        return turn({
          proposal: proposalOf(project, toolCallsFor(command)),
          ask: nextStepAsk("ask_0", 0),
        });
      }
      return turn({ proposal: proposalOf(project, [volumeCall(project, "Bass", -2)]) });
    });
    const result = await runSession(SESSION_CASE, turns.runTurn);
    const record = evaluateTurn(SESSION_CASE, 1, result);
    expect(record.turnChecks?.map((checks) => checks.noEmptyClips?.status)).toEqual([
      "fail",
      "pass",
    ]);
    expect(record.turnChecks?.map((checks) => checks.clipsPlaced?.status)).toEqual([
      "pass",
      "pass",
    ]);
    // The final song is judged too, by every check as a single turn is.
    expect(record.checks.noEmptyClips?.status).toBe("fail");
  });

  it("leaves no proposal for a session that proposed nothing", () => {
    expect(sessionProposal(createHouseLoopProject(), [turn({})])).toBeNull();
  });
});

describe("a session case through runEvals (GRV-145)", () => {
  it("runs every turn through the gateway, and reports each turn's tokens and latency", async () => {
    const project = createHouseLoopProject();
    const askCall = {
      name: ASK_PRODUCER_TOOL_NAME,
      input: {
        question: "What next?",
        options: [{ label: "Write the intro" }, { label: "Write the drop" }],
        suggested: 1,
      },
    };
    const provider = createScriptedAssistantProvider([
      toolUseEvents("The structure first.", [volumeCall(project, "Bass", -2), askCall], {
        outputTokens: 400,
      }),
      toolUseEvents("Now the drop.", [volumeCall(project, "Lead", -3)], {
        outputTokens: 300,
      }),
    ]);
    const report = await runEvals({
      provider,
      cases: [SESSION_CASE],
      runs: 1,
      now: fixedNow,
    });

    const opening = provider.requests.filter((sent) => !continuesTurn(sent));
    expect(opening).toHaveLength(2);
    const second = opening[1].messages;
    expect(second[second.length - 1]).toEqual({
      role: "user",
      content: expect.stringContaining("Picked: Write the drop."),
    });

    const [record] = report.records;
    expect(record.error).toBeNull();
    expect(record.session?.turns).toHaveLength(2);
    expect(record.session?.ended).toBe("done");
    expect(record.session?.turns.map((entry) => entry.usage?.outputTokens)).toEqual([
      400, 300,
    ]);
    expect(record.checks.valid?.status).toBe("pass");
    expect(record.stats?.mixer).toEqual(
      expect.arrayContaining(["Bass volume=-2 pan=0", "Lead volume=-3 pan=0"]),
    );

    const card = report.scorecard.cases[SESSION_CASE.id];
    expect(card.byTurn?.turns).toBe(2);
    expect(card.byTurn?.perRun).toBe(2);
    expect(card.byTurn?.outputTokens).toBe(350);
    expect(card.meanTokens.output).toBe(700);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain("## Sessions");
    expect(markdown).toMatch(
      /\| `session-full-track` \| 1 \| 2 of 5 \| done \| 400 \/ 300 \| .* \| none \| none \|/,
    );
  });

  it("reads a heavy session case per turn in the heavy set, not per session", () => {
    const heavy: EvalCase = { ...SESSION_CASE, id: "develop-track-arrange" };
    const session = (durations: readonly number[]) => ({
      turns: durations.map((durationMs, index) => ({
        ...turn({ durationMs, steps: { calls: 2, refused: [] } }),
        turn: index + 1,
        request: heavy.request,
      })),
      ended: "done" as const,
      maxTurns: 5,
    });
    const sessions = [session([1_000, 3_000]), session([2_000, 2_000])];
    const records = sessions.map((entry, index) =>
      evaluateTurn(heavy, index + 1, {
        ...turn({
          durationMs: entry.turns.reduce((total, t) => total + t.durationMs, 0),
          usage: {
            inputTokens: 2_000,
            outputTokens: 1_000,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          steps: { calls: 4, refused: [] },
        }),
        session: entry,
      }),
    );
    const card = scorecardOf({
      model: "claude-sonnet-5",
      caseIds: [heavy.id],
      records,
      summary: { checks: {}, errored: { total: 0 } },
    });
    const set = heavySetOf(card);
    expect(set?.caseIds).toEqual([heavy.id]);
    // Each turn spent 500 output tokens and made 2 model calls; a session's
    // sums (1,000 and 4) would read twice that.
    expect(set?.outputTokens).toBe(500);
    expect(set?.modelCallsMean).toBe(2);
    expect(set?.latencyP50Ms).toBe(2_000);
    expect(card.cases[heavy.id].meanTokens.output).toBe(1_000);
    const perTurnCost = card.cases[heavy.id].byTurn?.costUsd;
    expect(perTurnCost).not.toBeNull();
    expect(set?.costPerTurnUsd).toBeCloseTo(
      (card.cases[heavy.id].costUsd.perTurn ?? Number.NaN) / 2,
    );
  });

  it("counts a run of one turn as one turn, and lists no sessions", () => {
    const records = [
      evaluateTurn(
        { ...SESSION_CASE, session: undefined },
        1,
        turn({ durationMs: 2_000 }),
      ),
    ];
    const card = scorecardOf({
      model: "claude-sonnet-5",
      caseIds: [SESSION_CASE.id],
      records,
      summary: { checks: {}, errored: { total: 0 } },
    });
    expect(card.secondary.byTurn).toEqual({
      turns: 1,
      perRun: 1,
      outputTokens: 500,
      latencyMs: { count: 1, p50: 2_000, p95: 2_000 },
      costUsd: card.secondary.costUsd.perTurn,
      modelCalls: { count: 0, mean: null, p95: null },
    });
    expect(sessionLines(records)).toEqual([]);
  });
});

describe("a session case saved as JSON (GRV-145)", () => {
  it("may name its session, and nothing else about it", () => {
    const json = {
      id: "saved-session",
      capability: "development",
      axis: "conventional",
      request: "Make this a full tune",
      expect: "proposal",
      fixture: "house-loop",
      selection: null,
      scope: SESSION_CASE.scope,
    };
    expect(
      parseJsonEvalCase({ ...json, session: { maxTurns: 3 } }, "case").session,
    ).toEqual({ maxTurns: 3 });
    expect(parseJsonEvalCase({ ...json, session: {} }, "case").session).toEqual({});
    expect(() =>
      parseJsonEvalCase({ ...json, session: { maxTurns: 0 } }, "case"),
    ).toThrow(/session/);
    expect(() => parseJsonEvalCase({ ...json, session: { turns: 3 } }, "case")).toThrow(
      /session/,
    );
  });
});
