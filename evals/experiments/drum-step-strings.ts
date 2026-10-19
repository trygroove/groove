/**
 * GRV-140: does writing a drum pad's part as one repeating step string,
 * rather than one tuple per hit, cut the heavy turns' output tokens without
 * costing quality? `bun run assistant:experiment -- drum-step-strings`.
 */
import { defineExperiment } from "../../src/assistant/evals/experiment";

export default defineExperiment({
  id: "drum-step-strings",
  card: "GRV-140",
  hypothesis:
    "Drum parts written as one step string per pad make the heavy sketches and arrangements cost fewer output tokens, with no loss of quality.",
  variants: { "step-strings": { drumStepStrings: "on" } },
  goal: "outputTokens",
  cases: { set: "heavyOutput" },
});
