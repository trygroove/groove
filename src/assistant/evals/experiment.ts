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
 *   differ from the control and from every other variant.
 * - The **goal** is one metric to improve: `quality` (the overall pass rate),
 *   `outputTokens`, `latencyP50` or `cost` (per turn), or `firstTextP50`.
 * - The **cases** are a pool, the whole suite, a set or group (`sets.ts`), or
 *   a list. An experiment runs on the pool's `train` cases and gates its
 *   winner on the pool's `heldout` ones (`splits.ts`), so a pool needs both.
 * - The **guardrails** start at GRV-131's bar (checks 1 and 8 within 3
 *   points per set, the overall pass rate within 2, no case passing in most
 *   runs going to failing in most, no rise in `max_tokens` stops or errored
 *   turns). An experiment may tighten the two point limits, never loosen
 *   them.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { TACTICS, type TacticDefinition, type TacticOverrides } from "../tactics";
import { EVAL_CASES, type EvalCase } from "./cases";
import { EVAL_SELECTIONS, type EvalSelection, inSelection } from "./sets";
import { casesInSplit } from "./splits";

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
} as const;

export interface ExperimentGuardrails {
  readonly maxCheckDropPoints: number;
  readonly maxOverallDropPoints: number;
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
  /** Each variant's name and the tactic values it sets; the control is implicit. */
  readonly variants: Readonly<Record<string, TacticOverrides>>;
  readonly goal: ExperimentGoal;
  readonly cases: ExperimentCases;
  /** Tighter limits than {@link DEFAULT_GUARDRAILS}; never looser. */
  readonly guardrails?: Partial<ExperimentGuardrails>;
  /** Runs per case on train; {@link DEFAULT_RUNS_PER_CASE} when absent. */
  readonly runs?: number;
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
  readonly guardrails: ExperimentGuardrails;
  readonly runs: number;
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
    z.record(z.string(), z.string()),
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
    })
    .optional(),
  runs: z.number().int().min(1).max(20).optional(),
});

export interface ValidateOptions {
  /** The cases an experiment may name; every eval case by default. */
  readonly cases?: readonly EvalCase[];
  /** The tactics its variants may set; the registry by default. Tests plant their own. */
  readonly tactics?: Readonly<Record<string, TacticDefinition>>;
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
  const names = Object.keys(definition.variants);
  if (names.length === 0) issues.push("variants: name at least one beside the control");
  if (names.includes(CONTROL)) {
    issues.push(`variants: "${CONTROL}" is production's defaults, and is always run`);
  }
  const keys = new Map<string, string>();
  for (const name of names) {
    const values = definition.variants[name];
    const own = variantIssues(name, values, registry);
    issues.push(...own);
    if (own.length > 0) continue;
    const key = JSON.stringify(overridesOf(values, registry));
    if (key === "{}") {
      issues.push(
        `variants.${name}: sets every tactic to its default, so it is the control`,
      );
    } else if (keys.has(key)) {
      issues.push(`variants.${name}: sets the same values as ${keys.get(key)}`);
    } else {
      keys.set(key, name);
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
    variants: [
      { name: CONTROL, overrides: {} },
      ...names.map((name) => ({
        name,
        overrides: overridesOf(definition.variants[name], registry),
      })),
    ],
    cases: definition.cases,
    train,
    heldout,
    guardrails: { ...DEFAULT_GUARDRAILS, ...definition.guardrails },
    runs: definition.runs ?? DEFAULT_RUNS_PER_CASE,
  };
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
