import type { JSX } from "@solidjs/web";
import { For, flush, Match, Show, Switch } from "solid-js";
import { editorViewSpec } from "../editorViews";
import { moreAfterThis } from "./cardQueue";
import { ControlLink, Values } from "./ProposalCard";
import type { AssistantProposals } from "./useAssistantProposals";
import type {
  StreamedProposalCard as Card,
  StreamedPartLine,
} from "./useStreamedProposals";

export interface StreamedProposalCardProps {
  readonly entryId: string;
  readonly proposals: AssistantProposals;
  /** Whether Refresh and Try again can ask now: not while a reply streams, nor signed out. */
  readonly canAsk: boolean;
  /** How many of the turn's cards wait behind this one (GRV-129). */
  readonly heldAfter?: number;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The line under the card's buttons: where it stands, announced as it changes. */
export function streamedStatusText(card: Card): string {
  const parts = card.parts.filter((part) => part.status !== "invalid");
  const applied = parts.filter((part) => part.status === "applied").length;
  const stale = card.parts.some((part) => part.status === "stale");
  const withdrawn = card.parts.some((part) => part.status === "withdrawn");
  const say = (() => {
    if (card.status === "cancelled") {
      const said =
        applied > 0
          ? "Dismissed. The parts you applied stay."
          : "Cancelled. Nothing changed.";
      // A turn that failed after the card was cancelled can still be asked again.
      if (card.turn !== "failed") return said;
      return `${said} ${
        card.continued
          ? "Asked for the rest below."
          : "The rest of this proposal didn't arrive."
      }`;
    }
    if (card.status === "previewing") {
      const view = (name: Card["previewView"]) =>
        name ? editorViewSpec(name).label : null;
      const shown = view(card.previewView);
      const back = card.returnView !== card.previewView ? view(card.returnView) : null;
      return `Previewing every part not applied yet${shown ? ` in ${shown}` : ""}. Nothing is saved until you apply.${back ? ` Cancel takes you back to ${back}.` : ""}`;
    }
    const progress =
      applied === 0
        ? null
        : applied === parts.length && card.turn !== "running"
          ? appliedText(card.appliedSteps)
          : `Applied ${applied} of ${count(parts.length, "part")}${
              card.appliedSteps.some((step) => step.all)
                ? "."
                : ", each as its own undo step."
            }`;
    switch (card.turn) {
      case "running":
        return [
          progress,
          "Still writing. Apply a part as it lands, or all of them once it's done.",
        ]
          .filter(Boolean)
          .join(" ");
      case "failed":
        return [
          "The rest of this proposal didn't arrive.",
          card.continued
            ? withdrawn
              ? "Asked for the rest below, so the parts not applied here are withdrawn."
              : "Asked for the rest below."
            : null,
          progress ?? (card.continued ? null : "The parts above can still be applied."),
        ]
          .filter(Boolean)
          .join(" ");
      case "stopped":
        return [
          "Stopped before the rest arrived.",
          progress ?? "The parts above can still be applied.",
        ].join(" ");
      default:
        return progress ?? "Nothing has changed yet.";
    }
  })();
  const notes = [
    say,
    stale && card.status !== "cancelled"
      ? "Some parts are out of date: the song changed after they were written."
      : null,
    card.refreshed && card.status !== "cancelled"
      ? "A new proposal was asked for below, so the parts not applied here are withdrawn."
      : null,
    applyAllNote(card),
    card.outlined && applied > 0 ? "Changed controls are outlined." : null,
    card.notice,
  ];
  return notes.filter(Boolean).join(" ");
}

/** Every part applied, once the turn is over: how many undo steps it took. */
function appliedText(steps: Card["appliedSteps"]): string {
  if (steps.length === 1) return "Applied as one undo step.";
  const alone = steps.filter((step) => !step.all).length;
  if (alone === steps.length) return "Applied. Each part is its own undo step.";
  return `Applied in ${steps.length} undo steps: ${count(alone, "part")} on ${alone === 1 ? "its" : "their"} own, the rest with Apply all.`;
}

/** Why Apply all is off, when it is and parts are left to apply. */
function applyAllNote(card: Card): string | null {
  if (card.status === "cancelled") return null;
  switch (card.applyAllBlock) {
    case "invalid":
      return "Apply all is off because a part can't be applied; apply the others one at a time.";
    case "stale":
      return "Apply all is off while a part is out of date.";
    case "conflict":
      return "Apply all is off because the parts left no longer go in together; apply them one at a time.";
    default:
      return null;
  }
}

/**
 * A proposal that arrives part by part (GRV-144): a line per part as it
 * lands, the track and its length, each with its own Apply; Preview, Apply
 * all and Cancel for the lot; Refresh once a part is out of date, and Try
 * again when the turn failed before the rest arrived.
 *
 * Focus never falls out of the card when its buttons change: applying a part
 * hands it to the next part's Apply, and an action that leaves no button
 * hands it to the card itself.
 */
export default function StreamedProposalCard(
  props: StreamedProposalCardProps,
): JSX.Element {
  let section: HTMLElement | undefined;
  const card = () => props.proposals.streamed(props.entryId) as Card;

  /**
   * Focuses `name`'s first enabled button, or the card. The button pressed
   * may be gone (a part's Apply becomes "Applied"), so the card's update is
   * flushed first and the focus lands in the card as it now is.
   */
  function focusAfter(name: string | null): void {
    flush();
    if (!section?.isConnected) return;
    const button = name
      ? [...section.querySelectorAll<HTMLButtonElement>("button")].find(
          (candidate) => candidate.textContent?.trim() === name && !candidate.disabled,
        )
      : undefined;
    (button ?? section).focus();
  }

  const act = (action: () => void, next: string | null) => () => {
    const hadFocus = section?.contains(document.activeElement) ?? false;
    action();
    if (hadFocus) focusAfter(next);
  };

  const open = () => card().status !== "cancelled";
  const total = () => card().parts.length;
  const stale = () => card().parts.some((part) => part.status === "stale");
  const togglePreview = () =>
    card().status === "previewing"
      ? props.proposals.cancel(props.entryId)
      : props.proposals.preview(props.entryId);

  return (
    <section
      ref={section}
      class="assistant-card assistant-proposal"
      aria-label={`Proposal: ${card().title}`}
      aria-busy={card().turn === "running" ? "true" : "false"}
      tabindex={-1}
    >
      <div class="assistant-proposal-head">
        <span class="assistant-entry-label">
          Proposal · {count(total(), "part")} · {card().scopeLabel}
        </span>{" "}
        <b>{card().title}</b>
      </div>
      <ul class="assistant-proposal-parts" aria-label="Changes">
        {/* Keyed by position: a part keeps its row as the card updates. */}
        <For each={card().parts} keyed={false}>
          {(part, index) => (
            <PartRow
              entryId={props.entryId}
              part={part()}
              proposals={props.proposals}
              open={open()}
              withdrawnLabel={card().status === "cancelled" ? null : "Withdrawn"}
              onApply={act(
                () => props.proposals.applyPart(props.entryId, index),
                "Apply",
              )}
            />
          )}
        </For>
      </ul>
      <Show when={card().turn === "running" && open()}>
        <p class="assistant-proposal-arriving">More parts on the way…</p>
      </Show>
      <div class="assistant-proposal-actions">
        <Show when={open()}>
          <button
            type="button"
            class="assistant-button"
            aria-pressed={card().status === "previewing" ? "true" : "false"}
            onClick={act(togglePreview, "Preview")}
          >
            Preview
          </button>
          <button
            type="button"
            class="assistant-button-primary"
            disabled={!card().canApplyAll}
            onClick={act(() => props.proposals.apply(props.entryId), "Undo")}
          >
            Apply all
          </button>
          <Show when={card().canUndo}>
            <button
              type="button"
              class="assistant-button"
              onClick={act(() => props.proposals.undo(props.entryId), "Apply")}
            >
              Undo
            </button>
          </Show>
          <Show when={stale() && !card().refreshed}>
            <button
              type="button"
              class="assistant-button"
              disabled={!props.canAsk}
              onClick={act(() => props.proposals.refresh(props.entryId), null)}
            >
              Refresh
            </button>
          </Show>
          <button
            type="button"
            class="assistant-button"
            onClick={act(
              () => props.proposals.cancel(props.entryId),
              card().status === "previewing" ? "Cancel" : null,
            )}
          >
            Cancel
          </button>
        </Show>
        {/* Offered on a cancelled card too: its failed turn's error offers no retry of its own. */}
        <Show when={card().turn === "failed" && !card().continued}>
          <button
            type="button"
            class="assistant-button"
            disabled={!props.canAsk}
            onClick={act(() => props.proposals.continueRest(props.entryId), null)}
          >
            Try again
          </button>
        </Show>
        <output class="assistant-proposal-say">{streamedStatusText(card())}</output>
        <Show when={(props.heldAfter ?? 0) > 0}>
          <span class="assistant-card-more">{moreAfterThis(props.heldAfter ?? 0)}</span>
        </Show>
      </div>
      <Show when={card().explanation}>
        {(why) => (
          <details class="assistant-why">
            <summary>Why this works</summary>
            <dl>
              <dt class="assistant-entry-label">Goal</dt>
              <dd>{why().goal}</dd>
              <dt class="assistant-entry-label">Technique</dt>
              <dd>{why().technique}</dd>
              <Show when={why().changed.length > 0}>
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
              </Show>
            </dl>
          </details>
        )}
      </Show>
    </section>
  );
}

/** One part's line: what it makes, and its Apply or where it stands. */
function PartRow(props: {
  readonly entryId: string;
  readonly part: StreamedPartLine;
  readonly proposals: Pick<AssistantProposals, "reveal">;
  readonly open: boolean;
  /** What a withdrawn part says, or null to say nothing (a cancelled card). */
  readonly withdrawnLabel: string | null;
  readonly onApply: () => void;
}): JSX.Element {
  const needsId = () => `${props.entryId}-part-${props.part.index}-needs`;
  return (
    <li
      class={{
        "assistant-proposal-part": true,
        "assistant-proposal-part-done": props.part.status === "applied",
      }}
    >
      <span class="assistant-proposal-part-text">
        <Show when={props.part.rows.length > 0} fallback={props.part.text}>
          <For each={props.part.rows}>
            {(row, index) => (
              <>
                {index() > 0 ? ", " : ""}
                <ControlLink
                  address={row.address}
                  label={row.label}
                  proposals={props.proposals}
                />{" "}
                <Values row={row} />
              </>
            )}
          </For>
        </Show>
      </span>
      <Switch>
        <Match when={props.part.status === "applied"}>
          <span class="assistant-proposal-part-state">Applied</span>
        </Match>
        <Match when={props.part.status === "stale"}>
          <span class="assistant-proposal-part-state">Out of date</span>
        </Match>
        <Match when={props.part.status === "withdrawn"}>
          <Show when={props.withdrawnLabel}>
            {(label) => <span class="assistant-proposal-part-state">{label()}</span>}
          </Show>
        </Match>
        <Match when={props.part.status === "invalid"}>
          <span class="assistant-proposal-part-state">Can't apply</span>
          <span class="assistant-proposal-part-note">{props.part.reason}</span>
        </Match>
        <Match when={props.open}>
          <button
            type="button"
            class="assistant-button assistant-proposal-part-apply"
            aria-label={`Apply ${props.part.text}`}
            aria-describedby={props.part.needs ? needsId() : undefined}
            disabled={props.part.status !== "ready"}
            onClick={() => props.onApply()}
          >
            Apply
          </button>
          <Show when={props.part.needs}>
            {(needs) => (
              <span id={needsId()} class="assistant-proposal-part-note">
                Needs {needs()} first
              </span>
            )}
          </Show>
        </Match>
      </Switch>
    </li>
  );
}
