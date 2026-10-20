/**
 * The editor session as the assistant's proposal target (GRV-4).
 *
 * An applied proposal and its undo go through the session, not the history
 * underneath it, so they are autosaved, counted towards `first_edit` and end
 * an open preview exactly as a manual edit or undo does.
 */
import type { ProposalTarget } from "../assistant/proposalExecutor";
import type { EditorSession } from "./EditorSession";

export function assistantProposalTarget(session: EditorSession): ProposalTarget {
  return {
    get project() {
      return session.committedProject;
    },
    get gestureActive() {
      return session.gestureActive;
    },
    get latestCorrelationId() {
      return session.latestCorrelationId;
    },
    commandTypesSince: (revision) => session.commandTypesSince(revision),
    execute: (commands, options) => session.dispatch(commands, options),
    undo: () => session.undo("assistant"),
  };
}
