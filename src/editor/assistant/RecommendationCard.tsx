import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { PlayIcon, StopIcon } from "../../components/icons";
import PackCover from "../../library/PackCover";
import { editorViewSpec } from "../editorViews";
import { ERROR_HEADING, ERROR_REASSURANCE } from "./assistantErrorCopy";
import type {
  AssistantRecommendations,
  RecommendationCard as Card,
} from "./useAssistantRecommendations";

export interface RecommendationCardProps {
  readonly entryId: string;
  readonly recommendations: AssistantRecommendations;
  /** Whether Refresh can ask now: not while a reply streams, nor signed out. */
  readonly canAsk: boolean;
}

/** What a failed recommendation says, under the conversation's error heading. */
export const REFUSED_RECOMMENDATION =
  "It recommended a sound the library doesn't have, so there's nothing to try.";

/** The status line for a pack the project uses, and for one it does not yet. */
export const PACK_IN_PROJECT = "In this project";
export const PACK_JOINS = "Joins the project when you keep a sound";

/** The line under the card's buttons: where it stands, announced as it changes. */
export function recommendationStatusText(card: Card): string {
  const slot = card.slot?.label ?? null;
  const sound = card.sound?.name ?? null;
  const say = (() => {
    switch (card.status) {
      case "ready":
        return slot && sound
          ? `Nothing has changed yet. Try ${sound} on ${slot} to hear it in the beat.`
          : "Nothing has changed yet. Select a drum pad or a sampler to try one of these in the beat.";
      case "trying": {
        const back = card.returnView
          ? ` Put back takes you back to ${editorViewSpec(card.returnView).label}.`
          : "";
        return card.keeping
          ? `Keeping ${sound} on ${slot}…`
          : `${slot} is trying ${sound}. Play to hear it in the beat. Nothing is saved until you keep it.${back}`;
      }
      case "kept":
        return `Kept. ${slot} plays ${sound} now, as one undo step.`;
      case "undone":
        return `Undone. ${slot} has its own sound back.`;
      case "put-back":
        return `Put back. ${slot} has its own sound back, and nothing changed.`;
      case "stale":
        if (card.refreshed)
          return "Out of date. A new recommendation was asked for below.";
        return card.staleBecause === "missing"
          ? `Out of date. ${slot ?? "The slot"} is no longer in the song, so there's nothing to try these on. Nothing changed.`
          : `Out of date. ${slot ?? "The slot"} changed while a sound was being tried, so its own sound is back.`;
      case "dismissed":
        return "Dismissed. Nothing changed.";
      case "invalid":
        return REFUSED_RECOMMENDATION;
    }
  })();
  return card.notice ? `${say} ${card.notice}` : say;
}

/**
 * A recommended pack (GRV-23), after the *Recommend a pack* step of
 * docs/assistant-panel.html: the pack's cover as the library draws it, its
 * name, publisher, version and size, a line on why it fits and whether it is
 * the project's already; up to three of its sounds, each with a button to hear
 * it; and Try on ‹slot›, then Keep or Put back, then Undo; Pack demo; and Open
 * in library.
 *
 * Focus never falls out of the card when its buttons change, as on a proposal
 * (GRV-5): Try hands it to Keep, Keep to Undo (or keeps it on Keep when the
 * keep could not be done), and Put back or Undo to Try.
 */
