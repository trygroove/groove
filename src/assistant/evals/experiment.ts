/**
 * An assistant experiment (GRV-110): a hypothesis about a tactic, the
 * variants that test it, the one number it should move, and the quality bar
 * that must hold while it does. Each lives in `evals/experiments/<id>.ts` as
 * the default export of {@link defineExperiment}, and is checked against the
 * tactic registry and the eval cases by {@link validateExperiment} before
 * anything runs, so a typo costs no model call.
 *
 * - **Variants** are named sets of tactic values (`tactics.ts`). The
 *   **control**, production's defaults, is always there and never written;
 *   a variant that sets several tactics is a combination. A variant must
 *   differ from every other variant. One whose values production already
 *   runs (a win made them the defaults) is kept as written and set aside as
 *   {@link Experiment.atDefaults}, so a file stays valid after its own win;
 *   {@link assertRunnable} refuses to run one with nothing left to compare.
 * - A variant is an **improve** (the default), which must beat the control,
 *   or a **cut** (`{ kind: "cut", tactics: {...} }`), which removes something
 *   and only has to hold the bar (`verdict.ts`, "Keeping cuts"). A cut sets
 *   tactics no other variant sets, so the cuts that pass can run together.
 * - The **goal** is one metric to improve: `quality` (the overall pass rate),
 *   `outputTokens`, `latencyP50` or `cost` (per turn), or `firstTextP50`.
 * - The **cases** are a pool, the whole suite, a set or group (`sets.ts`), or
 *   a list. An experiment runs on the pool's `train` cases and gates its
 *   winner on the pool's `heldout` ones (`splits.ts`), so a pool needs both.
 * - The **guardrails** start at GRV-131's bar (checks 1 and 8 within 3
 *   points per set, the overall pass rate within 2, no case passing in most
 *   runs going to failing in most, no rise in `max_tokens` stops or errored
 *   turns). An experiment may tighten the two point limits, and a cut's
 *   2% margin, never loosen them, and may add three stricter ones (GRV-145):
 *   no `max_tokens` stop at all, output tokens per turn no higher than the
 *   control's, and named checks holding on every turn's own proposal. It may
 *   also hold check 6 (extreme is not flattened), which no experiment is held
 *   to unless it says so (GRV-141).
 *   Check 6 is only judged with an extreme case and its conventional
 *   partner side by side, and the split holds out one of every pair, so a
 *   phase's own cases never hold a pair: such an experiment also runs its
 *   **check-6 block** in every phase, the extreme cases of that phase's
 *   split, each beside its conventional partner, which only check 6 reads.
 * - An optional **focus** (GRV-145) names the cases, within the pool, the
 *   goal is read from and the stricter guardrails judge; the rest of the pool
 *   is held to the default bar. When no focus case is held out, the held-out
 *   gate judges the guardrails alone (`experimentRun.ts`).
 * - An optional **budget** in dollars overrides the $25 default; the
 *   command's `--budget` (the workflow's input) still wins over it.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { TACTICS, type TacticDefinition, type TacticOverrides } from "../tactics";
import {
  CASE_CHECK_IDS,
  EVERY_CASE_CHECKS,
  type EveryCaseCheckId,
  isEveryCaseCheck,
} from "./caseChecks";
import { casePairs, EVAL_CASES, type EvalCase } from "./cases";
import {
  isLessonTurnCheck,
  LESSON_CHECK_IDS,
  LESSON_TURN_CHECKS,
  type LessonTurnCheckId,
} from "./lessonChecks";
import { EVAL_SELECTIONS, type EvalSelection, inSelection } from "./sets";
import { caseSplit, casesInSplit, EVAL_SPLITS, type EvalSplit } from "./splits";

export const EXPERIMENT_GOALS = [
  "quality",
  "outputTokens",
  "latencyP50",
  "cost",
  "firstTextP50",
] as const;
export type ExperimentGoal = (typeof EXPERIMENT_GOALS)[number];

/** The variant every experiment has: production's defaults. */
export const CONTROL = "control";

/** What a variant is for: beating the control, or removing something without losing to it. */
export const VARIANT_KINDS = ["improve", "cut"] as const;
export type VariantKind = (typeof VARIANT_KINDS)[number];

/** The name the framework gives the cuts it reruns together; no file may use it. */
export const COMBINED_CUTS = "combined-cuts";

/** Runs per case on train, unless the experiment or the command says otherwise. */
export const DEFAULT_RUNS_PER_CASE = 3;

/** Runs per case on the held-out gate. */
export const GATE_RUNS_PER_CASE = 5;

