/**
 * The experiment framework's dry runs (GRV-110): a scripted provider and
 * planted tactics, through the gateway's own turn, the verdict, the gate and
 * the PR plan, with a recorder in place of the comment poster and the PR
 * opener so nothing is posted or opened.
 */
import { readFileSync } from "node:fs";
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
import type { AssistantProvider } from "../provider";
import { continuesTurn } from "../providerRequest";
import type { TacticDefinition } from "../tactics";
import { toolNameFor } from "../tools";
import { validateExperiment } from "./experiment";
import {
  concludeExperiment,
  type ExperimentPublisher,
  PROMPT_PATH,
  TACTICS_PATH,
  type WinPullRequest,
} from "./experimentPr";
import { renderExperimentMarkdown } from "./experimentReport";
import {
  BUDGET_STOP_REASON,
  type ExperimentTurnRunner,
  experimentExitCode,
  gatewayTurnRunner,
  runExperiment,
} from "./experimentRun";
import { AUTH_ABORT_REASON, runCaseTurn } from "./run";

/** Tactics no production code knows: the scripted model is what reads them. */
const PLANTED: Readonly<Record<string, TacticDefinition>> = {
  terseNotes: {
    description: "Planted: the same proposal in fewer output tokens.",
    values: ["off", "on"],
    default: "off",
    alters: ["prompt"],
  },
  noop: {
    description: "Planted: changes nothing at all.",
    values: ["off", "on"],
    default: "off",
    alters: ["request"],
  },
  skipTools: {
    description: "Planted: answers in words and calls no tool, so check 1 fails.",
    values: ["off", "on"],
    default: "off",
    alters: ["tools"],
  },
};

/** A registry source the win PR rewrites, as `tactics.ts` lays its entries out. */
const PLANTED_SOURCE = `export const TACTICS = {
  terseNotes: {
    description: "Planted.",
    values: ["off", "on"],
    default: "off",
    alters: ["prompt"],
  },
  noop: {
    description: "Planted.",
    values: ["off", "on"],
    default: "off",
    alters: ["request"],
  },
} as const;
`;

const PROMPT_SOURCE = `export const ASSISTANT_PROMPT_VERSION = "2026-10-17.2";\n`;

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

/** The turn's script: a compressor on the master, in fewer tokens when terse. */
function plantedScript(tactics: Readonly<Record<string, string>>) {
  if (tactics.skipTools === "on") {
    return replyEvents(["I would put a compressor on the master."], {
      outputTokens: 300,
    });
  }
  return toolUseEvents("A Compressor on the master to glue it.", [compressorCall("c")], {
    outputTokens: tactics.terseNotes === "on" ? 600 : 1_000,
  });
}

/** Each turn through the gateway's own turn, its model scripted from the planted values. */
function plantedTurns(calls: string[] = []): ExperimentTurnRunner {
  return (evalCase, tactics) => {
    calls.push(`${evalCase.id} ${JSON.stringify(tactics)}`);
    return runCaseTurn(evalCase, {
      provider: createScriptedAssistantProvider([plantedScript(tactics)]),
    });
  };
}

