/**
 * GRV-141: does naming common patterns (four on the floor, hats, a backbeat,
 * a Euclidean rhythm, an arpeggio, stabs, a root bass) and letting the
 * gateway write their notes cut the heavy turns' output tokens without
 * costing quality? Generators with step strings (GRV-140) are the third
 * variant, since the drum generators are step strings underneath.
 * `bun run assistant:experiment -- pattern-generators`.
 *
 * Check 6 (extreme is not flattened) is a guardrail here, held to no drop at
 * all: generators must not make every sketch sound the same.
 */
import { defineExperiment } from "../../src/assistant/evals/experiment";

export default defineExperiment({
  id: "pattern-generators",
  card: "GRV-141",
  hypothesis:
    "Pattern generators the model asks for by intent make the heavy sketches and arrangements cost fewer output tokens, with no loss of quality and no extreme request flattened into the conventional answer.",
  variants: {
    // Step strings named off, so the two variants stay apart even once
    // drum-step-strings (GRV-140) has turned them on by default.
    generators: { patternGenerators: "on", drumStepStrings: "off" },
    "generators-step-strings": { patternGenerators: "on", drumStepStrings: "on" },
  },
  goal: "outputTokens",
  cases: { set: "heavyOutput" },
  guardrails: { maxNotFlattenedDropPoints: 0 },
});
