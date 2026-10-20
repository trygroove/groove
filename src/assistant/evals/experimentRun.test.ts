/**
 * The experiment framework's dry runs (GRV-110): a scripted provider and
 * planted tactics, through the gateway's own turn, the verdict, the gate, the
 * cuts and the PR plan, with a recorder in place of the comment poster and
 * the PR opener so nothing is posted or opened. Every pool has at least three
 * train and three held-out cases, the fewest an interval is read from.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { addDevice } from "../../commands";
import { createDevice } from "../../domain/devices";
import { createFactoryContext } from "../../domain/factories";
import { createSeededIdFactory } from "../../domain/ids";
import {
  createScriptedAssistantProvider,
  replyEvents,
  toolUseEvents,
} from "../../testing/scriptedAssistantProvider";
import { ASSISTANT_PROMPT_VERSION } from "../prompt";
import type { AssistantProvider } from "../provider";
import { continuesTurn } from "../providerRequest";
import {
  TACTIC_DEFAULTS,
  TACTICS,
  type TacticDefinition,
  type TacticOverrides,
} from "../tactics";
import { ASSISTANT_TOOLSET_VERSION, toolNameFor } from "../tools";
import { casePairs } from "./cases";
import { experimentIds, loadExperiment, validateExperiment } from "./experiment";
import {
  concludeExperiment,
  type ExperimentPublisher,
  PROMPT_PATH,
  planWinPullRequest,
  TACTICS_PATH,
  TOOLS_PATH,
  type WinPullRequest,
} from "./experimentPr";
import { renderExperimentMarkdown } from "./experimentReport";
import {
  BUDGET_STOP_REASON,
  COMBINED_CUT_RETRIES,
  type ExperimentTurnRunner,
  experimentExitCode,
  gatewayTurnRunner,
  judgedOnGuardrailsAlone,
  runExperiment,
} from "./experimentRun";
import { runCaseTurn } from "./run";
import { AUTH_ABORT_REASON, REFUSAL_STREAK, refusalAbortReason } from "./runGuard";

/** Tactics no production code knows: the scripted model is what reads them. */
const off = (description: string, alters: TacticDefinition["alters"]) => ({
  description,
  values: ["off", "on"],
  default: "off",
  alters,
});
const PLANTED: Readonly<Record<string, TacticDefinition>> = {
  terseNotes: off("Planted: the same proposal in fewer output tokens.", ["prompt"]),
  noop: off("Planted: changes nothing at all.", ["request"]),
  skipTools: off("Planted: answers in words and calls no tool, so check 1 fails.", [
    "tools",
  ]),
  trimNothing: off("Planted cut: removes something that changes nothing.", ["prompt"]),
  trimBreaks: off("Planted cut: removes something check 1 needs.", ["prompt"]),
  trimA: off("Planted cut: 1% more tokens alone; with another cut, no tool call.", [
    "prompt",
  ]),
  trimB: off("Planted cut: 1% fewer tokens alone; with another cut, no tool call.", [
    "prompt",
  ]),
  trimC: off("Planted cut: 0.5% more tokens alone; with another cut, no tool call.", [
    "prompt",
  ]),
  trimD: off("Planted cut: 0.5% fewer tokens alone; with another cut, no tool call.", [
    "prompt",
  ]),
};

/** The cuts that clash: any two of them on together, and the reply calls no tool. */
const CLASHING: Readonly<Record<string, number>> = {
  trimA: 1_010,
  trimB: 990,
  trimC: 1_005,
  trimD: 995,
};

/** A registry source the win PR rewrites, as `tactics.ts` lays its entries out. */
const PLANTED_SOURCE = `export const TACTICS = {
${Object.entries(PLANTED)
  .map(
    ([id, tactic]) => `  ${id}: {
    description: "Planted.",
    values: ["off", "on"],
    default: "off",
    alters: ${JSON.stringify(tactic.alters)},
  },`,
  )
  .join("\n")}
} as const;
`;

const PROMPT_SOURCE = `export const ASSISTANT_PROMPT_VERSION = "2026-10-17.2";\n`;

/** Train: four musical cases. Held out: three. */
const POOL = [
  "process-crushed",
  "balance-clean",
  "density-hats",
  "variation-mangled",
  "process-glue",
  "balance-lopsided",
  "variation-fill",
];

/** 2026-10-18 15:55:20 UTC, the run's clock. */
const NOW = Date.UTC(2026, 9, 18, 15, 55, 20);
const fixedNow = () => NOW;

function compressorCall(seed: string) {
  const device = {
    ...createDevice(
      createFactoryContext({ ids: createSeededIdFactory(seed) }).ids("device"),
      "compressor",
      0,
    ),
    parameters: { threshold: -18, ratio: 2 },
  };
  const command = addDevice({ chain: "master" }, device);
  return { name: toolNameFor(command.type), input: command.payload };
}

/** A few tokens' difference from case to case, so no interval is a single point. */
function caseWobble(caseId: string): number {
  return (caseId.length % 3) * 20;
}

