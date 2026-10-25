import { describe, expect, it } from "vitest";
import { addDevice, setParameter, setTrackFlag } from "../../commands";
import { createDevice } from "../../domain/devices";
import { createFactoryContext } from "../../domain/factories";
import { createSeededIdFactory } from "../../domain/ids";
import {
  createScriptedAssistantProvider,
  replyEvents,
  toolUseEvents,
} from "../../testing/scriptedAssistantProvider";
import { offerTakesCall } from "../../testing/takes";
import {
  ASSISTANT_PROMPT_VERSION,
  assistantSystemPrompt,
  createIdStem,
  newId,
} from "../prompt";
import { continuesTurn } from "../providerRequest";
import { describeTactics, resolveTactics, TACTIC_DEFAULTS } from "../tactics";
import { expandTakesCall } from "../takes";
import { ASSISTANT_TOOLSET_VERSION, toolNameFor } from "../tools";
import { EVAL_CASES, type EvalCase } from "./cases";
import { createHouseLoopProject } from "./fixtures";
import {
  formatTally,
  renderMarkdown,
  renderSummaryMarkdown,
  validFailureLine,
} from "./markdown";
import {
  buildReport,
  evalExitCode,
  evaluateRecords,
  evaluateTurn,
  evaluateTurnSafely,
  runEvals,
  summaryOf,
  whyNoProposal,
} from "./run";
import {
  AUTH_ABORT_REASON,
  CREDIT_ABORT_REASON,
  REFUSAL_STREAK,
  refusalAbortReason,
} from "./runGuard";

const glue = EVAL_CASES.find((entry) => entry.id === "process-glue") as EvalCase;
const crushed = EVAL_CASES.find((entry) => entry.id === "process-crushed") as EvalCase;

function compressorCall(seed: string, threshold: number) {
  const device = {
    ...createDevice(
      createFactoryContext({ ids: createSeededIdFactory(seed) }).ids("device"),
      "compressor",
      0,
    ),
    parameters: { threshold, ratio: 2 },
  };
  const command = addDevice({ chain: "master" }, device);
  return { name: toolNameFor(command.type), input: command.payload };
}

const fixedNow = () => Date.parse("2026-10-09T12:00:00Z");

