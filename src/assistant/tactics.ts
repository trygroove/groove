/**
 * The assistant's tactic switches (GRV-110): every lever an experiment may
 * pull, written down once with its production default.
 *
 * A **tactic** is one named choice about how the gateway asks the model: how
 * hard it thinks, how notes are written, how much of the project it is sent.
 * Each entry says what it is for, the values it can take, the value
 * production uses, and what it alters (the system prompt, the tool set, the
 * request around them, or how a reply's calls are expanded). The gateway reads
 * every value from one {@link TacticValues}, resolved by {@link resolveTactics}
 * from the defaults below, so production, which passes nothing, runs the
 * defaults, and an eval or experiment run (`--tactic id=value`,
 * `evals/experiments/<id>.ts`) changes a turn only through a value here.
 *
 * Adding a tactic switched off (its default the behaviour production already
 * has) bumps nothing. Changing a default that alters the prompt bumps
 * `ASSISTANT_PROMPT_VERSION`, and one that alters the tools or their expansion
 * bumps `ASSISTANT_TOOLSET_VERSION`, in the same change; an experiment's win
 * PR does both (`evals/experimentPr.ts`). A change to the request alone is
 * recorded by the tactic values every eval report names.
 *
 * Like `config.ts`, this module imports nothing from Firebase, Tone, Solid or
 * the provider's SDK.
 */

/** What changing a tactic's value changes. */
export type TacticSurface = "prompt" | "tools" | "request" | "expansion";

export interface TacticDefinition {
  /** One line: what the tactic does. */
  readonly description: string;
  /** Every value it can take, as strings, the default among them. */
  readonly values: readonly string[];
  /** The value production uses. */
  readonly default: string;
  /** What a change of value alters, which says which version it bumps. */
  readonly alters: readonly TacticSurface[];
}

/**
 * Every tactic, by ID. The `default:` line of each entry is rewritten by the
 * framework's win PR, so keep each on a line of its own.
 */
export const TACTICS = {
  thinkingEffort: {
    description:
      "How hard an adaptive-thinking model thinks before it answers (`output_config.effort`); a budget-thinking model ignores it.",
    values: ["low", "medium", "high"],
    default: "low",
    alters: ["request"],
  },
} as const satisfies Readonly<Record<string, TacticDefinition>>;

export type TacticId = keyof typeof TACTICS;

/** Every tactic's ID, in the registry's order. */
export const TACTIC_IDS = Object.keys(TACTICS) as TacticId[];

/** The values one tactic can take. */
export type TacticValue<Id extends TacticId> = (typeof TACTICS)[Id]["values"][number];

/** A value for every tactic: what one turn runs with. */
export type TacticValues = { readonly [Id in TacticId]: TacticValue<Id> };

/** Some tactics' values, the rest left at their defaults. */
export type TacticOverrides = Partial<TacticValues>;

/** Production's values: every tactic at its default. */
export const TACTIC_DEFAULTS: TacticValues = Object.fromEntries(
  TACTIC_IDS.map((id) => [id, TACTICS[id].default]),
) as unknown as TacticValues;

export function isTacticId(id: string): id is TacticId {
  return Object.hasOwn(TACTICS, id);
}

/** Every tactic's value: the overrides given, the defaults for the rest. */
export function resolveTactics(overrides: TacticOverrides = {}): TacticValues {
  return { ...TACTIC_DEFAULTS, ...overrides };
}

/** The overrides that differ from production's defaults, in the registry's order. */
export function nonDefaultTactics(values: TacticOverrides): TacticOverrides {
  return Object.fromEntries(
    TACTIC_IDS.filter(
      (id) => values[id] !== undefined && values[id] !== TACTIC_DEFAULTS[id],
    ).map((id) => [id, values[id]]),
  ) as TacticOverrides;
}

/** Why a tactic value is not one the registry knows, or null when it is. */
export function tacticIssue(id: string, value: unknown): string | null {
  if (!isTacticId(id)) {
    return `Unknown tactic "${id}". Tactics: ${TACTIC_IDS.join(", ")}`;
  }
  const values: readonly string[] = TACTICS[id].values;
  if (typeof value !== "string" || !values.includes(value)) {
    return `Tactic ${id} takes ${values.join(" | ")}, not ${JSON.stringify(value)}`;
  }
  return null;
}

/**
 * Checks a set of overrides against the registry. Throws a `TypeError` naming
 * every unknown tactic or value.
 */
export function parseTacticOverrides(
  raw: Readonly<Record<string, unknown>>,
): TacticOverrides {
  const issues = Object.entries(raw)
    .map(([id, value]) => tacticIssue(id, value))
    .filter((issue): issue is string => issue !== null);
  if (issues.length > 0) throw new TypeError(issues.join("; "));
  return { ...raw } as TacticOverrides;
}

/**
 * One `id=value` assignment, as `--tactic` takes it. Throws a `TypeError`
 * saying what is wrong with it.
 */
export function parseTacticAssignment(text: string): TacticOverrides {
  const equals = text.indexOf("=");
  if (equals <= 0 || equals === text.length - 1) {
    throw new TypeError(
      `A tactic is written id=value, e.g. thinkingEffort=low, not "${text}"`,
    );
  }
  return parseTacticOverrides({ [text.slice(0, equals)]: text.slice(equals + 1) });
}

/**
 * Every tactic's value as one line, `thinkingEffort=medium`, a value that
 * differs from production's marked so a report reads which run is which.
 */
export function describeTactics(values: TacticOverrides): string {
  return TACTIC_IDS.filter((id) => values[id] !== undefined)
    .map((id) =>
      values[id] === TACTIC_DEFAULTS[id]
        ? `${id}=${values[id]}`
        : `${id}=${values[id]} (default ${TACTIC_DEFAULTS[id]})`,
    )
    .join(", ");
}