/** The turn's script: a compressor on the master, in fewer tokens when terse. */
function plantedScript(tactics: Readonly<Record<string, string>>, caseId: string) {
  const clashing = Object.keys(CLASHING).filter((id) => tactics[id] === "on");
  if (tactics.skipTools === "on" || tactics.trimBreaks === "on" || clashing.length > 1) {
    return replyEvents(["I would put a compressor on the master."], {
      outputTokens: 300,
    });
  }
  const outputTokens =
    tactics.terseNotes === "on"
      ? 600 + caseWobble(caseId)
      : clashing.length === 1
        ? CLASHING[clashing[0]]
        : 1_000;
  return toolUseEvents("A Compressor on the master to glue it.", [compressorCall("c")], {
    outputTokens,
  });
}

/** Each turn through the gateway's own turn, its model scripted from the planted values. */
function plantedTurns(calls: string[] = []): ExperimentTurnRunner {
  return (evalCase, tactics) => {
    calls.push(`${evalCase.id} ${JSON.stringify(tactics)}`);
    return runCaseTurn(evalCase, {
      provider: createScriptedAssistantProvider([plantedScript(tactics, evalCase.id)]),
    });
  };
}

function planted(variants: Readonly<Record<string, unknown>>, caseIds = POOL) {
  return validateExperiment(
    {
      id: "planted",
      card: "GRV-110",
      hypothesis: "A planted tactic does what it was planted to do.",
      variants,
      goal: "outputTokens",
      cases: { caseIds },
    },
    { tactics: PLANTED },
  );
}

const cut = (tactics: Readonly<Record<string, string>>) => ({ kind: "cut", tactics });

/** Records what would have been posted and opened. */
function recorder(options: { failPullRequest?: string } = {}) {
  const comments: { card: string; body: string }[] = [];
  const pulls: WinPullRequest[] = [];
  const moves: { card: string; state: string }[] = [];
  const publisher: ExperimentPublisher = {
    postComment: async (card, body) => {
      comments.push({ card, body });
      return "https://linear.app/comment";
    },
    openPullRequest: async (plan) => {
      if (options.failPullRequest) throw new Error(options.failPullRequest);
      pulls.push(plan);
      return "https://github.com/trygroove/groove/pull/1";
    },
    moveCard: async (card, state) => {
      moves.push({ card, state });
    },
  };
  return { comments, moves, pulls, publisher };
}

const LINKS = {
  runUrl: "https://github.com/trygroove/groove/actions/runs/1",
  commit: "abc123",
};

function planOptions(sources: Record<string, string>, tactics = PLANTED) {
  return {
    readFile: (path: string) => {
      const source = sources[path];
      if (source === undefined) throw new Error(`no ${path} in the test`);
      return source;
    },
    tactics,
    links: LINKS,
    day: "2026-10-18",
  };
}

const SOURCES = { [TACTICS_PATH]: PLANTED_SOURCE, [PROMPT_PATH]: PROMPT_SOURCE };

/** `PLANTED_SOURCE` with these tactics' defaults turned on. */
function turnedOn(...ids: string[]): string {
  return ids.reduce(
    (source, id) =>
      source.replace(
        new RegExp(`(  ${id}: \\{\\n[^}]*?default: )"off"`),
        (_, head) => `${head}"on"`,
      ),
    PLANTED_SOURCE,
  );
}