describe("runEvals", () => {
  it("runs each case N times through the gateway and judges every check", async () => {
    const project = createHouseLoopProject();
    const bass = project.song.tracks.find((track) => track.name === "Bass");
    const bassDown = setParameter(
      {
        scope: "track",
        trackId: bass?.id ?? project.song.tracks[1].id,
        parameterId: "track.volume",
      },
      -4,
    );
    const provider = createScriptedAssistantProvider([
      // process-glue, run 1 and 2: the same gentle compressor.
      toolUseEvents("A Compressor on the master to glue it.", [compressorCall("a", -18)]),
      toolUseEvents("A Compressor on the master to glue it.", [compressorCall("b", -18)]),
      // process-crushed, run 1: the same compressor again (flattened); run 2:
      // a crushed one that also reaches outside its scope.
      toolUseEvents("Crushing it.", [compressorCall("c", -18)]),
      toolUseEvents("Crushing it, and the Bass volume down.", [
        compressorCall("d", -50),
        { name: toolNameFor(bassDown.type), input: bassDown.payload },
      ]),
    ]);
    const report = await runEvals({
      provider,
      cases: [glue, crushed],
      runs: 2,
      now: fixedNow,
    });

    // One request opens each turn; each then ends in a step of its own.
    expect(provider.requests.filter((sent) => !continuesTurn(sent))).toHaveLength(4);
    expect(provider.requests[0].system[0].text).toBe(
      assistantSystemPrompt(TACTIC_DEFAULTS),
    );
    expect(provider.requests[0].tools.length).toBeGreaterThan(0);
    expect(provider.requests[0].messages).toEqual([
      { role: "user", content: glue.request },
    ]);

    expect(report.promptVersion).toBe(ASSISTANT_PROMPT_VERSION);
    expect(report.model).toBe("claude-sonnet-5");
    expect(report.records.map((record) => [record.caseId, record.run])).toEqual([
      ["process-glue", 1],
      ["process-glue", 2],
      ["process-crushed", 1],
      ["process-crushed", 2],
    ]);
    const [, , flattened, wild] = report.records;
    expect(flattened.checks.notFlattened?.status).toBe("fail");
    expect(wild.checks.notFlattened?.status).toBe("pass");
    expect(wild.checks.inScope?.status).toBe("fail");
    expect(report.records[0].checks.notFlattened).toBeUndefined();
    expect(report.summary.checks.valid).toEqual({ pass: 4, fail: 0, skip: 0 });
    expect(report.summary.checks.inScope).toEqual({ pass: 3, fail: 1, skip: 0 });
    expect(report.summary.checks.notFlattened).toEqual({ pass: 1, fail: 1, skip: 0 });
    expect(report.records[3].stats?.deviceParameters).toEqual([
      "Compressor threshold=-50 ratio=2",
    ]);
    expect(report.records[3].stats?.mixer).toEqual(["Bass volume=-4 pan=0"]);
  });

  it("fails check 1 on a reply with no proposal, and judges an errored turn by no check", async () => {
    const provider = createScriptedAssistantProvider([
      replyEvents(["Which part should I compress?"]),
      [{ fail: "rejected", status: 400 }],
    ]);
    const report = await runEvals({ provider, cases: [glue], runs: 2, now: fixedNow });
    const [question, failed] = report.records;
    expect(question.checks.valid).toEqual({
      status: "fail",
      detail: "no proposal: The reply called no tool",
      kind: "no proposal",
    });
    expect(question.checks.bundled?.status).toBe("skip");
    expect(question.error).toBeNull();

    expect(failed.checks).toEqual({});
    expect(failed.turnError).toEqual({
      code: "provider_error",
      message: "The assistant could not take that request.",
      providerStatus: 400,
      providerFailures: ["rejected"],
    });
    expect(failed.error).toBe(
      "provider_error: The assistant could not take that request. (provider: rejected, HTTP 400)",
    );
    expect(report.summary.checks.valid).toEqual({ pass: 0, fail: 1, skip: 0 });
    expect(report.summary.checks.grounded).toEqual({ pass: 0, fail: 0, skip: 1 });
    expect(report.summary.errored).toEqual({
      total: 1,
      auth: 0,
      cases: { "process-glue": 1 },
    });
    expect(report.aborted).toBeNull();
    expect(evalExitCode(report)).toBe(0);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain("**Errored turns: 1 of 2**");
    expect(markdown).toContain(
      "| `process-glue` | 0/1 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/1 | - | - | - | - | - | - | - | 0/0 | - | - | - | 0/0 | - | - | - | - | - | - | - | - | - | - | 1 |",
    );
    expect(markdown).toContain(
      "**Run 2** (0 s): errored, not judged: provider_error: The assistant could not take that request. (provider: rejected, HTTP 400)",
    );
  });

  // GRV-99: cases that carry a conversation, expect a question, or name checks of their own.
  it("sends a case's history ahead of its request", async () => {
    const known = EVAL_CASES.find((entry) => entry.id === "pad-genre-known") as EvalCase;
    const provider = createScriptedAssistantProvider([
      replyEvents(["A pad, coming up."]),
    ]);
    await runEvals({ provider, cases: [known], runs: 1, now: fixedNow });
    expect(provider.requests[0].messages).toEqual([
      ...(known.history ?? []).map((message) => ({
        role: message.role,
        content: message.text,
      })),
      { role: "user", content: known.request },
    ]);
  });

  it("passes a case that expects a question only when it asks and proposes nothing", async () => {
    const unknown = EVAL_CASES.find(
      (entry) => entry.id === "pad-genre-unknown",
    ) as EvalCase;
    const project = unknown.fixture();
    const synth = project.song.tracks.find((track) => track.name === "Synth");
    if (!synth) throw new Error("no Synth track");
    const synthDown = setParameter(
      { scope: "track", trackId: synth.id, parameterId: "track.volume" },
      -3,
    );
    const askCall = {
      name: "ask_producer",
      input: {
        question: "What kind of track is this?",
        options: [{ label: "Deep techno" }, { label: "Ambient" }],
      },
    };
    const provider = createScriptedAssistantProvider([
      toolUseEvents("Before I add a pad: what kind of track is this?", [askCall]),
      toolUseEvents("A pad, and the Synth volume down.", [
        { name: toolNameFor(synthDown.type), input: synthDown.payload },
      ]),
    ]);
    const report = await runEvals({ provider, cases: [unknown], runs: 2, now: fixedNow });
    const [asked, proposed] = report.records;
    expect(asked.checks).toEqual({
      outcome: { status: "pass", detail: 'Asked "What kind of track is this?"' },
    });
    expect(proposed.checks.outcome?.status).toBe("fail");
    // A proposal it should not have made is still judged by the shared checks.
    expect(proposed.checks.valid?.status).toBe("pass");
    expect(proposed.checks.inScope?.status).toBe("fail");
    expect(report.summary.checks.outcome).toEqual({ pass: 1, fail: 1, skip: 0 });
  });

  it("judges a case's own checks, and leaves them unjudged when nothing applied", async () => {
    const hats = EVAL_CASES.find((entry) => entry.id === "density-hats") as EvalCase;
    const provider = createScriptedAssistantProvider([
      replyEvents(["Could you select the hi-hat notes first?"]),
    ]);
    const report = await runEvals({ provider, cases: [hats], runs: 1, now: fixedNow });
    const [record] = report.records;
    expect(record.checks.valid?.status).toBe("fail");
    expect(record.checks.outcome).toEqual({ status: "fail", detail: "Proposed nothing" });
    expect(record.checks.hatDensity?.status).toBe("skip");
    expect(record.checks.pointsToGenerate?.status).toBe("skip");
    expect(record.checks.padSound).toBeUndefined();
  });

  it("stops at once and exits 1 when the provider rejects the API key", async () => {
    const provider = createScriptedAssistantProvider([
      [{ fail: "rejected", status: 401 }],
    ]);
    const report = await runEvals({
      provider,
      cases: [glue, crushed],
      runs: 3,
      now: fixedNow,
    });
    expect(provider.requests).toHaveLength(1);
    expect(report.records).toHaveLength(1);
    expect(report.records[0].error).toContain("The provider rejected the API key.");
    expect(report.summary.errored).toMatchObject({ total: 1, auth: 1 });
    expect(report.summary.checks.valid).toEqual({ pass: 0, fail: 0, skip: 0 });
    expect(report.aborted).toBe(AUTH_ABORT_REASON);
    expect(evalExitCode(report)).toBe(1);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain(`**The run stopped early.** ${AUTH_ABORT_REASON}`);
    expect(markdown).toContain("1 of them because the provider rejected the API key");
  });

  it("stops starting turns, even mid-run, once the account is out of API credit", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [compressorCall("a", -18)]),
      [{ fail: "rejected", status: 400, outOfCredit: true }],
    ]);
    const report = await runEvals({
      provider,
      cases: [glue, crushed],
      runs: 3,
      now: fixedNow,
    });
    // The first turn replied; the second ran out of credit, and none came after.
    expect(report.records).toHaveLength(2);
    expect(report.records[0].error).toBeNull();
    expect(report.records[1].turnError?.outOfCredit).toBe(true);
    expect(report.records[1].error).toContain("The account is out of API credit.");
    expect(report.aborted).toBe(CREDIT_ABORT_REASON);
    expect(evalExitCode(report)).toBe(1);
  });

  it("stops starting turns once the provider refuses every call, whatever it said", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [compressorCall("a", -18)]),
      [{ fail: "rejected", status: 400 }],
    ]);
    const report = await runEvals({
      provider,
      cases: [glue, crushed],
      runs: 20,
      now: fixedNow,
    });
    // The first turn replied; the next REFUSAL_STREAK were refused, and none came after.
    expect(report.records).toHaveLength(1 + REFUSAL_STREAK);
    expect(report.aborted).toBe(refusalAbortReason(400));
    expect(evalExitCode(report)).toBe(1);
  });

  it("exits 1 when every turn errored, for any reason", async () => {
    const provider = createScriptedAssistantProvider([
      [{ fail: "rejected", status: 400 }],
    ]);
    const report = await runEvals({ provider, cases: [glue], runs: 2, now: fixedNow });
    expect(report.aborted).toBeNull();
    expect(report.summary.errored.total).toBe(2);
    expect(evalExitCode(report)).toBe(1);
  });

  it("aborts a turn that runs past the timeout and counts it as errored", async () => {
    const provider = createScriptedAssistantProvider([
      [{ hang: true }],
      toolUseEvents("A Compressor on the master.", [compressorCall("a", -18)]),
    ]);
    const report = await runEvals({
      provider,
      cases: [glue],
      runs: 2,
      turnTimeoutMs: 20,
    });
    const [hung, answered] = report.records;
    expect(hung.turnError?.code).toBe("eval_timeout");
    expect(hung.checks).toEqual({});
    expect(answered.checks.valid?.status).toBe("pass");
    expect(report.summary.errored.total).toBe(1);
    expect(provider.aborted).toBe(1);
  });

  it("keeps every other turn when judging one throws", () => {
    const broken: EvalCase = {
      ...glue,
      fixture: () => {
        throw new Error("fixture exploded");
      },
    };
    const turn = {
      durationMs: 1,
      error: null,
      stopReason: null,
      text: "",
      proposal: null,
    };
    const record = evaluateTurnSafely(broken, 1, turn);
    expect(record.turnError?.code).toBe("eval_error");
    expect(record.error).toContain("fixture exploded");
    expect(record.checks).toEqual({});
  });

  it("replays a saved report's proposals against the checks without a model", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [compressorCall("a", -18)]),
    ]);
    const report = await runEvals({ provider, cases: [glue], runs: 1, now: fixedNow });
    const saved = JSON.parse(JSON.stringify(report));
    const replayed = buildReport(evaluateRecords(saved.records, [glue]), [glue], {
      generatedAt: saved.generatedAt,
      model: saved.model,
      runsPerCase: 1,
    });
    expect(replayed.records[0].checks).toEqual(report.records[0].checks);
    expect(replayed.scorecard).toEqual(report.scorecard);
    expect(replayed.scorecard.headline.applies).toEqual({ pass: 1, judged: 1, rate: 1 });
    expect(provider.requests.filter((sent) => !continuesTurn(sent))).toHaveLength(1);
  });

  it("records each turn's token usage and time to first streamed text (GRV-102)", async () => {
    let clock = 1_000;
    const now = () => {
      clock += 10;
      return clock;
    };
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [compressorCall("a", -18)]),
    ]);
    const report = await runEvals({ provider, cases: [glue], runs: 1, now });
    const [record] = report.records;
    expect(record.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(record.firstTextMs).toBeGreaterThan(0);
    expect(record.firstTextMs).toBeLessThan(record.durationMs);
    // The first accepted change call, after the text that led into it (GRV-144).
    expect(record.firstPartMs).toBeGreaterThan(record.firstTextMs ?? 0);
    expect(record.firstPartMs).toBeLessThan(record.durationMs);
    expect(report.scorecard.secondary.firstPartMs?.count).toBe(1);
    expect(report.scorecard.secondary.tokens).toMatchObject({ turns: 1, input: 100 });
    // 100 input at $2/M and 20 output at $10/M on claude-sonnet-5.
    expect(report.scorecard.secondary.costUsd.total).toBeCloseTo(0.0004, 10);
    expect(Object.keys(report).slice(-3)).toEqual(["scorecard", "summary", "records"]);
  });

  it("records the tool bundle a turn opened with, and none under all (GRV-143)", async () => {
    const reply = () =>
      createScriptedAssistantProvider([
        toolUseEvents("A Compressor on the master.", [compressorCall("a", -18)]),
      ]);
    const all = await runEvals({
      provider: reply(),
      cases: [glue],
      runs: 1,
      now: fixedNow,
    });
    expect(all.records[0]?.toolBundle).toBeNull();
    const bundled = await runEvals({
      provider: reply(),
      cases: [glue],
      runs: 1,
      now: fixedNow,
      tactics: { toolBundles: "bundled" },
    });
    // "Add a compressor on the master to glue the mix."
    expect(bundled.records[0]?.toolBundle).toEqual({ bundle: "mix", fallback: null });
  });

  it("runs every turn with the tactics given, and names every value in the report (GRV-110)", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master to glue it.", [compressorCall("t", -18)]),
    ]);
    const report = await runEvals({
      provider,
      cases: [glue],
      runs: 1,
      now: fixedNow,
      tactics: { thinkingEffort: "low" },
    });
    expect(provider.requests.every((sent) => sent.output_config?.effort === "low")).toBe(
      true,
    );
    const resolved = resolveTactics({ thinkingEffort: "low" });
    expect(report.tactics).toEqual(resolved);
    expect(renderMarkdown(report)).toContain(`- Tactics: ${describeTactics(resolved)}`);
    expect(renderSummaryMarkdown(summaryOf(report))).toContain(
      `- Tactics: ${describeTactics(resolved)}`,
    );

    const production = await runEvals({
      provider: createScriptedAssistantProvider([
        toolUseEvents("Glue.", [compressorCall("u", -18)]),
      ]),
      cases: [glue],
      runs: 1,
      now: fixedNow,
    });
    expect(production.tactics).toEqual(TACTIC_DEFAULTS);
  });
});

