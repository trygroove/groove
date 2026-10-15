/**
 * The sets of assistant eval cases the scorecard scores apart (GRV-119): the
 * musical capability evals (GRV-6 onwards) and the basic production actions.
 * Kept apart from `cases.ts` so the scorecard can name a set without loading
 * every case.
 */
export const EVAL_SETS = ["musical", "basicActions"] as const;
export type EvalSetId = (typeof EVAL_SETS)[number];

export const EVAL_SET_LABELS: Readonly<Record<EvalSetId, string>> = {
  musical: "Musical capability",
  basicActions: "Basic production actions",
};

/** The set a case belongs to: the musical one unless it says otherwise. */
export function caseSet(evalCase: { readonly set?: EvalSetId }): EvalSetId {
  return evalCase.set ?? "musical";
}

/** A set's label, or its ID when it is not one this build knows. */
export function setLabel(set: string): string {
  return (EVAL_SET_LABELS as Readonly<Record<string, string>>)[set] ?? set;
}
