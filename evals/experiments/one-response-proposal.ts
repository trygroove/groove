/**
 * GRV-142: does writing a whole proposal in one response, rather than a part
 * a step, cut the heavy turns' latency without costing quality? A sketch
 * made 5 or 6 model calls one after another, each a full round trip.
 * `bun run assistant:experiment -- one-response-proposal`.
 */
import { defineExperiment } from "../../src/assistant/evals/experiment";

export default defineExperiment({
  id: "one-response-proposal",
  card: "GRV-142",
  hypothesis:
    "Writing every change call of a proposal in one response takes the heavy sketches and arrangements in fewer model calls, so their latency p50 falls, with no loss of quality and no more replies cut off at max_tokens.",
  variants: { "one-response": { oneResponseProposal: "on" } },
  goal: "latencyP50",
  cases: { set: "heavyOutput" },
});