function planted(
  variants: Readonly<Record<string, Readonly<Record<string, string>>>>,
  caseIds = ["process-crushed", "process-glue"],
) {
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

/** Records what would have been posted and opened. */
function recorder() {
  const comments: { card: string; body: string }[] = [];
  const pulls: WinPullRequest[] = [];
  const publisher: ExperimentPublisher = {
    postComment: async (card, body) => {
      comments.push({ card, body });
      return "https://linear.app/comment";
    },
    openPullRequest: async (plan) => {
      pulls.push(plan);
      return "https://github.com/trygroove/groove/pull/1";
    },
  };
  return { comments, pulls, publisher };
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

describe("an experiment's dry run (GRV-110)", () => {
  it("wins with a tactic that lowers output tokens on one case and leaves quality alone, and opens one held PR", async () => {
    const result = await runExperiment(planted({ terse: { terseNotes: "on" } }), {
      runTurn: plantedTurns(),
    });

    expect(result.trainAnalyses).toHaveLength(1);
    const [train] = result.trainAnalyses;
    expect(train.goal).toMatchObject({ control: 1_000, variant: 600, change: -400 });
    expect(train.guardrails.every((guardrail) => guardrail.pass)).toBe(true);
    expect(train.verdict).toBe("win");
    // The gate: the control and the winner on the held-out case, 5 runs each.
    expect(result.gates).toHaveLength(1);
    expect(result.gates[0].phase.caseIds).toEqual(["process-glue"]);
    expect(result.gates[0].phase.runsPerCase).toBe(5);
    expect(result.gates[0].phase.reports.terse.records).toHaveLength(5);
    expect(result.gates[0].analysis.verdict).toBe("win");
    expect(result.verdict).toBe("win");
    expect(result.winner).toEqual({ name: "terse", overrides: { terseNotes: "on" } });
    expect(result.spentUsd).toBeGreaterThan(0);
    expect(experimentExitCode(result)).toBe(0);

    const { comments, pulls, publisher } = recorder();
    const concluded = await concludeExperiment(
      result,
      publisher,
      planOptions({ [TACTICS_PATH]: PLANTED_SOURCE, [PROMPT_PATH]: PROMPT_SOURCE }),
    );
    expect(pulls).toHaveLength(1);
    const [pull] = pulls;
    expect(pull.labels).toEqual(["hold"]);
    expect(pull.branch).toBe("claude/grv-110-experiment-planted");
    expect(pull.title).toBe(
      "Implement GRV-110: Default to terseNotes=on (experiment planted)",
    );
    expect(pull.body).toContain("Refs GRV-110");
    expect(pull.files.map((file) => file.path)).toEqual([
      TACTICS_PATH,
      PROMPT_PATH,
      "docs/experiments/planted.md",
    ]);
    // Only the winning tactic's default moved; the prompt it alters is a new version.
    expect(pull.files[0].content).toBe(
      PLANTED_SOURCE.replace(
        'default: "off",\n    alters: ["prompt"]',
        'default: "on",\n    alters: ["prompt"]',
      ),
    );
    expect(pull.files[1].content).toBe(
      `export const ASSISTANT_PROMPT_VERSION = "2026-10-18.1";\n`,
    );
    expect(pull.files[2].content).toBe(renderExperimentMarkdown(result, LINKS));
    // The comment goes on the card, after the PR, and links it.
    expect(comments).toEqual([{ card: "GRV-110", body: concluded.markdown }]);
    expect(concluded.markdown).toMatch(/^# Experiment `planted`: win/);
    expect(concluded.markdown).toContain(
      "- Held PR with the new defaults: https://github.com/trygroove/groove/pull/1",
    );
    expect(concluded.markdown).toContain(`run: ${LINKS.runUrl}`);
  });

  it("gives no win or inconclusive for a planted no-op, and opens nothing", async () => {
    const result = await runExperiment(planted({ same: { noop: "on" } }), {
      runTurn: plantedTurns(),
    });
    expect(["no win", "inconclusive"]).toContain(result.verdict);
    expect(result.trainAnalyses[0].goal.change).toBe(0);
    expect(result.gates).toEqual([]);
    expect(result.winner).toBeNull();
    const { comments, pulls, publisher } = recorder();
    await concludeExperiment(result, publisher, planOptions({}));
    expect(pulls).toEqual([]);
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

  it("runs the real thinkingEffort tactic through the gateway, and its win flips the registry's default", async () => {
    // The scripted model writes less when the request asks for low effort.
    const provider: AssistantProvider = {
      stream(request, signal) {
        const script = continuesTurn(request)
          ? []
          : toolUseEvents("A Compressor on the master.", [compressorCall("e")], {
              outputTokens: request.output_config?.effort === "low" ? 500 : 900,
            });
        return createScriptedAssistantProvider([script]).stream(request, signal);
      },
    };
    const experiment = validateExperiment({
      id: "effort-low",
      card: "GRV-110",
      hypothesis: "Low effort writes fewer tokens.",
      variants: { low: { thinkingEffort: "low" } },
      goal: "outputTokens",
      cases: { caseIds: ["process-crushed", "process-glue"] },
    });
    const result = await runExperiment(experiment, {
      runTurn: gatewayTurnRunner({
        provider,
        model: (await import("../config")).ASSISTANT_MODELS["claude-sonnet-5"],
      }),
    });
    expect(result.verdict).toBe("win");
    expect(result.train.reports.low.tactics?.thinkingEffort).toBe("low");
    expect(result.train.reports.control.tactics?.thinkingEffort).toBe("medium");

    const { pulls, publisher } = recorder();
    const { TACTICS } = await import("../tactics");
    await concludeExperiment(
      result,
      publisher,
      planOptions({ [TACTICS_PATH]: readFileSync(TACTICS_PATH, "utf8") }, TACTICS),
    );
    const [pull] = pulls;
    // thinkingEffort alters the request alone: no version moves.
    expect(pull.files.map((file) => file.path)).toEqual([
      TACTICS_PATH,
      "docs/experiments/effort-low.md",
    ]);
    const before = readFileSync(TACTICS_PATH, "utf8");
    expect(pull.files[0].content).toBe(
      before.replace('    default: "medium",', '    default: "low",'),
    );
  });

  it("interleaves the variants case by case and run by run", async () => {
    const calls: string[] = [];
    await runExperiment(
      {
        ...planted({ terse: { terseNotes: "on" } }, [
          "process-crushed",
          "balance-clean",
          "process-glue",
        ]),
        runs: 2,
      },
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
});