describe("evaluateTurn for GRV-107's cases", () => {
  const find = (id: string) => EVAL_CASES.find((entry) => entry.id === id) as EvalCase;
  const base = { durationMs: 1, error: null, stopReason: null, text: "" };

  it("hands a db case's commands and expected value to its check", () => {
    const evalCase = find("db-nudge-down");
    const project = evalCase.fixture();
    const track = project.song.tracks[0];
    const expected = evalCase.expectedValue;
    if (!expected) throw new Error("db-nudge-down has no expected value");
    const command = setParameter(
      { scope: "track", trackId: track.id, parameterId: "track.volume" },
      expected.value,
    );
    const proposal = {
      baseRevision: project.metadata.revision,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      calls: [{ name: toolNameFor(command.type), input: command.payload }],
    };
    const record = evaluateTurn(evalCase, 1, { ...base, proposal } as never);
    expect(record.checks.endsAt?.status).toBe("pass");
    expect(record.checks.endsAt?.detail).toContain("BD volume");
  });

  it("passes an either case with a scope-widening question and no proposal", () => {
    const evalCase = find("sketch-track-scope");
    const ask = { question: "Want me to widen the scope to the whole song?" };
    const record = evaluateTurn(evalCase, 1, { ...base, proposal: null, ask } as never);
    expect(record.checks).toEqual({
      outcome: expect.objectContaining({ status: "pass" }),
    });
  });
});