describe("an experiment's dry run (GRV-110)", () => {
  it("wins with a tactic that lowers output tokens and leaves quality alone, and opens one held PR", async () => {
    const result = await runExperiment(planted({ terse: { terseNotes: "on" } }), {
      runTurn: plantedTurns(),
      now: fixedNow,
    });

    expect(result.trainAnalyses).toHaveLength(1);
    const [train] = result.trainAnalyses;
    expect(train.goal.control).toBe(1_000);
    expect(train.goal.pairedCases).toBe(4);
    expect(train.goal.change).toBeLessThan(-300);
    expect(train.goal.outcome).toBe("better");
    expect(train.guardrails.every((guardrail) => guardrail.pass)).toBe(true);
    expect(train.verdict).toBe("win");
    // The gate: the control and the winner on the held-out cases, 5 runs each.
    expect(result.gates).toHaveLength(1);
    expect(result.gates[0].phase.caseIds).toEqual([
      "process-glue",
      "balance-lopsided",
      "variation-fill",
    ]);
    expect(result.gates[0].phase.runsPerCase).toBe(5);
    expect(result.gates[0].phase.label).toBe("gate-terse");
    expect(result.gates[0].phase.reports.terse.records).toHaveLength(15);
    expect(result.gates[0].analysis.verdict).toBe("win");
    expect(result.verdict).toBe("win");
    expect(result.winner).toEqual({
      name: "terse",
      overrides: { terseNotes: "on" },
      kind: "improve",
    });
    expect(result.cuts).toEqual([]);
    expect(result.spentUsd).toBeGreaterThan(0);
    expect(experimentExitCode(result)).toBe(0);

    const { comments, moves, pulls, publisher } = recorder();
    const concluded = await concludeExperiment(result, publisher, planOptions(SOURCES));
    expect(pulls).toHaveLength(1);
    const [pull] = pulls;
    expect(pull.labels).toEqual(["hold"]);
    // One branch per run, from the run's own clock.
    expect(pull.branch).toBe("claude/grv-110-experiment-planted-20261018-155520");
    expect(pull.title).toBe(
      "Implement GRV-110: Default to terseNotes=on (experiment planted)",
    );
    // Its merge puts the card in QA, so production is tested on the new defaults.
    expect(pull.body).toContain("Completes GRV-110");
    // The card waits on the held PR.
    expect(moves).toEqual([{ card: "GRV-110", state: "Ready For Review" }]);
    expect(pull.files.map((file) => file.path)).toEqual([
      TACTICS_PATH,
      PROMPT_PATH,
      "docs/experiments/planted.md",
    ]);
    // Only the winning tactic's default moved; the prompt it alters is a new version.
    expect(pull.files[0].content).toBe(turnedOn("terseNotes"));
    expect(pull.files[1].content).toBe(
      `export const ASSISTANT_PROMPT_VERSION = "2026-10-18.1";\n`,
    );
    expect(pull.files[2].content).toBe(renderExperimentMarkdown(result, LINKS));
    // The comment goes on the card, after the PR, and links it.
    expect(comments).toEqual([{ card: "GRV-110", body: concluded.markdown }]);
    expect(concluded.pullRequestError).toBeNull();
    expect(concluded.markdown).toMatch(/^# Experiment `planted`: win/);
    expect(concluded.markdown).toContain(
      "- Held PR with the new defaults: https://github.com/trygroove/groove/pull/1",
    );
    expect(concluded.markdown).toContain(`run: ${LINKS.runUrl}`);
    expect(concluded.markdown).toContain("- Winner: `terse` (terseNotes=on)");
    expect(concluded.markdown).toContain("| Number | Variant | Control | Delta | |");
    expect(concluded.markdown).toContain(
      "4 train cases (`process-crushed`, `balance-clean`, `density-hats`, `variation-mangled`), 3 runs a case, 24 turns.",
    );
  });

  it("is inconclusive on fewer than three paired cases, however clear the change", async () => {
    const result = await runExperiment(
      planted({ terse: { terseNotes: "on" } }, ["process-crushed", "process-glue"]),
      { runTurn: plantedTurns() },
    );
    expect(result.trainAnalyses[0].goal.change).toBeLessThan(0);
    expect(result.trainAnalyses[0].verdict).toBe("inconclusive");
    expect(result.trainAnalyses[0].why).toMatch(/Only 1 case ran on both sides/);
    expect(result.verdict).toBe("inconclusive");
    expect(result.gates).toEqual([]);
  });

  it("gives no win or inconclusive for a planted no-op, and opens nothing", async () => {
    const result = await runExperiment(planted({ same: { noop: "on" } }), {
      runTurn: plantedTurns(),
    });
    expect(["no win", "inconclusive"]).toContain(result.verdict);
    expect(result.trainAnalyses[0].goal.change).toBe(0);
    expect(result.gates).toEqual([]);
    expect(result.winner).toBeNull();
    const { comments, moves, pulls, publisher } = recorder();
    const concluded = await concludeExperiment(result, publisher, planOptions({}));
    expect(pulls).toEqual([]);
    expect(moves).toEqual([{ card: "GRV-110", state: concluded.cardState }]);
    expect(concluded.cardState).toBe(result.verdict === "no win" ? "Done" : "Blocked");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Not run: no variant won on train.");
  });

  it("refuses by a guardrail a planted tactic that breaks check 1, however few tokens it writes", async () => {
    const result = await runExperiment(planted({ "words-only": { skipTools: "on" } }), {
      runTurn: plantedTurns(),
    });
    const [analysis] = result.trainAnalyses;
    expect(analysis.goal.outcome).toBe("better");
    expect(analysis.verdict).toBe("no win");
    expect(
      analysis.guardrails.find((guardrail) => guardrail.id === "applies"),
    ).toMatchObject({
      pass: false,
      detail: "Musical capability 100.0% to 0.0% (too far)",
    });
    expect(analysis.why).toMatch(/^Refused by/);
    expect(result.verdict).toBe("no win");
    const { pulls, publisher } = recorder();
    await concludeExperiment(result, publisher, planOptions({}));
    expect(pulls).toEqual([]);
  });

  it("posts the report even when the win's PR fails to open, and says why", async () => {
    const result = await runExperiment(planted({ terse: { terseNotes: "on" } }), {
      runTurn: plantedTurns(),
    });
    const { comments, moves, publisher } = recorder({
      failPullRequest: "Command failed: gh pr create\nHTTP 403",
    });
    const concluded = await concludeExperiment(result, publisher, planOptions(SOURCES));
    expect(concluded.pullRequestUrl).toBeNull();
    // A win with no PR to wait on needs the product owner.
    expect(moves).toEqual([{ card: "GRV-110", state: "Blocked" }]);
    expect(concluded.pullRequestError).toBe("Command failed: gh pr create HTTP 403");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(
      "- **The held PR did not open:** Command failed: gh pr create HTTP 403",
    );
  });

  it("turns a turn runner that throws into an errored record, not a failed run", async () => {
    const result = await runExperiment(planted({ terse: { terseNotes: "on" } }), {
      runTurn: async () => {
        throw new Error("fixture exploded");
      },
    });
    const records = result.train.reports.control.records;
    expect(records).toHaveLength(12);
    expect(records.every((record) => record.error?.includes("fixture exploded"))).toBe(
      true,
    );
    expect(experimentExitCode(result)).toBe(1);
  });

  it("runs the real thinkingEffort tactic through the gateway, and its win flips the registry's default", async () => {
    // Read off the registry, so this holds whichever effort production uses.
    const DEFAULT = TACTIC_DEFAULTS.thinkingEffort;
    const OFF = TACTICS.thinkingEffort.values.find(
      (value) => value !== DEFAULT,
    ) as string;
    // The scripted model writes less when the request asks for the other effort.
    const provider: AssistantProvider = {
      stream(request, signal) {
        const script = continuesTurn(request)
          ? []
          : toolUseEvents("A Compressor on the master.", [compressorCall("e")], {
              outputTokens: request.output_config?.effort === OFF ? 500 : 900,
            });
        return createScriptedAssistantProvider([script]).stream(request, signal);
      },
    };
    const experiment = validateExperiment({
      id: "effort-off",
      card: "GRV-110",
      hypothesis: "Another effort writes fewer tokens.",
      variants: { other: { thinkingEffort: OFF } },
      goal: "outputTokens",
      cases: { caseIds: POOL },
    });
    const result = await runExperiment(experiment, {
      runTurn: gatewayTurnRunner({
        provider,
        model: (await import("../config")).ASSISTANT_MODELS["claude-sonnet-5"],
      }),
    });
    expect(result.verdict).toBe("win");
    expect(result.train.reports.other.tactics?.thinkingEffort).toBe(OFF);
    expect(result.train.reports.control.tactics?.thinkingEffort).toBe(DEFAULT);

    const before = readFileSync(TACTICS_PATH, "utf8");
    const plan = planWinPullRequest(
      result,
      planOptions({ [TACTICS_PATH]: before }, TACTICS),
    );
    if (!plan) throw new Error("expected a win's PR");
    // thinkingEffort alters the request alone: no version moves.
    expect(plan.files.map((file) => file.path)).toEqual([
      TACTICS_PATH,
      "docs/experiments/effort-off.md",
    ]);
    expect(plan.files[0].content).toBe(
      before.replace(`    default: "${DEFAULT}",`, `    default: "${OFF}",`),
    );

    // Apply the PR's registry in a scratch copy: it still loads, its default
    // is the winner's, and every experiment file still validates against it,
    // GRV-110's own included, now with its variant production's default.
    mkdirSync(resolve("tmp"), { recursive: true });
    const dir = mkdtempSync(join(resolve("tmp"), "win-pr-"));
    try {
      writeFileSync(join(dir, "tactics.ts"), plan.files[0].content);
      const flipped = (await import(/* @vite-ignore */ join(dir, "tactics.ts"))) as {
        TACTICS: Readonly<Record<string, TacticDefinition>>;
        TACTIC_DEFAULTS: TacticOverrides;
      };
      expect(flipped.TACTIC_DEFAULTS.thinkingEffort).toBe(OFF);
      for (const tactic of Object.values(flipped.TACTICS)) {
        expect(tactic.values).toContain(tactic.default);
      }
      for (const id of experimentIds()) {
        await expect(
          loadExperiment(id, undefined, { tactics: flipped.TACTICS }),
        ).resolves.toMatchObject({ id });
      }
      const own = validateExperiment(
        { ...(await import("../../../evals/experiments/thinking-effort-low")).default },
        { tactics: flipped.TACTICS },
      );
      if (OFF === "low") expect(own.atDefaults).toEqual(["low"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the real drumStepStrings tactic, and its win bumps the prompt and tool set versions it alters", async () => {
    const DEFAULT = TACTIC_DEFAULTS.drumStepStrings;
    const OTHER = TACTICS.drumStepStrings.values.find(
      (value) => value !== DEFAULT,
    ) as string;
    // The scripted model writes less when clip_create offers step strings.
    const offersSteps = (request: Parameters<AssistantProvider["stream"]>[0]) =>
      request.tools.some(
        (tool) => tool.name === "clip_create" && tool.description.includes("step string"),
      );
    const provider: AssistantProvider = {
      stream(request, signal) {
        const steps = offersSteps(request) === (OTHER === "on");
        const script = continuesTurn(request)
          ? []
          : toolUseEvents("A Compressor on the master.", [compressorCall("d")], {
              outputTokens: steps ? 500 : 900,
            });
        return createScriptedAssistantProvider([script]).stream(request, signal);
      },
    };
    const experiment = validateExperiment({
      id: "steps-flip",
      card: "GRV-140",
      hypothesis: "The other step-string setting writes fewer tokens.",
      variants: { other: { drumStepStrings: OTHER } },
      goal: "outputTokens",
      cases: { caseIds: POOL },
    });
    const result = await runExperiment(experiment, {
      runTurn: gatewayTurnRunner({
        provider,
        model: (await import("../config")).ASSISTANT_MODELS["claude-sonnet-5"],
      }),
    });
    expect(result.verdict).toBe("win");

    const sources: Record<string, string> = {
      [TACTICS_PATH]: readFileSync(TACTICS_PATH, "utf8"),
      [PROMPT_PATH]: readFileSync(PROMPT_PATH, "utf8"),
      [TOOLS_PATH]: readFileSync(TOOLS_PATH, "utf8"),
    };
    const plan = planWinPullRequest(result, planOptions(sources, TACTICS));
    if (!plan) throw new Error("expected a win's PR");
    // drumStepStrings alters the prompt, the tools and their expansion: both versions move.
    expect(plan.files.map((file) => file.path)).toEqual([
      TACTICS_PATH,
      PROMPT_PATH,
      TOOLS_PATH,
      "docs/experiments/steps-flip.md",
    ]);
    const changed = (path: string) => {
      const before = sources[path].split("\n");
      const after = (plan.files.find((file) => file.path === path)?.content ?? "").split(
        "\n",
      );
      expect(after).toHaveLength(before.length);
      return after.flatMap((line, index) =>
        line === before[index] ? [] : [[before[index], line]],
      );
    };
    expect(changed(TACTICS_PATH)).toEqual([
      [`    default: "${DEFAULT}",`, `    default: "${OTHER}",`],
    ]);
    expect(changed(PROMPT_PATH)).toEqual([
      [
        `export const ASSISTANT_PROMPT_VERSION = "${ASSISTANT_PROMPT_VERSION}";`,
        expect.stringMatching(
          /^export const ASSISTANT_PROMPT_VERSION = "2026-10-18\.\d+";$/,
        ),
      ],
    ]);
    expect(changed(TOOLS_PATH)).toEqual([
      [
        `export const ASSISTANT_TOOLSET_VERSION = ${ASSISTANT_TOOLSET_VERSION};`,
        `export const ASSISTANT_TOOLSET_VERSION = ${ASSISTANT_TOOLSET_VERSION + 1};`,
      ],
    ]);
    expect(plan.body).toContain(
      "bumps `ASSISTANT_PROMPT_VERSION` and `ASSISTANT_TOOLSET_VERSION` because the tactic alters them",
    );
  });

  it("interleaves the variants case by case and run by run", async () => {
    const calls: string[] = [];
    await runExperiment(
      { ...planted({ terse: { terseNotes: "on" } }), runs: 2 },
      { runTurn: plantedTurns(calls), concurrency: 1, gateRuns: 1 },
    );
    expect(calls.slice(0, 8)).toEqual([
      "process-crushed {}",
      'process-crushed {"terseNotes":"on"}',
      "process-crushed {}",
      'process-crushed {"terseNotes":"on"}',
      "balance-clean {}",
      'balance-clean {"terseNotes":"on"}',
      "balance-clean {}",
      'balance-clean {"terseNotes":"on"}',
    ]);
  });

  it("stops at the budget, reports what it has, and calls it inconclusive", async () => {
    const calls: string[] = [];
    const result = await runExperiment(planted({ terse: { terseNotes: "on" } }), {
      runTurn: plantedTurns(calls),
      // One turn costs about a cent ($2/M input, $10/M output on 100 in, 1,000 out).
      budgetUsd: 0.025,
      concurrency: 1,
    });
    expect(result.stopped).toBe(BUDGET_STOP_REASON);
    expect(calls.length).toBeLessThan(6);
    expect(result.spentUsd).toBeLessThanOrEqual(0.025);
    expect(result.verdict).toBe("inconclusive");
    expect(result.reason).toBe(`Unfinished: ${BUDGET_STOP_REASON}`);
    expect(result.gates).toEqual([]);
    expect(experimentExitCode(result)).toBe(0);
    expect(renderExperimentMarkdown(result, LINKS)).toContain("**Unfinished.**");
  });

  it("stops at once when the provider refuses the key, and exits 1", async () => {
    const calls: string[] = [];
    const refused: ExperimentTurnRunner = async (evalCase) => {
      calls.push(evalCase.id);
      return {
        durationMs: 0,
        error: "provider_error: refused",
        turnError: {
          code: "provider_error",
          message: "refused",
          providerStatus: 401,
          providerFailures: ["rejected"],
        },
        stopReason: null,
        text: "",
        proposal: null,
        usage: null,
      };
    };
    const result = await runExperiment(planted({ terse: { terseNotes: "on" } }), {
      runTurn: refused,
      concurrency: 1,
    });
    expect(calls).toHaveLength(1);
    expect(result.stopped).toBe(AUTH_ABORT_REASON);
    expect(experimentExitCode(result)).toBe(1);
  });

  it("fails clearly when the provider starts refusing every call mid-run", async () => {
    let turns = 0;
    const plantedTurn = plantedTurns();
    const runTurn: ExperimentTurnRunner = async (evalCase, tactics) => {
      turns += 1;
      if (turns <= 4) return plantedTurn(evalCase, tactics);
      return {
        durationMs: 0,
        error: "provider_error: refused",
        turnError: {
          code: "provider_error",
          message: "refused",
          providerStatus: 400,
          providerFailures: ["rejected"],
        },
        stopReason: null,
        text: "",
        proposal: null,
        usage: null,
      };
    };
    const result = await runExperiment(
      { ...planted({ terse: { terseNotes: "on" } }), runs: 10 },
      { runTurn, concurrency: 1 },
    );
    expect(turns).toBe(4 + REFUSAL_STREAK);
    expect(result.stopped).toBe(refusalAbortReason(400));
    expect(result.failed).toBe(refusalAbortReason(400));
    expect(result.verdict).toBe("inconclusive");
    expect(experimentExitCode(result)).toBe(1);

    const { comments, moves, pulls, publisher } = recorder();
    await concludeExperiment(result, publisher, planOptions(SOURCES));
    expect(pulls).toEqual([]);
    expect(moves).toEqual([{ card: "GRV-110", state: "Blocked" }]);
    expect(comments[0].body).toMatch(/^# Experiment `planted`: run failed\n/);
    expect(comments[0].body).toContain("**The run failed, so this is not a verdict.**");
    expect(comments[0].body).not.toContain("**Unfinished.**");
  });
});

describe("keeping cuts in a dry run (GRV-110 section 5a)", () => {
  it("keeps a cut that changes nothing measurable and restores one that breaks check 1", async () => {
    const result = await runExperiment(
      planted({
        nothing: cut({ trimNothing: "on" }),
        breaks: cut({ trimBreaks: "on" }),
      }),
      { runTurn: plantedTurns(), now: fixedNow },
    );
    const [nothing, breaks] = result.trainAnalyses;
    expect(nothing).toMatchObject({ kind: "cut", verdict: "keep" });
    expect(nothing.goal.change).toBe(0);
    expect(nothing.cutMargin).toBe(20);
    expect(breaks).toMatchObject({ kind: "cut", verdict: "restore" });
    expect(breaks.why).toMatch(/^Refused by/);
    // Never inconclusive: neutral is a pass.
    expect(result.trainAnalyses.map((analysis) => analysis.verdict)).not.toContain(
      "inconclusive",
    );
    // Only the cut that kept on train goes on to held-out; one cut needs no combined run.
    expect(result.cutGate?.phase.caseIds).toHaveLength(3);
    expect(Object.keys(result.cutGate?.phase.reports ?? {})).toEqual([
      "control",
      "nothing",
    ]);
    expect(result.combined).toEqual([]);
    expect(result.cuts).toEqual([
      { name: "nothing", verdict: "keep", why: "Held the bar on train and held-out." },
      {
        name: "breaks",
        verdict: "restore",
        why: expect.stringMatching(/^On train: Refused by/),
      },
    ]);
    expect(result.keptCuts.map((entry) => entry.name)).toEqual(["nothing"]);
    // A kept cut lands with no improve winner: the verdict is a win, and the held PR opens.
    expect(result.winner).toBeNull();
    expect(result.verdict).toBe("win");

    const { pulls, publisher } = recorder();
    const concluded = await concludeExperiment(result, publisher, planOptions(SOURCES));
    expect(pulls).toHaveLength(1);
    expect(pulls[0].files[0].content).toBe(turnedOn("trimNothing"));
    expect(pulls[0].body).toContain("The cut `nothing` (trimNothing=on) held the bar");
    expect(pulls[0].body).toContain("- Restored, not in this PR: `breaks`.");
    expect(concluded.markdown).toContain("- Cuts kept: `nothing` (trimNothing=on)");
    expect(concluded.markdown).toContain("| `nothing` | **keep** |");
    expect(concluded.markdown).toContain("| `breaks` | **restore** |");
  });

  it("catches two cuts that pass alone but fail together, and drops the worse one", async () => {
    const result = await runExperiment(
      planted({ a: cut({ trimA: "on" }), b: cut({ trimB: "on" }) }),
      { runTurn: plantedTurns(), now: fixedNow },
    );
    // Each alone: within 2% of the control's 1,000 tokens, so both keep.
    expect(result.trainAnalyses.map((analysis) => analysis.verdict)).toEqual([
      "keep",
      "keep",
    ]);
    expect(result.cutGate?.analyses.map((analysis) => analysis.verdict)).toEqual([
      "keep",
      "keep",
    ]);
    // Together they break check 1: the combined run catches it on train.
    expect(result.combined).toHaveLength(1);
    const [together] = result.combined;
    expect(together.cuts).toEqual(["a", "b"]);
    expect(together.variant.overrides).toEqual({ trimA: "on", trimB: "on" });
    expect(together.train.analysis.verdict).toBe("restore");
    expect(together.heldout).toBeNull();
    expect(together.held).toBe(false);
    // `a` wrote more tokens than `b`, so it is the one dropped; `b` alone already held.
    expect(result.cuts).toEqual([
      {
        name: "a",
        verdict: "restore",
        why: expect.stringMatching(/failed together in combined run 1.*worst/),
      },
      { name: "b", verdict: "keep", why: "Held the bar on train and held-out." },
    ]);
    expect(result.keptCuts.map((entry) => entry.name)).toEqual(["b"]);
    expect(result.verdict).toBe("win");

    const { pulls, publisher } = recorder();
    const concluded = await concludeExperiment(result, publisher, planOptions(SOURCES));
    expect(pulls[0].files[0].content).toBe(turnedOn("trimB"));
    expect(concluded.markdown).toContain("### Combined run 1: `a` + `b`, failed");
  });

  it("retries a failing combination at most twice, then keeps none of it", async () => {
    const result = await runExperiment(
      planted({
        a: cut({ trimA: "on" }),
        b: cut({ trimB: "on" }),
        c: cut({ trimC: "on" }),
        d: cut({ trimD: "on" }),
      }),
      { runTurn: plantedTurns(), gateRuns: 1, runs: 1 },
    );
    expect(result.combined.map((run) => run.cuts)).toEqual([
      ["a", "b", "c", "d"],
      ["b", "c", "d"],
      ["b", "d"],
    ]);
    expect(result.combined).toHaveLength(1 + COMBINED_CUT_RETRIES);
    expect(result.keptCuts).toEqual([]);
    expect(result.cuts.map((entry) => entry.verdict)).toEqual([
      "restore",
      "restore",
      "restore",
      "restore",
    ]);
    expect(result.verdict).toBe("no win");
    const { pulls, publisher } = recorder();
    await concludeExperiment(result, publisher, planOptions(SOURCES));
    expect(pulls).toEqual([]);
  });

  it("lands the winning improve with every kept cut in one held PR", async () => {
    const result = await runExperiment(
      planted({ terse: { terseNotes: "on" }, nothing: cut({ trimNothing: "on" }) }),
      { runTurn: plantedTurns(), now: fixedNow },
    );
    expect(result.winner?.name).toBe("terse");
    expect(result.keptCuts.map((entry) => entry.name)).toEqual(["nothing"]);
    expect(result.verdict).toBe("win");
    const { pulls, publisher } = recorder();
    await concludeExperiment(result, publisher, planOptions(SOURCES));
    expect(pulls).toHaveLength(1);
    expect(pulls[0].files[0].content).toBe(turnedOn("terseNotes", "trimNothing"));
    expect(pulls[0].title).toBe(
      "Implement GRV-110: Default to terseNotes=on, trimNothing=on (experiment planted)",
    );
  });

  it("restores every cut not yet proven when the budget runs out", async () => {
    const result = await runExperiment(planted({ nothing: cut({ trimNothing: "on" }) }), {
      runTurn: plantedTurns(),
      budgetUsd: 0.05,
      concurrency: 1,
    });
    expect(result.stopped).toBe(BUDGET_STOP_REASON);
    expect(result.cuts).toEqual([
      { name: "nothing", verdict: "restore", why: expect.stringMatching(/^Unfinished/) },
    ]);
    expect(result.verdict).toBe("inconclusive");
  });
});

describe("check 6 as a guardrail in a dry run (GRV-141)", () => {
  /** A compressor on the master at `threshold`: proposals differ by their threshold. */
  function compressorAt(threshold: number) {
    const call = compressorCall("c");
    const input = call.input as { device: { parameters: Record<string, number> } };
    return {
      ...call,
      input: {
        ...input,
        device: {
          ...input.device,
          parameters: { ...input.device.parameters, threshold },
        },
      },
    };
  }

  /**
   * Every case answered with a compressor, the generators variants in fewer
   * tokens. An extreme case gets a harder threshold, unless `flattens` and the
   * variant turns generators on: then it gets the conventional answer.
   */
  function generatorTurns(flattens: boolean): ExperimentTurnRunner {
    return (evalCase, tactics) => {
      const generators = tactics.patternGenerators === "on";
      const extreme = evalCase.axis === "extreme" && !(flattens && generators);
      return runCaseTurn(evalCase, {
        provider: createScriptedAssistantProvider([
          toolUseEvents(
            "A Compressor on the master.",
            [compressorAt(extreme ? -30 : -18)],
            {
              outputTokens: generators ? 600 + caseWobble(evalCase.id) : 1_000,
            },
          ),
        ]),
      });
    };
  }

  it("judges check 6 on the pattern-generators experiment's own block, which its phases alone never hold", async () => {
    const experiment = await loadExperiment("pattern-generators");
    expect(experiment.guardrails.holdNotFlattened).toBe(true);
    // The defect this guards against: neither split of the heavy set holds a pair.
    expect(casePairs(experiment.train)).toEqual([]);
    expect(casePairs(experiment.heldout)).toEqual([]);

    const result = await runExperiment(experiment, {
      runTurn: generatorTurns(false),
      now: fixedNow,
    });
    // Train: the goal reads the heavy train cases alone, check 6 its block alone.
    expect(result.train.caseIds).toEqual(experiment.train.map((entry) => entry.id));
    expect(result.train.flattening?.caseIds).toEqual([
      "variation-mangled",
      "variation-fill",
      "process-crushed",
      "process-glue",
    ]);
    expect(result.train.reports.control.caseIds).toEqual(result.train.caseIds);
    expect(
      result.train.reports.control.records.some(
        (record) => record.checks.notFlattened !== undefined,
      ),
    ).toBe(false);
    for (const analysis of result.trainAnalyses) {
      const guardrail = analysis.guardrails.find((entry) => entry.id === "notFlattened");
      expect(guardrail).toMatchObject({
        pass: true,
        detail:
          "`variation-mangled` 3/3 to 3/3 unflattened; `process-crushed` 3/3 to 3/3 unflattened",
      });
      expect(analysis.verdict).toBe("win");
    }
    // The gate judges it on the held-out block, a pool case in both running once.
    const [gate] = result.gates;
    expect(gate.phase.flattening?.caseIds).toEqual(
      experiment.flattening.heldout.map((entry) => entry.id),
    );
    expect(gate.phase.reports.control.records).toHaveLength(
      experiment.heldout.length * 5,
    );
    expect(
      gate.analysis.guardrails.find((entry) => entry.id === "notFlattened"),
    ).toMatchObject({
      pass: true,
      detail:
        "`sketch-broken` 5/5 to 5/5 unflattened; `arrange-no-build` 5/5 to 5/5 unflattened; `balance-lopsided` 5/5 to 5/5 unflattened",
    });
    expect(result.verdict).toBe("win");
  });

  it("refuses a variant that answers the extreme cases conventionally", async () => {
    const result = await runExperiment(await loadExperiment("pattern-generators"), {
      runTurn: generatorTurns(true),
      now: fixedNow,
    });
    for (const analysis of result.trainAnalyses) {
      expect(analysis.goal.outcome).toBe("better");
      expect(
        analysis.guardrails.find((entry) => entry.id === "notFlattened"),
      ).toMatchObject({
        pass: false,
        detail:
          "`variation-mangled` 3/3 to 0/3 unflattened (flattened); `process-crushed` 3/3 to 0/3 unflattened (flattened)",
      });
      expect(analysis.verdict).toBe("no win");
    }
    expect(result.gates).toEqual([]);
    expect(result.verdict).toBe("no win");
  });
});

// GRV-145: an experiment whose goal reads only its focus cases, all of them
// train, so the held-out gate judges the guardrails alone.
describe("an experiment with a focus (GRV-145)", () => {
  const FOCUS = ["process-crushed", "balance-clean", "density-hats"];

  function focused(guardrails: Readonly<Record<string, unknown>> = {}) {
    return validateExperiment(
      {
        id: "planted-focus",
        card: "GRV-145",
        hypothesis: "A planted tactic does what it was planted to do, on its focus.",
        variants: { terse: { terseNotes: "on" } },
        goal: "outputTokens",
        cases: { caseIds: POOL },
        focus: FOCUS,
        guardrails,
      },
      { tactics: PLANTED },
    );
  }

  it("reads the goal from the focus on train, and gates on the guardrails alone", async () => {
    const experiment = focused({ noMaxTokens: true, everyTurnChecks: ["noEmptyClips"] });
    expect(judgedOnGuardrailsAlone(experiment, "train")).toBe(false);
    expect(judgedOnGuardrailsAlone(experiment, "gate")).toBe(true);
    expect(judgedOnGuardrailsAlone(experiment, "cut-gate")).toBe(true);
    expect(
      judgedOnGuardrailsAlone(planted({ terse: { terseNotes: "on" } }), "gate"),
    ).toBe(false);

    const result = await runExperiment(experiment, {
      runTurn: plantedTurns(),
      now: fixedNow,
    });
    const [train] = result.trainAnalyses;
    expect(train.goal.pairedCases).toBe(3);
    expect(train.goal.label).toBe("Output tokens per turn on the focus cases");
    expect(train.verdict).toBe("win");
    expect(train.guardrails.map((guardrail) => guardrail.id)).toContain("noMaxTokens");
    expect(result.gates).toHaveLength(1);
    expect(result.gates[0].analysis.goal.pairedCases).toBe(0);
    expect(result.gates[0].analysis.verdict).toBe("win");
    expect(result.verdict).toBe("win");

    const markdown = renderExperimentMarkdown(result, LINKS);
    expect(markdown).toContain(
      "- Focus: `process-crushed`, `balance-clean`, `density-hats`: the goal is read from these alone, and none is held out, so the held-out gate judges the guardrails alone",
    );
    expect(markdown).toContain(
      "; and on the focus cases no max_tokens stop at all, check 16 holding on every turn's proposal",
    );
  });
});
