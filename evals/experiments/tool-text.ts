/**
 * GRV-146: do shorter tool definitions cut the time to the first word?
 * The 37 tool definitions are the largest fixed block in every model call, so
 * trimming their text (and saying the rules many tools repeat once, in the
 * prompt) should cut time to first token and cache cost on every turn.
 * `bun run assistant:experiment -- tool-text`.
 *
 * The winner is the shortest level that wins and holds the bar. If
 * `aggressive` loses quality, the card names the tools whose text was cut too
 * far, for a second pass.
 */
import { defineExperiment } from "../../src/assistant/evals/experiment";

export default defineExperiment({
  id: "tool-text",
  card: "GRV-146",
  hypothesis:
    "Trimmed tool definition text, with the repeated rules said once in the prompt, reaches the first word sooner and costs less per turn, with no loss of quality.",
  variants: {
    moderate: { toolText: "moderate" },
    aggressive: { toolText: "aggressive" },
  },
  goal: "firstTextP50",
  cases: "all",
});