/** GRV-131's quality bar, in percentage points: the loosest an experiment may run under. */
export const DEFAULT_GUARDRAILS = {
  /** Checks 1 and 8 may fall this far in any set. */
  maxCheckDropPoints: 3,
  /** The overall pass rate may fall this far. */
  maxOverallDropPoints: 2,
  /**
   * A cut's goal may be worse than the control's by at most this share of the
   * control's value, in percent, at the worse end of its interval.
   */
  cutMarginPercent: 2,
  /**
   * Whether check 6 (extreme is not flattened) is a guardrail, judged on the
   * check-6 block: an experiment that might make every answer sound the same
   * sets it (GRV-141).
   */
  holdNotFlattened: false,
} as const;

/** A check an experiment may hold on every turn. */
export type EveryTurnCheckId = EveryCaseCheckId | LessonTurnCheckId;

const EVERY_TURN_CHECKS: readonly EveryTurnCheckId[] = [
  ...EVERY_CASE_CHECKS,
  ...LESSON_TURN_CHECKS,
];

export interface ExperimentGuardrails {
  readonly maxCheckDropPoints: number;
  readonly maxOverallDropPoints: number;
  readonly cutMarginPercent: number;
  readonly holdNotFlattened: boolean;
  /**
   * The stricter guardrails an experiment may add (GRV-145), each judged on
   * its focus cases (every case without a focus), absent when not added.
   * `noMaxTokens`: no run of the variant's stops at `max_tokens`.
   */
  readonly noMaxTokens?: boolean;
  /** The variant's mean output tokens per turn (`byTurn`) is no higher than the control's. */
  readonly outputTokensPerTurn?: boolean;
  /**
   * These checks pass on every turn's own proposal (a session's `turnChecks`).
   * Only the checks a session judges on each turn may be named: those every
   * case is judged by (`EVERY_CASE_CHECKS`, 16 and 20), and those a lesson
   * session judges on each of its turns (`LESSON_TURN_CHECKS`, 25 to 28,
   * GRV-208); any other would be missing from every session turn and pass
   * without judging anything.
   */
  readonly everyTurnChecks?: readonly EveryTurnCheckId[];
}

/** Which cases an experiment draws its train and held-out cases from. */
export type ExperimentCases =
  | "all"
  | { readonly set: EvalSelection }
  | { readonly caseIds: readonly string[] };

/** An experiment as its file writes it. */
export interface ExperimentDefinition {
  /** Lower-case words joined by hyphens; the file is `evals/experiments/<id>.ts`. */
  readonly id: string;
  /** The Linear card it belongs to, `GRV-<n>`; its report is posted there. */
  readonly card: string;
  /** One line: what it expects to happen, and why. */
  readonly hypothesis: string;
  /**
   * Each variant's name and the tactic values it sets, or `{ kind, tactics }`
   * to say what kind it is (an improve when not said); the control is implicit.
   */
  readonly variants: Readonly<Record<string, TacticOverrides | VariantDefinition>>;
  readonly goal: ExperimentGoal;
  readonly cases: ExperimentCases;
  /** Tighter limits than {@link DEFAULT_GUARDRAILS}; never looser. */
  readonly guardrails?: Partial<ExperimentGuardrails>;
  /**
   * The cases the goal is read from and the stricter guardrails judge, all
   * in the pool (GRV-145); the whole pool when absent.
   */
  readonly focus?: readonly string[];
  /** Runs per case on train; {@link DEFAULT_RUNS_PER_CASE} when absent. */
  readonly runs?: number;
  /** Dollars it may spend; the $25 default when absent, and `--budget` beats it. */
  readonly budget?: number;
}

/** A variant with its kind written out. */
export interface VariantDefinition {
  readonly kind?: VariantKind;
  readonly tactics: TacticOverrides;
}

/** Types an experiment file's default export; {@link validateExperiment} checks it. */
export function defineExperiment(definition: ExperimentDefinition): ExperimentDefinition {
  return definition;
}

/** Tactic values by tactic ID, as a variant runs with them. */
export type VariantTactics = Readonly<Record<string, string>>;

export interface ExperimentVariant {
  readonly name: string;
  /** The values it sets away from production's; none for the control. */
  readonly overrides: VariantTactics;
  /** An improve must beat the control; a cut must only hold the bar. The control is an improve. */
  readonly kind: VariantKind;
}

