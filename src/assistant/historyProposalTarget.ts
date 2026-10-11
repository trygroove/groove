// A bare `CommandHistory` as an assistant proposal target.
//
// The editor hands the executor its session (`src/editor/assistantProposalTarget.ts`)
// so a proposal is autosaved; the executor's own tests and the assistant evals
// (`src/assistant/evals/checks.ts`) only need the history.

import type { CommandHistory } from "../commands";
import type { ProposalTarget } from "./proposalExecutor";

export function historyProposalTarget(history: CommandHistory): ProposalTarget {
  return {
    get project() {
      return history.project;
    },
    get gestureActive() {
      return history.gestureActive;
    },
    get latestCorrelationId() {
      return history.entries[history.entries.length - 1]?.correlationId ?? null;
    },
    execute: (commands, options) => history.execute(commands, options),
    undo: () => history.undo(),
  };
}