export default function RecommendationCard(props: RecommendationCardProps): JSX.Element {
  let section: HTMLElement | undefined;
  const card = () => props.recommendations.card(props.entryId);
  // Read inside a `Show` on whether there is a card at all, so a change of
  // status re-renders only what it changes and a button keeps its focus.
  const current = () => card() as Card;

  /**
   * After the card re-renders, focus the first enabled button whose name starts
   * with one of `names`, in that order, or the card.
   */
  function focusAfter(names: readonly string[]): void {
    setTimeout(() => {
      if (!section?.isConnected) return;
      const buttons = [...section.querySelectorAll<HTMLButtonElement>("button")];
      const button = names
        .map((name) =>
          buttons.find(
            (candidate) =>
              candidate.textContent?.trim().startsWith(name) && !candidate.disabled,
          ),
        )
        .find((found) => found !== undefined);
      (button ?? section).focus();
    }, 0);
  }

  const act =
    (action: (entryId: string) => unknown, ...next: string[]) =>
    () => {
      const hadFocus = section?.contains(document.activeElement) ?? false;
      const done = action(props.entryId);
      if (!hadFocus) return;
      if (done instanceof Promise) void done.then(() => focusAfter(next));
      else focusAfter(next);
    };

  const tryLabel = () => `Try on ${current().slot?.label ?? ""}`;
  // Which set of buttons the card offers. A memo, so a change of status that
  // keeps the same buttons keeps the same elements.
  const offer = createMemo(() => {
    const status = card()?.status;
    if (status === "put-back" || status === "undone") return "ready";
    return status;
  });
  const recommendation = () => current().recommendation;

  return (
    <Show when={card() !== undefined}>
      <Show
        when={recommendation()}
        fallback={
          <div class="assistant-error" role="alert">
            <b>{ERROR_HEADING}</b>
            <span>
              {REFUSED_RECOMMENDATION} {ERROR_REASSURANCE}
            </span>
          </div>
        }
      >
        {(found) => (
          <section
            ref={section}
            class="assistant-card assistant-proposal assistant-recommendation"
            aria-label={`Recommended pack: ${found().pack.name}`}
            tabindex={-1}
          >
            <div class="assistant-proposal-head">
              <span class="assistant-entry-label">
                Recommended pack · {current().scopeLabel}
              </span>
            </div>
            <div class="assistant-pack-top">
              <PackCover name={found().pack.name} assets={found().packSounds} small />
              <div class="assistant-pack-about">
                <b class="assistant-pack-name">{found().pack.name}</b>
                <p class="assistant-pack-why">{found().reason}</p>
                <div class="assistant-pack-meta">
                  <span class="assistant-pack-status">
                    {props.recommendations.packInProject(props.entryId)
                      ? PACK_IN_PROJECT
                      : PACK_JOINS}
                  </span>{" "}
                  <span class="assistant-entry-label">
                    {found().pack.publisher} · {found().pack.version} ·{" "}
                    {found().pack.assetCount}{" "}
                    {found().pack.assetCount === 1 ? "sound" : "sounds"}
                  </span>
                </div>
              </div>
            </div>
            <ul class="assistant-pack-sounds" aria-label="Sounds">
              <For each={found().sounds}>
                {(sound) => (
                  <li>
                    <button
                      type="button"
                      class="assistant-pack-hear"
                      aria-label={`Hear ${sound.name}`}
                      title={`Hear ${sound.name} on its own`}
                      onClick={() => props.recommendations.hear(props.entryId, sound.id)}
                    >
                      <PlayIcon size={10} />
                    </button>
                    <span class="assistant-pack-sound">
                      <b>{sound.name}</b>{" "}
                      <small>
                        {sound.packName} · {sound.role}
                      </small>
                    </span>
                  </li>
                )}
              </For>
            </ul>
            <div class="assistant-proposal-actions">
              <Switch>
                <Match when={offer() === "ready" && current().slot && current().sound}>
                  <button
                    type="button"
                    class="assistant-button-primary"
                    onClick={act(props.recommendations.tryOn, "Keep")}
                  >
                    {tryLabel()}
                  </button>
                </Match>
                <Match when={offer() === "trying"}>
                  <button
                    type="button"
                    class="assistant-button-primary"
                    disabled={current().keeping}
                    // A Keep that could not be done leaves Keep and Put back.
                    onClick={act(props.recommendations.keep, "Undo", "Keep", "Put back")}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    class="assistant-button"
                    disabled={current().keeping}
                    onClick={act(props.recommendations.putBack, "Try on")}
                  >
                    Put back
                  </button>
                </Match>
                <Match when={offer() === "kept"}>
                  <button
                    type="button"
                    class="assistant-button"
                    onClick={act(props.recommendations.undo, "Try on")}
                  >
                    Undo
                  </button>
                </Match>
                <Match when={offer() === "stale"}>
                  <Show when={!current().refreshed}>
                    <button
                      type="button"
                      class="assistant-button-primary"
                      disabled={!props.canAsk}
                      onClick={act(props.recommendations.refresh, "Dismiss")}
                    >
                      Refresh
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="assistant-button"
                    onClick={act(props.recommendations.dismiss)}
                  >
                    Dismiss
                  </button>
                </Match>
              </Switch>
              <button
                type="button"
                class="assistant-button"
                aria-pressed={
                  props.recommendations.demoing() === props.entryId ? "true" : "false"
                }
                onClick={() => props.recommendations.toggleDemo(props.entryId)}
              >
                <Show
                  when={props.recommendations.demoing() === props.entryId}
                  fallback={<PlayIcon size={10} />}
                >
                  <StopIcon size={10} />
                </Show>{" "}
                Pack demo
              </button>
              <button
                type="button"
                class="assistant-button"
                onClick={() => props.recommendations.openInLibrary(props.entryId)}
              >
                Open in library
              </button>
              <output class="assistant-proposal-say">
                {recommendationStatusText(current())}
              </output>
            </div>
          </section>
        )}
      </Show>
    </Show>
  );
}