/** An experiment checked and resolved: its variants, the control first, and its cases. */
export interface Experiment {
  readonly id: string;
  readonly card: string;
  readonly hypothesis: string;
  readonly goal: ExperimentGoal;
  readonly variants: readonly ExperimentVariant[];
  readonly cases: ExperimentCases;
  readonly train: readonly EvalCase[];
  readonly heldout: readonly EvalCase[];
  /**
   * The check-6 block per split: each extreme case of the split beside its
   * conventional partner (whatever the partner's own split, since it is only
   * the reference the extreme is compared with). Empty unless the
   * experiment holds check 6.
   */
  readonly flattening: {
    readonly train: readonly EvalCase[];
    readonly heldout: readonly EvalCase[];
  };
  readonly guardrails: ExperimentGuardrails;
  /** The focus cases' IDs (GRV-145), or null when the goal reads the whole pool. */
  readonly focus: readonly string[] | null;
  readonly runs: number;
  /** The file's own budget in dollars, or null for the default. */
  readonly budgetUsd: number | null;
  /** The variants whose values production already runs, so they are not run. */
  readonly atDefaults: readonly string[];
}

/** What is wrong with an experiment file, every issue at once. */
export class ExperimentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentError";
  }
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const definitionSchema = z.strictObject({
  id: z.string().regex(KEBAB, "lower-case words joined by hyphens"),
  card: z.string().regex(/^GRV-\d+$/, "a Linear card, GRV-<n>"),
  hypothesis: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine((text) => !/\n/.test(text), "one line"),
  variants: z.record(
    z.string().regex(KEBAB, "lower-case words joined by hyphens"),
    z.union([
      z.strictObject({
        kind: z.enum(VARIANT_KINDS).optional(),
        tactics: z.record(z.string(), z.string()),
      }),
      z.record(z.string(), z.string()),
    ]),
  ),
  goal: z.enum(EXPERIMENT_GOALS),
  cases: z.union([
    z.literal("all"),
    z.strictObject({ set: z.enum(EVAL_SELECTIONS) }),
    z.strictObject({ caseIds: z.array(z.string().min(1)).min(1) }),
  ]),
  guardrails: z
    .strictObject({
      maxCheckDropPoints: z
        .number()
        .min(0)
        .max(
          DEFAULT_GUARDRAILS.maxCheckDropPoints,
          "may tighten the bar, never loosen it",
        )
        .optional(),
      maxOverallDropPoints: z
        .number()
        .min(0)
        .max(
          DEFAULT_GUARDRAILS.maxOverallDropPoints,
          "may tighten the bar, never loosen it",
        )
        .optional(),
      cutMarginPercent: z
        .number()
        .min(0)
        .max(DEFAULT_GUARDRAILS.cutMarginPercent, "may tighten the bar, never loosen it")
        .optional(),
      holdNotFlattened: z.boolean().optional(),
      noMaxTokens: z.boolean().optional(),
      outputTokensPerTurn: z.boolean().optional(),
      everyTurnChecks: z
        .array(
          z
            .enum([...CASE_CHECK_IDS, ...LESSON_CHECK_IDS])
            .refine(
              (id): id is EveryTurnCheckId =>
                isLessonTurnCheck(id) || (id !== "startsLesson" && isEveryCaseCheck(id)),
              `only a check judged on every turn: ${EVERY_TURN_CHECKS.join(", ")}`,
            ),
        )
        .min(1)
        .optional(),
    })
    .optional(),
  focus: z.array(z.string().min(1)).min(1).optional(),
  runs: z.number().int().min(1).max(20).optional(),
  budget: z.number().positive().finite().optional(),
});

export interface ValidateOptions {
  /** The cases an experiment may name; every eval case by default. */
  readonly cases?: readonly EvalCase[];
  /** The tactics its variants may set; the registry by default. Tests plant their own. */
  readonly tactics?: Readonly<Record<string, TacticDefinition>>;
}

/** A variant as the file wrote it, plain tactic values or `{ kind, tactics }`. */
function writtenVariant(
  name: string,
  value:
    | VariantTactics
    | { readonly kind?: VariantKind; readonly tactics: VariantTactics },
): { name: string; kind: VariantKind; values: VariantTactics } {
  if (typeof value.tactics === "object") {
    const spelled = value as {
      readonly kind?: VariantKind;
      readonly tactics: VariantTactics;
    };
    return { name, kind: spelled.kind ?? "improve", values: spelled.tactics };
  }
  return { name, kind: "improve", values: value as VariantTactics };
}