describe("evaluateTurn for the basic production actions (GRV-119)", () => {
  const find = (id: string) => EVAL_CASES.find((entry) => entry.id === id) as EvalCase;
  const base = { durationMs: 1, error: null, stopReason: null, text: "" };

  it("judges the exact edit and nothing else on an applied proposal, in its own set", () => {
    const evalCase = find("basic-mute-hats");
    const project = evalCase.fixture();
    const hats = project.song.tracks.find((track) => track.name === "Hats");
    if (!hats) throw new Error("no Hats track");
    const call = (command: ReturnType<typeof setTrackFlag>) => ({
      name: toolNameFor(command.type),
      input: command.payload,
    });
    const proposal = (calls: ReturnType<typeof call>[]) => ({
      baseRevision: project.metadata.revision,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      calls,
    });
    const muted = evaluateTurn(evalCase, 1, {
      ...base,
      proposal: proposal([call(setTrackFlag(hats.id, "muted", true))]),
    } as never);
    expect(muted.set).toBe("basicActions");
    for (const id of [
      "valid",
      "inScope",
      "exactEdit",
      "nothingElse",
      "outcome",
    ] as const) {
      expect(muted.checks[id]?.status, id).toBe("pass");
    }
    const bass = project.song.tracks.find((track) => track.name === "Bass");
    if (!bass) throw new Error("no Bass track");
    const both = evaluateTurn(evalCase, 1, {
      ...base,
      proposal: proposal([
        call(setTrackFlag(hats.id, "muted", true)),
        call(setTrackFlag(bass.id, "muted", true)),
      ]),
    } as never);
    expect(both.checks.exactEdit?.status).toBe("pass");
    expect(both.checks.nothingElse?.status).toBe("fail");
  });

  it("passes the missing track on an explanation and no proposal", () => {
    const record = evaluateTurn(find("basic-missing-track"), 1, {
      ...base,
      text: "This project has no strings track, so there is nothing to delete.",
      proposal: null,
    } as never);
    expect(record.checks).toEqual({
      outcome: expect.objectContaining({ status: "pass" }),
    });
  });

  it("puts each set in the report's own table", () => {
    const record = evaluateTurn(find("basic-tempo"), 1, {
      ...base,
      proposal: null,
    } as never);
    const report = buildReport([record], [find("basic-tempo")], {
      generatedAt: "2026-10-15T00:00:00Z",
      model: "claude-sonnet-5",
      runsPerCase: 1,
    });
    const markdown = renderSummaryMarkdown(summaryOf(report));
    expect(markdown).toContain("## By set");
    expect(markdown).toContain("| Basic production actions | 1 | 0.0% (0/1) |");
  });
});

