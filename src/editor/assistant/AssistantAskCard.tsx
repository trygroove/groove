import type { JSX } from "@solidjs/web";
import { createEffect, For, onCleanup, Show, untrack } from "solid-js";
import { ASSISTANT_NAME } from "../../../site.config.mjs";
import { ASK_LIMITS } from "../../assistant/ask";
import { CloseIcon } from "../../components/icons";

/** A small speaker: the option has a sound to hear. */
function SpeakerGlyph(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 3.5h2L5.5 1.5v7L3 6.5H1z" fill="currentColor" />
      <path d="M7 3a2.5 2.5 0 0 1 0 4" fill="none" stroke="currentColor" />
    </svg>
  );
}

import type { AskDraft } from "./useAssistantChat";
import type { PendingAsk } from "./useAssistantConversation";

export interface AssistantAskCardProps {
  readonly pending: PendingAsk;
  readonly draft: AskDraft;
  /** Whether a reply is on its way, so nothing can be answered yet. */
  readonly streaming: boolean;
  /** Bound to the "something else" box, where Enter sends (`assistant.send`). */
  bindText(element: HTMLElement | undefined): void;
  /**
   * Whether focus should come to the question when it arrives: the producer
   * is in an empty composer, waiting, rather than writing something else.
   */
  takeFocus(): boolean;
  /**
   * What the "something else" box is called when a question means something
   * more particular by it (onboarding's "Artists you love", GRV-25).
   */
  readonly textLabel?: string;
  /**
   * A worded way to put the question away, in place of the close icon
   * (onboarding's "Skip this question", GRV-25).
   */
  readonly skipLabel?: string;
  /**
   * Whether the card offers its option keys: the chips' `1`-`8` badges, their
   * `aria-keyshortcuts`, and the keys line under them. Only the editor's
   * shortcut layer answers those keys, so the welcome (GRV-25), where only
   * Enter in the text box works, leaves them all out.
   */
  readonly keyHint?: boolean;
}

/** The card's accessible name. */
export const ASK_CARD_LABEL = `${ASSISTANT_NAME} asks`;

/** What the "something else" box is called, and says when empty. */
export const ASK_TEXT_LABEL = "Something else";

/** The keys line under a question: its digits run as far as its options. */
export function askHint(count: number, multiSelect: boolean): string {
  const keys = count > 1 ? `1–${count}` : "1";
  return multiSelect
    ? `Pick any · ${keys} toggle · Enter sends`
    : `Pick one · ${keys} picks`;
}

/**
 * A question the assistant asks the producer (GRV-42), above the composer:
 * a header line when the question says what it is about, the question, its
 * options as square chips in a wrap with the suggested one marked, and a
 * "something else" box with Send.
 *
 * A single choice answers on a click; several toggle and go with Send. An
 * option about a part of the song says which, and shows it in the editor
 * while it is hovered or focused; an option with a sound plays it while it is
 * hovered. The keys are not read here: `1`-`8`, Enter and Space are the
 * registry's (`assistant.ask_option_*`, `assistant.ask_finish`,
 * `assistant.ask_hear`), live while focus is in the panel outside a text box,
 * so the chips only number themselves.
 */
