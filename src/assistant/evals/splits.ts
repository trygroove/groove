/**
 * Each eval case's fixed split (GRV-110): `train`, the cases an experiment is
 * run and chosen on, or `heldout`, the cases its winner must win on again
 * before it is believed. A tactic tuned on the cases that then judge it would
 * only be shown to fit them.
 *
 * The split is stratified by capability: within each, about a third of the
 * cases are held out (a third of its count, rounded; so one of each
 * conventional/extreme pair, and none of a capability with one case), which
 * holds out 27 of the 73 cases, a JSON case's own split included. Within a capability the held-out cases are
 * picked to spread across its kinds of request: the extreme of one pair and
 * the conventional of the next, and three of the eight heavy-output cases
 * (`sets.ts`), so an output-token experiment on that group has a gate.
 *
 * A split never changes once a case has one: moving a case would let an
 * experiment already chosen on it be judged on it. A new case names its
 * split here (or in its JSON file's `split`); `splits.test.ts` fails on a
 * case with none and on a capability that drifts from the third.
 */
import type { EvalCase } from "./cases";

export const EVAL_SPLITS = ["train", "heldout"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

/** The held-out cases, by capability; every other case written here is `train`. */
export const HELDOUT_CASE_IDS = [
  // loopSketch, variation, arrangement, balancing, processing: one of each pair.
  "sketch-broken",
  "variation-fill",
  "arrange-no-build",
  "balance-lopsided",
  "process-glue",
  // development, newPart, sketchScope, resketch, soundPicks.
  "develop-track-ask",
  "pad-genre-unknown",
  "sketch-track-scope",
  "noop-bd-only",
  "snare-hats-sounds",
  // projectContext (GRV-150): one of two.
  "context-cancelled-hat",
  // relativeLevel: two of six.
  "db-turn-down",
  "db-stale-undone",
  // basicAction: eleven of thirty-two, every third and the last.
  "basic-trim-drums",
  "basic-delete-pad",
  "basic-rename-track",
  "basic-vocals-to-top",
  "basic-longer-kick",
  "basic-lower-cutoff",
  "basic-wetter-reverb",
  "basic-quantize-hats",
  "basic-double-speed",
  "basic-key",
  "basic-missing-track",
  // lesson (GRV-208): three of ten, a start, a bite shown and a wrap-up.
  "lesson-start-no-echo",
  "chords-shown",
  "wrap-up-once",
] as const;

/** The cases written in TypeScript that train; with the held-out ones, every such case. */
export const TRAIN_CASE_IDS = [
  "sketch-house",
  "variation-mangled",
  "arrange-build-drop",
  "balance-clean",
  "process-crushed",
  "density-hats",
  "develop-track-arrange",
  "full-track-empty",
  "full-tune-loop",
  "pad-genre-known",
  "sketch-whole-song",
  "resketch-extreme",
  "first-beat-lesson",
  "context-applied-snare",
  "db-nudge-down",
  "db-lower",
  "db-turn-up",
  "db-stale-cancelled",
  "basic-extend-loop",
  "basic-duplicate-chorus",
  "basic-move-bass",
  "basic-loop-bars",
  "basic-add-synth",
  "basic-add-drum-machine",
  "basic-mute-hats",
  "basic-solo-bass",
  "basic-kick-down",
  "basic-pan-guitar",
  "basic-add-clap",
  "basic-synth-to-sampler",
  "basic-add-reverb",
  "basic-remove-reverb",
  "basic-delay-before-reverb",
  "basic-reverb-send",
  "basic-transpose-melody",
  "basic-humanize-hats",
  "basic-clear-clip",
  "basic-tempo",
  "basic-undo",
  "teach-me-beat-after-chapter",
  "finish-track-new-project",
  "hook-shown",
  "key-show-me",
  "skip-names-next",
  "quiz-is-a-call",
  "under-way-question",
] as const;

const SPLITS: ReadonlyMap<string, EvalSplit> = new Map([
  ...HELDOUT_CASE_IDS.map((id) => [id, "heldout"] as const),
  ...TRAIN_CASE_IDS.map((id) => [id, "train"] as const),
]);

/** A case's split: its own `split`, else the one written here; null for a case with neither. */
export function caseSplitOrNull(
  evalCase: Pick<EvalCase, "id" | "split">,
): EvalSplit | null {
  return evalCase.split ?? SPLITS.get(evalCase.id) ?? null;
}

/** A case's split. Throws for a case that has none, which the suite never ships. */
export function caseSplit(evalCase: Pick<EvalCase, "id" | "split">): EvalSplit {
  const split = caseSplitOrNull(evalCase);
  if (split === null) {
    throw new Error(
      `Eval case "${evalCase.id}" has no split: add it to src/assistant/evals/splits.ts`,
    );
  }
  return split;
}

/** The cases of one split, in the order given. */
export function casesInSplit<Case extends Pick<EvalCase, "id" | "split">>(
  cases: readonly Case[],
  split: EvalSplit,
): Case[] {
  return cases.filter((entry) => caseSplit(entry) === split);
}