describe("evaluateTurn for the project-context cases (GRV-150)", () => {
  const find = (id: string) => EVAL_CASES.find((entry) => entry.id === id) as EvalCase;
  const base = { durationMs: 1, error: null, stopReason: null };

  it("judges the reply of a turn that proposed nothing", () => {
    const evalCase = find("context-cancelled-hat");
    const good = evaluateTurn(evalCase, 1, {
      ...base,
      text: "Nothing is muted: BD and SD are both playing.",
      proposal: null,
    } as never);
    expect(good.checks).toEqual({
      outcome: expect.objectContaining({ status: "pass" }),
      noAbsentTrack: expect.objectContaining({ status: "pass" }),
      noDeniedTrack: expect.objectContaining({ status: "pass" }),
    });
    const bad = evaluateTurn(evalCase, 1, {
      ...base,
      text: "Nothing is muted: BD, SD and the Closed Hat track I just proposed are playing.",
      proposal: null,
    } as never);
    expect(bad.checks.noAbsentTrack?.status).toBe("fail");
    // QA's step 5 history said the snare was never added; repeating it fails too.
    const denied = evaluateTurn(evalCase, 1, {
      ...base,
      text: "Nothing is muted. There's still no snare track, though: I never actually added it.",
      proposal: null,
    } as never);
    expect(denied.checks.noDeniedTrack?.status).toBe("fail");
  });

  it("judges the reply even when the turn proposed nothing it was asked for", () => {
    const record = evaluateTurn(find("context-applied-snare"), 1, {
      ...base,
      text: "There's no snare track in the project yet — I never actually added it.",
      proposal: null,
    } as never);
    expect(record.checks.outcome?.status).toBe("fail");
    expect(record.checks.noDeniedTrack?.status).toBe("fail");
  });
});

