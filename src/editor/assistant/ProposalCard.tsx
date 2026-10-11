import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { type ControlAddress, controlKey } from "../../commands/controlAddress";
import { editorViewSpec } from "../editorViews";
import type { ProposalRow } from "./proposalCardModel";
import type { AssistantProposals, ProposalCard as Card } from "./useAssistantProposals";

export interface ProposalCardProps {
  readonly entryId: string;
  readonly proposals: AssistantProposals;
  /** Whether Refresh can ask now: not while a reply streams, nor signed out. */
  readonly canAsk: boolean;
}

/** The line under the card's buttons: where it stands, announced as it changes. */
export function proposalStatusText(card: Card): string {
  const viewLabel = (view: Card["previewView"]) =>
    view ? editorViewSpec(view).label : null;
  const say = (() => {
    switch (card.status) {
      case "pending":
        return "Nothing has changed yet.";
      case "previewing": {
        const shown = viewLabel(card.previewView);
        const back =
          card.returnView !== card.previewView ? viewLabel(card.returnView) : null;
        return `Previewing${shown ? ` in ${shown}` : ""}. Nothing is saved until you apply.${back ? ` Cancel takes you back to ${back}.` : ""}`;
      }
      case "applied":
        return card.outlined
          ? "Applied as one undo step. Changed controls are outlined."
          : "Applied as one undo step.";
      case "undone":
        return "Undone. Your song is back as it was.";
      case "cancelled":
        return "Cancelled. Nothing changed.";
      case "stale":
        return card.refreshed
          ? "Out of date. A new proposal was asked for below."
          : "Out of date. The song changed after this was written, so it can't be applied as it is.";
      case "invalid":
        return "This doesn't fit your song as it is, so it can't be applied. Nothing changed.";
    }
  })();
  return card.notice ? `${say} ${card.notice}` : say;
}

/**
 * An assistant proposal (GRV-5), after docs/assistant-panel.html: every
 * control it would change, old to new, each a link that shows the control;
 * Preview, Apply and Cancel, or Undo once applied, or Refresh once out of
 * date; and "Why this works", folded away.
 *
 * Focus never falls out of the card when its buttons change: Apply hands it
 * to Undo, and an action that leaves no button hands it to the card itself.
 */
