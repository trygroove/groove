/**
 * GRV-145: does guiding a large, open request through several short
 * proposals, each ending with a question about the next step, build the
 * whole track a single turn could not? `develop-track-arrange` spent 14k
 * output tokens a turn, once ran out of room, and never passed check 11.
 * Its session cases run as conversations with a scripted producer
 * (`src/assistant/evals/session.ts`), judged on the song they end with; the
 * rest of the suite runs as usual under the default bar.
 * `bun run assistant:experiment -- guided-build`.
 */
import { defineExperiment } from "../../src/assistant/evals/experiment";

export default defineExperiment({
  id: "guided-build",
  card: "GRV-145",
  hypothesis:
    "Building a large, open request over several short proposals, each ending with a question about the next step, develops it into a whole track without running out of room, so the session cases pass more checks.",
  variants: { guided: { guidedBuild: "on" } },
  goal: "quality",
  cases: "all",
  focus: ["develop-track-arrange", "full-track-empty", "full-tune-loop"],
  guardrails: {
    noMaxTokens: true,
    outputTokensPerTurn: true,
    everyTurnChecks: ["noEmptyClips", "clipsPlaced"],
  },
  budget: 40,
});