// GRV-6's first live run failed check 1 on every proposal that created
// anything. Reproduced here: a device ID counted out by hand one character
// short is refused as a schema failure; the same proposal built from the
// turn's ID stem applies.
describe("check 1 and new IDs", () => {
  function deviceCall(id: string) {
    const device = {
      ...createDevice(id as Parameters<typeof createDevice>[0], "compressor", 0),
      parameters: { threshold: -18 },
    };
    const command = addDevice({ chain: "master" }, device);
    return { name: toolNameFor(command.type), input: command.payload };
  }

  it("fails an ID counted out by hand one character short, and says why", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [
        deviceCall("dev_glue0000000000000001"),
      ]),
    ]);
    // A turn of one call: the browser sees the call as the model made it.
    const report = await runEvals({
      provider,
      cases: [glue],
      runs: 1,
      now: fixedNow,
      maxSteps: 1,
    });
    const [record] = report.records;
    expect(record.checks.valid?.kind).toBe("schema");
    expect(validFailureLine(record)).toMatch(
      /^schema: invalid_payload \(call 0\): device\.id: Expected a "dev_" prefixed id/,
    );
  });

  it("passes the same proposal with an ID made from the turn's stem", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [
        deviceCall(newId("dev", createIdStem(), 1)),
      ]),
    ]);
    const report = await runEvals({ provider, cases: [glue], runs: 1, now: fixedNow });
    expect(report.records[0].checks.valid?.status).toBe("pass");
    expect(validFailureLine(report.records[0])).toBeNull();
  });

  it("fails tool input cut short as a schema failure, not an errored turn", async () => {
    const events = toolUseEvents("A Compressor on the master.", [
      compressorCall("a", -18),
    ]);
    const truncated = events.filter(
      (step, index) =>
        !(
          "event" in step &&
          (step.event as { delta?: { type?: string } }).delta?.type ===
            "input_json_delta" &&
          (events[index - 1] as { event: { type: string } }).event.type ===
            "content_block_delta"
        ),
    );
    const provider = createScriptedAssistantProvider([truncated]);
    const report = await runEvals({
      provider,
      cases: [glue],
      runs: 1,
      now: fixedNow,
      maxSteps: 1,
    });
    const [record] = report.records;
    expect(record.error).toBeNull();
    expect(record.checks.valid?.kind).toBe("schema");
  });

  it("records a call refused back to the model mid-turn, and the calls the turn took", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [
        deviceCall("dev_glue0000000000000001"),
      ]),
    ]);
    const report = await runEvals({ provider, cases: [glue], runs: 1, now: fixedNow });
    const [record] = report.records;
    expect(record.steps?.calls).toBe(2);
    expect(record.steps?.refused).toEqual([
      {
        name: "device_add",
        reason: expect.stringContaining('device.id: Expected a "dev_" prefixed id'),
      },
    ]);
    // The model ended without resending it, so nothing was proposed.
    expect(record.checks.valid?.kind).toBe("no proposal");
  });

  it("records where a turn's output tokens went and prints them", async () => {
    const provider = createScriptedAssistantProvider([
      replyEvents(["Nothing to do."], {
        stopReason: "max_tokens",
        outputTokens: 16_000,
        withThinking: true,
      }),
    ]);
    const report = await runEvals({ provider, cases: [glue], runs: 1, now: fixedNow });
    const [record] = report.records;
    expect(record.tokens).toEqual({
      outputTokens: 16_000,
      thinkingChars: "private reasoning".length,
      toolInputChars: 0,
      textChars: "Nothing to do.".length,
    });
    expect(renderMarkdown(report)).toContain(
      `Output tokens 16000; input 100, cache read 0; streamed characters: thinking ${"private reasoning".length}, tool input 0, text ${"Nothing to do.".length}`,
    );
  });

  it.each([
    [{ stopReason: "max_tokens" }, "cut off at max_tokens"],
    [{ stopReason: "refusal" }, "The model refused"],
    [{ stopReason: "end_turn" }, "The reply called no tool"],
  ] as const)("says why a reply proposed nothing (%o)", (turn, reason) => {
    expect(
      whyNoProposal({ ...turn, durationMs: 0, error: null, text: "", proposal: null }),
    ).toContain(reason);
  });

  it("says when the reply asked the producer instead", () => {
    const why = whyNoProposal({
      durationMs: 0,
      error: null,
      stopReason: "tool_use",
      text: "",
      proposal: null,
      ask: { id: "toolu_1", question: "Which part?", options: [] } as never,
    });
    expect(why).toBe('It asked the producer instead: "Which part?"');
  });
});