/** Why one variant's values are wrong, against `registry`. */
function variantIssues(
  name: string,
  values: VariantTactics,
  registry: Readonly<Record<string, TacticDefinition>>,
): string[] {
  const issues: string[] = [];
  for (const [id, value] of Object.entries(values)) {
    const tactic = Object.hasOwn(registry, id) ? registry[id] : undefined;
    if (!tactic) {
      issues.push(
        `variants.${name}: unknown tactic "${id}" (tactics: ${Object.keys(registry).join(", ")})`,
      );
    } else if (!tactic.values.includes(value)) {
      issues.push(
        `variants.${name}.${id}: takes ${tactic.values.join(" | ")}, not "${value}"`,
      );
    }
  }
  return issues;
}

/** The values that differ from `registry`'s defaults, in the registry's order. */
function overridesOf(
  values: VariantTactics,
  registry: Readonly<Record<string, TacticDefinition>>,
): VariantTactics {
  return Object.fromEntries(
    Object.keys(registry)
      .filter((id) => values[id] !== undefined && values[id] !== registry[id].default)
      .map((id) => [id, values[id]]),
  );
}

/**
 * One split's check-6 block: every extreme case in `split` with its
 * conventional partner, the extreme first.
 */
export function flatteningBlock(
  cases: readonly EvalCase[],
  split: EvalSplit,
): EvalCase[] {
  return casePairs(cases)
    .filter((pair) => caseSplit(pair.extreme) === split)
    .flatMap((pair) => [pair.extreme, pair.conventional]);
}

/** The cases an experiment's pool names. */
function poolOf(
  cases: ExperimentCases,
  all: readonly EvalCase[],
  issues: string[],
): EvalCase[] {
  if (cases === "all") return [...all];
  if ("set" in cases) return all.filter((entry) => inSelection(entry, cases.set));
  const seen = new Set<string>();
  const pool: EvalCase[] = [];
  for (const id of cases.caseIds) {
    if (seen.has(id)) {
      issues.push(`cases.caseIds: "${id}" is named twice`);
      continue;
    }
    seen.add(id);
    const found = all.find((entry) => entry.id === id);
    if (!found) issues.push(`cases.caseIds: no eval case "${id}"`);
    else pool.push(found);
  }
  return pool;
}

/**
 * Checks an experiment file's export and resolves it. Throws an
 * {@link ExperimentError} listing every issue: a field of the wrong shape, a
 * tactic or value the registry does not know, a variant no different from
 * the control or from another, a case that does not exist, a pool with no
 * train or no held-out case, or a guardrail looser than the default.
 */
