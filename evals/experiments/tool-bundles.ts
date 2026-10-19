/**
 * GRV-143: does offering each turn a smaller, fixed bundle of tools reach
 * the first word sooner? The tool definitions are the largest fixed block in
 * every model call, and a mixing tweak pays for every note tool. A gateway
 * rule picks the bundle (mix, notes, arrange or everything) from the scope,
 * the selected track and the message, and a bundle that is not enough asks
 * for every tool with need_more_tools. The report gives the bundle chosen per
 * case, how often a turn fell back, and cache reads and writes per turn.
 * `bun run assistant:experiment -- tool-bundles`.
 */
import { defineExperiment } from "../../src/assistant/evals/experiment";

export default defineExperiment({
  id: "tool-bundles",
  card: "GRV-143",
  hypothesis:
    "A fixed bundle of tools picked for each turn, with every tool a need_more_tools call away, reaches the first word sooner, with no loss of quality.",
  variants: { bundled: { toolBundles: "bundled" } },
  goal: "firstTextP50",
  cases: "all",
});
