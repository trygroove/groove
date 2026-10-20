/**
 * GRV-147: does a shorter system prompt reach the first word sooner? The
 * fixed prompt is about 20k characters, read on every model call, and grew
 * one rule at a time, so some rules may say the same thing twice or no longer
 * change what the model does.
 * `bun run assistant:experiment -- prompt-text`.
 *
 * - `moderate` and `aggressive` reword every rule (`promptText`); the text
 *   winner is the shortest level that wins and holds the bar.
 * - Each `drop-*` variant is a cut that leaves out one rule group
 *   (`promptDrop*`). A cut that holds the bar is removed for good, even if
 *   the goal does not move beyond noise, because less text is the point; the
 *   cuts that hold are run once more together.
 * - No variant combines `moderate` with a trimmed `toolText`: GRV-146's
 *   `tool-text` experiment found no win, so `full` stays the tools' level.
 *
 * If a level or a cut loses quality, the card names the rules most likely
 * behind it.
 *
 * Its first run on main (Actions run 39249960804) had every call refused with
 * HTTP 400, the control's too, though the request was the same one that had
 * just run fine: the API had stopped taking the account's calls an hour
 * earlier, partway through `tool-bundles`. It runs again once that is cleared,
 * and an errored turn now says what the API gave as its reason.
 */
import { defineExperiment } from "../../src/assistant/evals/experiment";

export default defineExperiment({
  id: "prompt-text",
  card: "GRV-147",
  hypothesis:
    "A system prompt reworded shorter, or without rule groups that are outdated or said elsewhere, reaches the first word sooner and costs less per turn, with no loss of quality.",
  variants: {
    moderate: { promptText: "moderate" },
    aggressive: { promptText: "aggressive" },
    "drop-app-features": { kind: "cut", tactics: { promptDropAppFeatures: "drop" } },
    "drop-tool-addressing": {
      kind: "cut",
      tactics: { promptDropToolAddressing: "drop" },
    },
    "drop-stale-description": {
      kind: "cut",
      tactics: { promptDropStaleDescription: "drop" },
    },
    "drop-drum-sound-pads": {
      kind: "cut",
      tactics: { promptDropDrumSoundPads: "drop" },
    },
  },
  goal: "firstTextP50",
  cases: "all",
  budget: 60,
});