export default function AssistantAskCard(props: AssistantAskCardProps): JSX.Element {
  const ask = () => props.pending.ask;
  const questionId = () => `assistant-ask-${ask().id}`;
  const keyHint = () => props.keyHint ?? true;
  let card: HTMLElement | undefined;
  /** The chip a pointer went down on, so the focus that follows is known as a click's. */
  let pressed: number | null = null;

  // A new question takes focus from an empty composer, so its keys work at
  // once. The question's ID is the one reactive read: the draft is read once,
  // as the question arrives, so emptying the composer later never pulls
  // focus. Focus is a DOM write, so it is the apply half's.
  createEffect(
    () => ask().id,
    () => {
      if (untrack(() => props.takeFocus())) card?.focus();
    },
  );

  return (
    <section
      ref={card}
      class="assistant-ask"
      aria-label={ASK_CARD_LABEL}
      aria-describedby={questionId()}
      tabindex={-1}
    >
      <div class="assistant-ask-head">
        <span class="assistant-entry-label">{ask().context ?? "Question"}</span>
        <Show
          when={props.skipLabel}
          fallback={
            <button
              type="button"
              class="assistant-ask-dismiss"
              aria-label="Dismiss the question"
              title="Dismiss the question"
              onClick={() => props.draft.dismiss()}
            >
              <CloseIcon size={12} />
            </button>
          }
        >
          {(label) => (
            <button
              type="button"
              class="assistant-ask-skip"
              disabled={props.streaming}
              onClick={() => props.draft.dismiss()}
            >
              {label()}
            </button>
          )}
        </Show>
      </div>
      <p id={questionId()} class="assistant-ask-question">
        {ask().question}
      </p>
      {/* Leaving the options puts away whatever they show, even when a chip
          missed its own pointerleave (disabled while a reply streams, or
          redrawn under the pointer). */}
      <fieldset
        class="assistant-ask-options"
        aria-labelledby={questionId()}
        onPointerLeave={() => props.draft.hover(null)}
      >
        <For each={ask().options}>
          {(option, index) => {
            const suggested = () => ask().suggested === index();
            const picked = () => props.draft.picked().includes(index());
            const part = (name: string) => `${questionId()}-${index()}-${name}`;
            // The label names the chip; the rest describes it. Referenced by
            // ID, so none of the question's own words sits in an attribute.
            const about = () => props.draft.about(index());
            const audible = () => props.draft.canHear(index());
            // A chip that goes while hovered or focused (the question
            // replaced, the options redrawn under a still pointer) gets no
            // pointerleave or blur, so it puts its own highlight away.
            onCleanup(() =>
              untrack(() => {
                props.draft.unhover(index());
                props.draft.unfocus(index());
              }),
            );
            const described = () =>
              [
                option.description ? part("description") : "",
                about() ? part("about") : "",
                audible() ? part("audible") : "",
                suggested() ? part("suggested") : "",
              ]
                .filter((id) => id.length > 0)
                .join(" ") || undefined;
            return (
              <button
                type="button"
                class={[
                  "assistant-ask-option",
                  {
                    "assistant-ask-suggested-option": suggested(),
                    "assistant-ask-audible-option": audible(),
                  },
                ]}
                aria-pressed={
                  ask().multiSelect ? (picked() ? "true" : "false") : undefined
                }
                aria-keyshortcuts={keyHint() ? String(index() + 1) : undefined}
                aria-labelledby={part("label")}
                aria-describedby={described()}
                disabled={props.streaming}
                onClick={() => props.draft.pick(index())}
                onPointerEnter={() => props.draft.hover(index())}
                onPointerLeave={() => {
                  pressed = null;
                  props.draft.unhover(index());
                }}
                onPointerDown={() => {
                  pressed = index();
                }}
                onFocus={() => {
                  // Focus a click gave the chip shows nothing of its own: the
                  // hover already shows it, and it must go with the pointer.
                  props.draft.focus(index(), pressed !== index());
                  pressed = null;
                }}
                onBlur={() => props.draft.unfocus(index())}
              >
                <Show when={keyHint()}>
                  <span class="assistant-ask-key" aria-hidden="true">
                    {index() + 1}
                  </span>
                </Show>
                <span class="assistant-ask-text">
                  <span id={part("label")} class="assistant-ask-label">
                    {option.label}
                  </span>
                  <Show when={option.description}>
                    {(description) => (
                      <span
                        id={part("description")}
                        class="assistant-ask-description"
                        aria-hidden="true"
                      >
                        {description()}
                      </span>
                    )}
                  </Show>
                  <Show when={about()}>
                    {(text) => (
                      <span
                        id={part("about")}
                        class="assistant-ask-about"
                        aria-hidden="true"
                      >
                        {text()}
                      </span>
                    )}
                  </Show>
                </span>
                <Show when={audible()}>
                  <span
                    id={part("audible")}
                    class="assistant-ask-listen"
                    title="Hover, or focus and press Space, to hear it"
                    aria-hidden="true"
                  >
                    <SpeakerGlyph />
                    <span class="visually-hidden">Hover or press Space to hear it</span>
                  </span>
                </Show>
                <Show when={suggested()}>
                  <span
                    id={part("suggested")}
                    class="assistant-ask-suggested"
                    aria-hidden="true"
                  >
                    Suggested
                  </span>
                </Show>
              </button>
            );
          }}
        </For>
      </fieldset>
      <div class="assistant-ask-other">
        <input
          ref={(element) => props.bindText(element)}
          type="text"
          class="assistant-ask-input"
          aria-label={props.textLabel ?? ASK_TEXT_LABEL}
          placeholder={`${props.textLabel ?? ASK_TEXT_LABEL}…`}
          maxlength={ASK_LIMITS.answerChars}
          value={props.draft.text()}
          disabled={props.streaming}
          onInput={(event) => props.draft.setText(event.currentTarget.value)}
        />
        <button
          type="button"
          class="assistant-button-primary"
          aria-label="Send the answer"
          disabled={!props.draft.canFinish()}
          onClick={() => props.draft.finish()}
        >
          Send
        </button>
      </div>
      <Show when={keyHint()}>
        <span class="assistant-composer-hint assistant-ask-hint">
          {askHint(ask().options.length, ask().multiSelect)}
        </span>
      </Show>
    </section>
  );
}
