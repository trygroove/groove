import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { TAKE_COUNT } from "../../assistant/takes";
import { PlayIcon, StopIcon } from "../../components/icons";
import { moreAfterThis } from "./cardQueue";
import { type TakesCard as Card, takesStatusText } from "./takesCardModel";
import type { AssistantTakes } from "./useAssistantTakes";

export interface TakesCardProps {
  readonly entryId: string;
  readonly takes: AssistantTakes;
  /** Whether "4 more" can ask now: not while a reply streams, nor signed out. */
  readonly canAsk: boolean;
  /** How many of the turn's cards wait behind this one (GRV-129). */
  readonly heldAfter?: number;
}

/** "4 more", as the button and the log name it. */
export const MORE_TAKES_LABEL = `${TAKE_COUNT} more`;

/** What declines every take. */
export const NO_TAKE_LABEL = "None of these";

/**
 * Four takes of a part to pick from (GRV-207), one card holding them all, the
 * way an image generator lays out its candidates: each take a row with its
 * own Hear and Use this, then "4 more" and "None of these". Hearing plays the
 * song with that take in place; only Use this changes anything.
 *
 * Once decided the card says what became of it in one line, and its takes
 * are no longer offered.
 */
export default function TakesCard(props: TakesCardProps): JSX.Element {
  let section: HTMLElement | undefined;
  const card = () => props.takes.card(props.entryId);
  const current = () => card() as Card;
  const choosing = () => current().status === "choosing";
  const open = () => {
    const status = current().status;
    return status === "choosing" || status === "stale" || status === "invalid";
  };

  /** An action that would leave focus on a button it removes hands it to the card. */
  const act = (action: () => void) => () => {
    const hadFocus = section?.contains(document.activeElement) ?? false;
    action();
    if (hadFocus) {
      setTimeout(() => {
        if (section?.isConnected && !section.contains(document.activeElement)) {
          section.focus();
        }
      }, 0);
    }
  };

  return (
    <Show when={card() !== undefined}>
      <section
        ref={section}
        class="assistant-card assistant-proposal assistant-takes"
        aria-label={`Takes: ${current().part}`}
        tabindex={-1}
      >
        <div class="assistant-proposal-head">
          <span class="assistant-entry-label">
            {current().takes.length} takes
            {current().trackName ? ` · ${current().trackName}` : ""}
          </span>{" "}
          <b>{current().part}</b>
        </div>
        <Show when={open() && current().takes.length > 0}>
          <ol class="assistant-takes-list" aria-label="Takes">
            <For each={current().takes}>
              {(take, index) => {
                const heard = () => current().hearing === index();
                return (
                  <li class={{ "assistant-take": true, "assistant-take-heard": heard() }}>
                    <button
                      type="button"
                      class="assistant-button assistant-take-hear"
                      aria-pressed={heard() ? "true" : "false"}
                      aria-label={
                        heard() ? `Stop take ${index() + 1}` : `Hear take ${index() + 1}`
                      }
                      title={
                        take.fits
                          ? "Hear it in your song"
                          : "It doesn't fit your song as it is"
                      }
                      disabled={!choosing() || !take.fits}
                      onClick={() => props.takes.hear(props.entryId, index())}
                    >
                      <Show when={heard()} fallback={<PlayIcon size={10} />}>
                        <StopIcon size={10} />
                      </Show>
                    </button>
                    <span class="assistant-take-text">
                      <span class="assistant-entry-label">Take {index() + 1}</span>{" "}
                      <span class="assistant-take-label">{take.label}</span>
                    </span>
                    <button
                      type="button"
                      class="assistant-button assistant-take-use"
                      aria-label={`Use take ${index() + 1}`}
                      disabled={!choosing() || !take.fits}
                      onClick={act(() => props.takes.pick(props.entryId, index()))}
                    >
                      Use this
                    </button>
                  </li>
                );
              }}
            </For>
          </ol>
        </Show>
        <div class="assistant-proposal-actions">
          <Show when={open()}>
            <button
              type="button"
              class="assistant-button"
              disabled={!props.canAsk || !props.takes.canMore(props.entryId)}
              onClick={act(() => props.takes.more(props.entryId))}
            >
              {MORE_TAKES_LABEL}
            </button>
            <button
              type="button"
              class="assistant-button"
              onClick={act(() => props.takes.decline(props.entryId))}
            >
              {NO_TAKE_LABEL}
            </button>
          </Show>
          <output class="assistant-proposal-say">{takesStatusText(current())}</output>
          <Show when={(props.heldAfter ?? 0) > 0}>
            <span class="assistant-card-more">{moreAfterThis(props.heldAfter ?? 0)}</span>
          </Show>
        </div>
      </section>
    </Show>
  );
}