export default function ProposalCard(props: ProposalCardProps): JSX.Element {
  let section: HTMLElement | undefined;
  const card = () => props.proposals.card(props.entryId);

  /** After the card re-renders, focus `name`'s button, or the card. */
  function focusAfter(name: string | null): void {
    setTimeout(() => {
      if (!section?.isConnected) return;
      const button = name
        ? [...section.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent?.trim() === name && !candidate.disabled,
          )
        : undefined;
      (button ?? section).focus();
    }, 0);
  }

  const act = (action: (entryId: string) => void, next: string | null) => () => {
    const hadFocus = section?.contains(document.activeElement) ?? false;
    action(props.entryId);
    if (hadFocus) focusAfter(next);
  };

  /** Preview, or, pressed again while previewing, the end of it. */
  const togglePreview = (entryId: string) =>
    card()?.status === "previewing"
      ? props.proposals.cancel(entryId)
      : props.proposals.preview(entryId);
  /** Cancel ends a preview and keeps its buttons; with none open it turns the proposal down. */
  const cancelOrDismiss = () =>
    act(props.proposals.cancel, card()?.status === "previewing" ? "Cancel" : null)();

  const count = () => card()?.rows.length ?? 0;
  // Read through an accessor inside a `Show` on whether there is a card at
  // all, so a change of status re-renders only what it changes and a button
  // keeps its focus.
  const current = () => card() as Card;
  // Which set of buttons the card offers. A memo, so a change of status that
  // keeps the same buttons (Preview to previewing) keeps the same elements.
  const offer = createMemo(() => {
    const status = card()?.status;
    return status === "pending" || status === "previewing" ? "decide" : status;
  });

  return (
    <Show when={card() !== undefined}>
      {
        <section
          ref={section}
          class="assistant-card assistant-proposal"
          aria-label={`Proposal: ${current().title}`}
          tabindex={-1}
        >
          <div class="assistant-proposal-head">
            <span class="assistant-entry-label">
              Proposal
              {count() > 0 ? ` · ${count()} ${count() === 1 ? "change" : "changes"}` : ""}{" "}
              · {current().scopeLabel}
            </span>{" "}
            <b>{current().title}</b>
          </div>
          <Show when={count() > 0}>
            <ul class="assistant-proposal-changes" aria-label="Changes">
              <For each={current().rows}>
                {(row) => (
                  <li>
                    <ControlLink
                      address={row.address}
                      label={row.label}
                      proposals={props.proposals}
                    />{" "}
                    <Values row={row} />
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <div class="assistant-proposal-actions">
            <Switch>
              <Match when={offer() === "decide"}>
                <button
                  type="button"
                  class="assistant-button"
                  aria-pressed={current().status === "previewing" ? "true" : "false"}
                  onClick={act(togglePreview, "Preview")}
                >
                  Preview
                </button>
                <button
                  type="button"
                  class="assistant-button-primary"
                  onClick={act(props.proposals.apply, "Undo")}
                >
                  Apply
                </button>
                <button type="button" class="assistant-button" onClick={cancelOrDismiss}>
                  Cancel
                </button>
              </Match>
              <Match when={offer() === "stale"}>
                <Show when={!current().refreshed}>
                  <button
                    type="button"
                    class="assistant-button-primary"
                    disabled={!props.canAsk}
                    onClick={act(props.proposals.refresh, "Dismiss")}
                  >
                    Refresh
                  </button>
                </Show>
                <button type="button" class="assistant-button" disabled>
                  Apply
                </button>
                <button
                  type="button"
                  class="assistant-button"
                  onClick={act(props.proposals.cancel, null)}
                >
                  Dismiss
                </button>
              </Match>
              <Match when={offer() === "invalid"}>
                <button
                  type="button"
                  class="assistant-button"
                  onClick={act(props.proposals.cancel, null)}
                >
                  Dismiss
                </button>
              </Match>
              <Match when={offer() === "applied"}>
                <button
                  type="button"
                  class="assistant-button"
                  onClick={act(props.proposals.undo, null)}
                >
                  Undo
                </button>
              </Match>
            </Switch>
            <output class="assistant-proposal-say">
              {proposalStatusText(current())}
            </output>
          </div>
          <Show when={current().explanation}>
            {(why) => (
              <details
                class="assistant-why"
                onToggle={(event) => {
                  // Opened at the foot of the log, it would unfold out of sight.
                  const details = event.currentTarget;
                  if (details.open && typeof details.scrollIntoView === "function") {
                    details.scrollIntoView({ block: "nearest" });
                  }
                }}
              >
                <summary>Why this works</summary>
                <dl>
                  <dt class="assistant-entry-label">Goal</dt>
                  <dd>{why().goal}</dd>
                  <dt class="assistant-entry-label">Technique</dt>
                  <dd>{why().technique}</dd>
                  <dt class="assistant-entry-label">Changed</dt>
                  <dd>
                    <For each={why().changed}>
                      {(row, index) => (
                        <>
                          {index() > 0 ? ", " : ""}
                          <ControlLink
                            address={row.address}
                            label={row.label}
                            proposals={props.proposals}
                          />
                        </>
                      )}
                    </For>
                  </dd>
                </dl>
              </details>
            )}
          </Show>
        </section>
      }
    </Show>
  );
}

/**
 * A control's name as a link: shows the control in the editor and focuses it.
 * It goes somewhere rather than doing something, so it is a link; the click
 * does the going, and its address is the control's own fragment.
 */
function ControlLink(props: {
  readonly address: ControlAddress;
  readonly label: string;
  readonly proposals: AssistantProposals;
}): JSX.Element {
  return (
    <a
      href={controlHref(props.address)}
      class="assistant-control-link"
      // Named for what it does, around the words it shows, so it is never
      // mistaken for the control itself (the header's own "Swing" button).
      aria-label={`Show ${props.label}`}
      title="Show it in the editor"
      onClick={(event) => {
        event.preventDefault();
        props.proposals.reveal(props.address);
      }}
    >
      {props.label}
    </a>
  );
}

/**
 * A control's in-page address: its entity's prefixed ID and its parameter
 * key, never a name, so a replay recording it carries no content.
 */
function controlHref(address: ControlAddress): string {
  return `#control:${encodeURIComponent(controlKey(address))}`;
}

/** "was → now", read the same way aloud: "was to now". */
function Values(props: { readonly row: ProposalRow }): JSX.Element {
  const from = () => props.row.from ?? (props.row.change === "added" ? "none" : null);
  const to = () => props.row.to ?? (props.row.change === "removed" ? "removed" : null);
  return (
    <Show when={from() !== null || to() !== null}>
      <span class="assistant-proposal-values">
        <Show when={from()}>
          {(was) => <span class="assistant-proposal-was">{was()}</span>}
        </Show>
        <Show when={from() !== null && to() !== null}>
          <span aria-hidden="true"> → </span>
          <span class="visually-hidden">to </span>
        </Show>
        <Show when={to()}>
          {(now) => <span class="assistant-proposal-now">{now()}</span>}
        </Show>
      </span>
    </Show>
  );
}
