/**
 * GRV-131, plan step 3: does letting the model reuse a clip (place it again
 * by bars, copy it as a variation, duplicate notes without making their IDs)
 * rather than write its notes again cut the heavy turns' output tokens
 * without costing quality? The second variant stacks it on the two note
 * forms (GRV-140's step strings and GRV-141's generators), the other levers
 * on output, to see whether they add up.
 * `bun run assistant:experiment -- clip-reuse`.
 *
 * Check 6 (extreme is not flattened) is a guardrail here, as for the
 * generators: a variation built as a copy of the original must not pull an
 * extreme request back to the conventional answer. Each phase runs its
 * check-6 block for it; the goal stays the heavy cases' output tokens.
 */
import { defineExperiment } from "../../src/assistant/evals/experiment";

export default defineExperiment({
  id: "clip-reuse",
  card: "GRV-131",
  hypothesis:
    "Reusing clips (placements by bars, copies as variations) instead of writing their notes again makes the heavy sketches and arrangements cost fewer output tokens, with no loss of quality and no extreme request flattened.",
  variants: {
    // The note forms named off, so the two variants stay apart even once
    // either has won and is on by default.
    reuse: { clipReuse: "on", drumStepStrings: "off", patternGenerators: "off" },
    "reuse-note-forms": {
      clipReuse: "on",
      drumStepStrings: "on",
      patternGenerators: "on",
    },
  },
  goal: "outputTokens",
  cases: { set: "heavyOutput" },
  guardrails: { holdNotFlattened: true },
});
