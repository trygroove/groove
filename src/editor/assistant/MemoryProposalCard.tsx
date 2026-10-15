import type { JSX } from "@solidjs/web";
import { Match, Show, Switch } from "solid-js";
import { ASSISTANT_NAME } from "../../../site.config.mjs";
import { describeProposal } from "../../memory/memoryEdits";
import type { AssistantMemoryProposals } from "./useMemoryProposals";

export interface MemoryProposalCardProps {
  readonly entryId: string;
  readonly memory: AssistantMemoryProposals;
}

/** The card's accessible name. */
export const MEMORY_CARD_LABEL = "Remember this?";

/**
 * Something Cue proposes remembering about the producer (GRV-25): what it
 * would remember, with Remember and Not now. Once remembered it shrinks to a
 * receipt line, "Saved to memory", with Undo; nothing is ever saved without
 * the press.
 */
export default function MemoryProposalCard(props: MemoryProposalCardProps): JSX.Element {
  const card = () => props.memory.state(props.entryId);
  const what = () => {
    const current = card();
    return current ? describeProposal(current.proposal) : "";
  };
  return (
    <Show when={card()}>
      {(current) => (
        <section class="assistant-card memory-proposal" aria-label={MEMORY_CARD_LABEL}>
          <Switch>
            <Match
              when={current().status === "proposed" || current().status === "failed"}
            >
              <b>Remember this?</b>
              <span>{what()}</span>
              <Show when={current().status === "failed"}>
                <output class="memory-proposal-status">
                  Couldn't save to memory. Try again.
                </output>
              </Show>
              <div class="memory-proposal-actions">
                <button
                  type="button"
                  class="assistant-button-primary"
                  onClick={() => void props.memory.confirm(props.entryId)}
                >
                  Remember
                </button>
                <button
                  type="button"
                  class="memory-proposal-secondary"
                  onClick={() => props.memory.dismiss(props.entryId)}
                >
                  Not now
                </button>
              </div>
            </Match>
            <Match when={current().status === "saving"}>
              <output class="memory-proposal-status">Saving to memory…</output>
            </Match>
            <Match when={current().status === "saved" || current().status === "undoing"}>
              <div class="memory-proposal-receipt">
                <output class="memory-proposal-status">Saved to memory: {what()}</output>
                <button
                  type="button"
                  class="memory-proposal-secondary"
                  disabled={current().status === "undoing"}
                  onClick={() => void props.memory.undo(props.entryId)}
                >
                  Undo
                </button>
              </div>
            </Match>
            <Match when={current().status === "undone"}>
              <output class="memory-proposal-status">
                Undone. {ASSISTANT_NAME} won't remember {what()}.
              </output>
            </Match>
            <Match when={current().status === "dismissed"}>
              <output class="memory-proposal-status">Not remembered.</output>
            </Match>
          </Switch>
        </section>
      )}
    </Show>
  );
}
