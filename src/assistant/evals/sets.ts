/**
 * The sets of assistant eval cases the scorecard scores apart (GRV-119): the
 * musical capability evals (GRV-6 onwards), the basic production actions,
 * and Coproducer's lesson turns (GRV-208, `lessonCases.ts`).
 * Kept apart from `cases.ts` so the scorecard can name a set without loading
 * every case.
 *
 * A **group** (GRV-131) is a named list of cases that cuts across the sets:
 * `--set` runs one as it runs a set, and the scorecard sums it up in a block
 * of its own, but its cases are still scored in their own sets. The one group
 * is the heavy-output set, the turns that write the most proposal JSON.
 */
export const EVAL_SETS = ["musical", "basicActions", "lessons"] as const;
export type EvalSetId = (typeof EVAL_SETS)[number];

export const EVAL_SET_LABELS: Readonly<Record<EvalSetId, string>> = {
  musical: "Musical capability",
  basicActions: "Basic production actions",
  lessons: "Lessons",
};

/**
 * The sketches and arrangements that spend 6k to 15k output tokens a turn
 * (GRV-131's measure of what an output-token lever saves), heaviest first.
 */
export const HEAVY_OUTPUT_CASE_IDS = [
  "sketch-broken",
  "sketch-house",
  "develop-track-arrange",
  "sketch-whole-song",
  "sketch-track-scope",
  "arrange-build-drop",
  "arrange-no-build",
  "density-hats",
] as const;

export const EVAL_GROUPS = {
  heavyOutput: HEAVY_OUTPUT_CASE_IDS,
} as const satisfies Readonly<Record<string, readonly string[]>>;
export type EvalGroupId = keyof typeof EVAL_GROUPS;

/** What `--set` may name: a set, or a group. */
export const EVAL_SELECTIONS = [
  ...EVAL_SETS,
  ...(Object.keys(EVAL_GROUPS) as EvalGroupId[]),
] as const;
export type EvalSelection = EvalSetId | EvalGroupId;

export function isEvalGroup(selection: string): selection is EvalGroupId {
  return Object.hasOwn(EVAL_GROUPS, selection);
}

/** The set a case belongs to: the musical one unless it says otherwise. */
export function caseSet(evalCase: { readonly set?: EvalSetId }): EvalSetId {
  return evalCase.set ?? "musical";
}

/** Whether a case is in a selection: its set, or a group that lists it. */
export function inSelection(
  evalCase: { readonly id: string; readonly set?: EvalSetId },
  selection: EvalSelection,
): boolean {
  if (isEvalGroup(selection)) {
    return (EVAL_GROUPS[selection] as readonly string[]).includes(evalCase.id);
  }
  return caseSet(evalCase) === selection;
}

/** A set's label, or its ID when it is not one this build knows. */
export function setLabel(set: string): string {
  return (EVAL_SET_LABELS as Readonly<Record<string, string>>)[set] ?? set;
}