export function validateExperiment(
  raw: unknown,
  options: ValidateOptions = {},
): Experiment {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExperimentError(
      `Not a valid experiment: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const definition = parsed.data;
  const registry = options.tactics ?? TACTICS;
  const issues: string[] = [];
  const written = Object.entries(definition.variants).map(([name, value]) =>
    writtenVariant(name, value),
  );
  const names = written.map((variant) => variant.name);
  if (names.length === 0) issues.push("variants: name at least one beside the control");
  for (const reserved of [CONTROL, COMBINED_CUTS]) {
    if (names.includes(reserved)) {
      issues.push(
        reserved === CONTROL
          ? `variants: "${CONTROL}" is production's defaults, and is always run`
          : `variants: "${COMBINED_CUTS}" is the name the passing cuts rerun under`,
      );
    }
  }
  const keys = new Map<string, string>();
  const atDefaults: string[] = [];
  const runnable: ExperimentVariant[] = [];
  for (const { name, kind, values } of written) {
    const own = variantIssues(name, values, registry);
    issues.push(...own);
    if (own.length > 0) continue;
    if (Object.keys(values).length === 0) {
      issues.push(`variants.${name}: sets no tactic, so it is the control`);
      continue;
    }
    const overrides = overridesOf(values, registry);
    const key = JSON.stringify(overrides);
    if (key === "{}") {
      // Production runs these values now; most likely this experiment's own win.
      atDefaults.push(name);
    } else if (keys.has(key)) {
      issues.push(`variants.${name}: sets the same values as ${keys.get(key)}`);
    } else {
      keys.set(key, name);
      runnable.push({ name, overrides, kind });
    }
  }
  // Cuts that pass are rerun together, so none may set a tactic another variant sets.
  for (const cut of written.filter((variant) => variant.kind === "cut")) {
    for (const id of Object.keys(cut.values)) {
      const other = written.find(
        (variant) => variant !== cut && Object.hasOwn(variant.values, id),
      );
      if (other) {
        issues.push(
          `variants.${cut.name}: a cut sets ${id}, which ${other.name} sets too, so they cannot run together`,
        );
      }
    }
  }
  const pool = poolOf(definition.cases, options.cases ?? EVAL_CASES, issues);
  const train = casesInSplit(pool, "train");
  const heldout = casesInSplit(pool, "heldout");
  if (pool.length > 0 && train.length === 0) {
    issues.push("cases: none of them is a train case, so there is nothing to run on");
  }
  if (pool.length > 0 && heldout.length === 0) {
    issues.push("cases: none of them is held out, so a winner has no gate");
  }
  const flattening = {
    train: definition.guardrails?.holdNotFlattened
      ? flatteningBlock(options.cases ?? EVAL_CASES, "train")
      : [],
    heldout: definition.guardrails?.holdNotFlattened
      ? flatteningBlock(options.cases ?? EVAL_CASES, "heldout")
      : [],
  };
  if (definition.guardrails?.holdNotFlattened) {
    for (const split of EVAL_SPLITS) {
      if (flattening[split].length === 0) {
        issues.push(
          `guardrails.holdNotFlattened: no extreme ${split === "train" ? "train" : "held-out"} case has a conventional partner, so check 6 cannot be judged there`,
        );
      }
    }
  }
  const focus = definition.focus ?? null;
  if (focus) {
    const inPool = new Set(pool.map((entry) => entry.id));
    for (const id of new Set(focus)) {
      if (!inPool.has(id)) issues.push(`focus: "${id}" is not one of the cases`);
    }
    if (new Set(focus).size !== focus.length) issues.push("focus: a case is named twice");
    if (!train.some((entry) => focus.includes(entry.id))) {
      issues.push("focus: none of them is a train case, so the goal has nothing to read");
    }
  }
  if (issues.length > 0) {
    throw new ExperimentError(
      `Experiment "${definition.id}" is not valid: ${issues.join("; ")}`,
    );
  }
  return {
    id: definition.id,
    card: definition.card,
    hypothesis: definition.hypothesis.trim(),
    goal: definition.goal,
    variants: [{ name: CONTROL, overrides: {}, kind: "improve" }, ...runnable],
    cases: definition.cases,
    train,
    heldout,
    flattening,
    guardrails: { ...DEFAULT_GUARDRAILS, ...definition.guardrails },
    focus,
    runs: definition.runs ?? DEFAULT_RUNS_PER_CASE,
    budgetUsd: definition.budget ?? null,
    atDefaults,
  };
}

/**
 * Throws an {@link ExperimentError} when an experiment has no variant left
 * to run against the control: every one it names is production's defaults
 * now. A valid file, but nothing to compare.
 */
export function assertRunnable(experiment: Experiment): void {
  if (experiment.variants.length > 1) return;
  throw new ExperimentError(
    `Experiment "${experiment.id}" has nothing to run: production's defaults already are ${experiment.atDefaults.map((name) => `\`${name}\``).join(", ")}'s values.`,
  );
}

/** Where experiment files live, from the repository root the tools run in. */
export function experimentsDir(): string {
  return resolve("evals/experiments");
}

/** Every experiment ID there is a file for, sorted. */
export function experimentIds(dir = experimentsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.slice(0, -3))
    .sort();
}

/**
 * Loads and checks `evals/experiments/<id>.ts`. Throws an
 * {@link ExperimentError} when there is no such file, it has no default
 * export, the experiment is not valid, or its `id` is not its file's name.
 */
export async function loadExperiment(
  id: string,
  dir = experimentsDir(),
  options: ValidateOptions = {},
): Promise<Experiment> {
  const path = join(dir, `${id}.ts`);
  if (!KEBAB.test(id) || !existsSync(path)) {
    const known = experimentIds(dir);
    throw new ExperimentError(
      `No experiment "${id}" (${path}). Experiments: ${known.length > 0 ? known.join(", ") : "none yet"}`,
    );
  }
  const module = (await import(/* @vite-ignore */ path)) as { default?: unknown };
  if (module.default === undefined) {
    throw new ExperimentError(
      `${path} has no default export: export default defineExperiment({...})`,
    );
  }
  const experiment = validateExperiment(module.default, options);
  if (experiment.id !== id) {
    throw new ExperimentError(
      `${path} holds the experiment "${experiment.id}"; name it ${experiment.id}.ts`,
    );
  }
  return experiment;
}

/** The pool an experiment draws from, as a line of the report. */
export function describeCases(cases: ExperimentCases): string {
  if (cases === "all") return "the full suite";
  if ("set" in cases) return `the \`${cases.set}\` set`;
  return cases.caseIds.map((id) => `\`${id}\``).join(", ");
}