describe("renderMarkdown", () => {
  it("names the model and prompt version and gives the pass rate per check", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [compressorCall("a", -18)]),
      replyEvents(["No."]),
    ]);
    const report = await runEvals({
      provider,
      cases: [glue, crushed],
      runs: 1,
      now: fixedNow,
    });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("Model: `claude-sonnet-5`");
    expect(markdown).toContain(`Prompt version: \`${ASSISTANT_PROMPT_VERSION}\``);
    expect(markdown).toContain("| 1. Valid | 1/2 (50%) |");
    expect(markdown).toContain(
      "| 6. Extreme is not flattened | 0/0 (n/a, 1 not judged) |",
    );
    expect(markdown).toContain("1. Valid failed: no proposal: The reply called no tool");
    expect(markdown).toContain("## Why check 1 failed");
    expect(markdown).toContain("| `process-crushed` | 1 | 0 | 0 | 0 |");
    expect(markdown).toContain(
      "- `process-crushed`, 1 of 1: no proposal: The reply called no tool",
    );
  });

  it("leaves the check 1 section out when nothing failed it", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [compressorCall("a", -18)]),
    ]);
    const report = await runEvals({ provider, cases: [glue], runs: 1, now: fixedNow });
    expect(renderMarkdown(report)).not.toContain("## Why check 1 failed");
  });

  it("leads with the scorecard and keeps the summary to numbers (GRV-102)", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A Compressor on the master.", [compressorCall("a", -18)]),
      replyEvents(["No."]),
    ]);
    const report = await runEvals({
      provider,
      cases: [glue, crushed],
      runs: 1,
      now: fixedNow,
    });
    const markdown = renderMarkdown(report);
    const headline = markdown.indexOf("## Headline");
    expect(headline).toBeGreaterThan(-1);
    expect(headline).toBeLessThan(markdown.indexOf("## Pass rate per check"));
    expect(markdown).toContain("| Applies cleanly (check 1) | 50.0% (1/2) |");
    expect(markdown).toContain("| Expected outcome (check 8) |");
    expect(markdown).toContain("## Cost by case");
    expect(markdown).not.toContain("## Against the baseline");

    const summary = renderSummaryMarkdown(summaryOf(report));
    expect(summary).toContain("## Headline");
    expect(summary).toContain("## By case");
    expect(summary).not.toContain("## Runs");
    expect(summary).not.toContain("Said:");
    expect(summary).not.toContain("A Compressor on the master");
    expect(summaryOf(report)).not.toHaveProperty("records");
  });

  it("formats a tally over the proposals a check could judge", () => {
    expect(formatTally({ pass: 2, fail: 1, skip: 0 })).toBe("2/3 (67%)");
    expect(formatTally(undefined)).toBe("n/a");
  });
});

