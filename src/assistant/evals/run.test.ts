import { describe, expect, it } from "vitest";
import { addDevice, setParameter } from "../../commands";
import { createDevice } from "../../domain/devices";
import { createFactoryContext } from "../../domain/factories";
import { createSeededIdFactory } from "../../domain/ids";
import {
  createScriptedAssistantProvider,
  replyEvents,
  toolUseEvents,
} from "../../testing/scriptedAssistantProvider";
import {
  ASSISTANT_PROMPT_VERSION,
  ASSISTANT_SYSTEM_PROMPT,
  createIdStem,
  newId,
} from "../prompt";
import { continuesTurn } from "../providerRequest";
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
  AUTH_ABORT_REASON,
  buildReport,
  evalExitCode,
  evaluateRecords,
  evaluateTurn,
  evaluateTurnSafely,
  runEvals,
  summaryOf,
  whyNoProposal,
} from "./run";

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
    expect(provider.requests[0].system[0].text).toBe(ASSISTANT_SYSTEM_PROMPT);
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
      "| `process-glue` | 0/1 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/1 | - | - | - | - | - | - | - | - | - | 1 |",
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
    expect(report.scorecard.secondary.tokens).toMatchObject({ turns: 1, input: 100 });
    // 100 input at $2/M and 20 output at $10/M on claude-sonnet-5.
    expect(report.scorecard.secondary.costUsd.total).toBeCloseTo(0.0004, 10);
    expect(Object.keys(report).slice(-3)).toEqual(["scorecard", "summary", "records"]);
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
