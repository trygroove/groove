/**
 * The framework's first real experiment (GRV-110): does thinking at low
 * effort cut the heavy turns' output tokens without costing quality?
 * `bun run assistant:experiment -- thinking-effort-low`.
 */
import { defineExperiment } from "../../src/assistant/evals/experiment";

export default defineExperiment({
  id: "thinking-effort-low",
  card: "GRV-110",
  hypothesis:
    "Thinking at low effort writes the heavy sketches and arrangements in fewer output tokens, with no loss of quality.",
  variants: { low: { thinkingEffort: "low" } },
  goal: "outputTokens",
  cases: { set: "heavyOutput" },
});