describe("the sound-pick cases (GRV-129)", () => {
  const find = (id: string) => EVAL_CASES.find((entry) => entry.id === id) as EvalCase;
  const base = { durationMs: 1, error: null, stopReason: null, text: "" };
  const KIT = "trk_EvalSnareHat000000001";
  const SNARE = "pad_EvalSnare000000000001";
  const HAT = "pad_EvalHat00000000000001";
  const pad = (id: string, name: string) => ({
    id,
    name,
    assetId: null,
    chokeGroup: null,
    parameters: {},
    mixer: { volume: 0, pan: 0, muted: false, soloed: false },
  });
  const createKit = {
    name: "track_create",
    input: {
      id: KIT,
      name: "Snare & Hat",
      color: "#808080",
      order: 1,
      type: "instrument",
      instrument: {
        kind: "drumMachine",
        parameters: {},
        pads: [pad(SNARE, "Snare"), pad(HAT, "Hat")],
      },
      devices: [],
      sendConfig: [],
      mixer: { volume: 0, pan: 0, muted: false, soloed: false },
    },
  };
  const recommend = (soundId: string, trackId: string, padId: string) => ({
    name: "recommend_sounds",
    input: {
      packId: "pak_SdlN_OazweXrwury0j27Y",
      soundIds: [soundId],
      reason: "Fits.",
      trackId,
      padId,
    },
  });

  it("sends the library with a case that asks for it, and not with one that does not", async () => {
    const provider = createScriptedAssistantProvider([
      replyEvents(["Sure."]),
      replyEvents(["Sure."]),
    ]);
    await runEvals({
      provider,
      cases: [find("snare-hats-sounds"), glue],
      runs: 1,
      now: fixedNow,
    });
    const offered = provider.requests.map((request) =>
      request.tools.some((tool) => tool.name === "recommend_sounds"),
    );
    expect(offered).toEqual([true, false]);
  });

  it("judges the changes without the recommendations, and each sound on its own pad", () => {
    const evalCase = find("snare-hats-sounds");
    const project = evalCase.fixture();
    const bd = project.song.tracks[0];
    const kick = bd?.instrument?.kind === "drumMachine" ? bd.instrument.pads[0] : null;
    if (!bd || !kick) throw new Error("the starter fixture has no BD pad");
    const proposal = {
      baseRevision: project.metadata.revision,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      calls: [
        createKit,
        recommend("sg-one-shot-drums-kick-0002", bd.id, kick.id),
        recommend("sg-one-shot-drums-snare-0001", KIT, SNARE),
        recommend("sg-one-shot-drums-closed-hat-0001", KIT, HAT),
      ],
    };
    const record = evaluateTurn(evalCase, 1, { ...base, proposal } as never);
    expect(record.checks.valid?.status).toBe("pass");
    expect(record.checks.recommendationTargets?.status).toBe("pass");
  });

  it("fails a snare and a hat both aimed at BD's pad, as the panel used to land them", () => {
    const evalCase = find("first-beat-lesson");
    const project = evalCase.fixture();
    const bd = project.song.tracks[0];
    const kick = bd?.instrument?.kind === "drumMachine" ? bd.instrument.pads[0] : null;
    if (!bd || !kick) throw new Error("the starter fixture has no BD pad");
    const proposal = {
      baseRevision: project.metadata.revision,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      calls: [
        createKit,
        recommend("sg-one-shot-drums-snare-0001", bd.id, kick.id),
        recommend("sg-one-shot-drums-closed-hat-0001", bd.id, kick.id),
      ],
    };
    const record = evaluateTurn(evalCase, 1, { ...base, proposal } as never);
    expect(record.checks.recommendationTargets).toEqual({
      status: "fail",
      detail: expect.stringMatching(/hat and the snare are both aimed at/),
    });
  });
});

describe("the takes cases (GRV-207)", () => {
  const find = (id: string) => EVAL_CASES.find((entry) => entry.id === id) as EvalCase;
  const base = { durationMs: 1, error: null, stopReason: null, text: "" };
  const offered = (evalCase: EvalCase) => {
    const project = evalCase.fixture();
    const written = expandTakesCall(
      { id: "toolu_takes", ...offerTakesCall(project) },
      "Stem0000000000000",
    );
    if (!written.ok) throw new Error(written.message);
    return {
      baseRevision: project.metadata.revision,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      calls: [written.call],
    };
  };

  it("judges a melodic request's offer by check 29, and its first take by the proposal checks", () => {
    const evalCase = find("takes-melody");
    const record = evaluateTurn(evalCase, 1, {
      ...base,
      proposal: offered(evalCase),
    } as never);
    expect(record.checks.valid?.status).toBe("pass");
    expect(record.checks.inScope?.status).toBe("pass");
    expect(record.checks.offersTakes?.status).toBe("pass");
  });

  it("fails check 30 on a drums request that got takes", () => {
    const evalCase = find("takes-drums");
    const record = evaluateTurn(evalCase, 1, {
      ...base,
      proposal: offered(evalCase),
    } as never);
    expect(record.checks.noTakes?.status).toBe("fail");
  });
});
