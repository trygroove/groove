import { Errored, type JSX } from "@solidjs/web";
import { createEffect, For, Match, onSettled, Show, Switch } from "solid-js";
import { ASSISTANT_NAME } from "../../../site.config.mjs";
import { SendIcon, SparkIcon, StopIcon } from "../../components/icons";
import AssistantAskCard from "./AssistantAskCard";
import {
  RETENTION_LOADING,
  RetentionDisclosure,
  RetentionSettings,
} from "./AssistantRetention";
import { ERROR_HEADING, ERROR_REASSURANCE, errorMessage } from "./assistantErrorCopy";
import { skippedLine } from "./cardQueue";
import { fitComposer } from "./composerHeight";
import MemoryProposalCard from "./MemoryProposalCard";
import ProposalCard from "./ProposalCard";
import RecommendationCard from "./RecommendationCard";
import ReplyRating from "./ReplyRating";
import StreamedProposalCard from "./StreamedProposalCard";
import type { AssistantChat } from "./useAssistantChat";
import { type ConversationEntry, MAX_MESSAGE_CHARS } from "./useAssistantConversation";
import VideoCard from "./VideoCard";

export interface AssistantChatViewProps {
  readonly chat: AssistantChat;
  /** Bound to the composer, so the panel opens ready to type into. */
  bindComposer(element: HTMLElement | undefined): void;
  /** Bound to a question's "something else" box (GRV-42), where Enter sends. */
  bindAskText(element: HTMLElement | undefined): void;
  /** Puts focus back in the composer, after Stop or Try again. */
  focusComposer(): void;
  /** Like `focusComposer`, but only once the producer has engaged the panel (GRV-130). */
  reclaimComposerFocus?(): void;
  /** Whether the assistant's settings are open in place of the conversation (GRV-8). */
  readonly settingsOpen?: () => boolean;
  /** Closes the settings, back to the conversation. */
  closeSettings?(): void;
  /**
   * Held by a tutorial video while it fills the window (GRV-16), so Escape
   * puts it back; returns the release (`AssistantPanel.holdExpandedVideo`).
   */
  holdExpandedVideo?(collapse: () => void): () => void;
}

/** The status a streaming reply puts in the panel's header and bar. */
export const WRITING_STATUS = "Writing…";

/** What the panel offers someone who must sign in first (ADR 0006 decision 4). */
export const SIGN_IN_NOTE = `Sign in to talk to ${ASSISTANT_NAME}.`;

/** The nudge card's accessible name (GRV-25). */
export const NUDGE_LABEL = `${ASSISTANT_NAME} suggests`;

/** The composer's accessible name. */
export const COMPOSER_LABEL = `Message ${ASSISTANT_NAME}`;

/**
 * The assistant's conversation (GRV-26), after docs/assistant-panel.html: the
 * log, the suggestion chips and the composer with its scope chip. A question
 * the assistant asks (GRV-42) waits between the log and the composer until it
 * is answered or dismissed (`AssistantAskCard`).
 *
 * Enter is not read here: it is the registry's `assistant.send`, live while
 * the composer has focus, so this only binds the composer and renders.
 *
 * The log is a polite live region, and it is `aria-busy` while a reply
 * streams, so a screen reader announces the reply once, when it is finished,
 * rather than word by word.
 */
export default function AssistantChatView(props: AssistantChatViewProps): JSX.Element {
  const retention = () => props.chat.retention;
  const registered = () => props.chat.account().registered;
  return (
    <Switch fallback={<Conversation {...props} />}>
      <Match when={registered() && props.settingsOpen?.() && retention()}>
        {(open) => (
          <div class="assistant-panel-log assistant-retention-pane">
            <RetentionSettings
              retention={open()}
              onDone={() => props.closeSettings?.()}
            />
          </div>
        )}
      </Match>
      {/* Neither the disclosure nor the conversation until the answer is known. */}
      <Match when={registered() && retention() && !retention()?.known() && retention()}>
        <div class="assistant-panel-log" aria-busy="true">
          <p class="assistant-panel-note">{RETENTION_LOADING}</p>
        </div>
      </Match>
      {/* Nobody messages the assistant before answering this (GRV-8). */}
      <Match
        when={registered() && retention() && !retention()?.answered() && retention()}
      >
        {(unanswered) => (
          <div class="assistant-panel-log assistant-retention-pane">
            <RetentionDisclosure retention={unanswered()} />
          </div>
        )}
      </Match>
    </Switch>
  );
}

function Conversation(props: AssistantChatViewProps): JSX.Element {
  // The conversation can arrive after the panel opened: once the account's
  // answer has loaded, or the disclosure was just answered, or the settings
  // closed (GRV-8). Focus left on the panel, or dropped with the button that
  // went, goes to the composer; focus anywhere else is left where it is.
  onSettled(() => {
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      active.classList.contains("assistant-panel")
    ) {
      (props.reclaimComposerFocus ?? props.focusComposer)();
    }
  });
  const conversation = () => props.chat.conversation;
  const streaming = () => conversation().streaming();
  const scope = () => props.chat.scope();

  // The log follows the newest entry, as a reply streams in too, unless the
  // producer has scrolled up to read something earlier. The entries are the
  // effect's one reactive read; the scroll is a DOM write, so it is the apply
  // half's.
  let log: HTMLDivElement | undefined;
  let composerElement: HTMLTextAreaElement | undefined;
  let pinned = true;
  // The composer follows its text (GRV-115). The draft is the one reactive
  // read; the resize is a DOM write, so it is the apply half's.
  createEffect(
    () => props.chat.draft(),
    () => {
      if (composerElement) fitComposer(composerElement);
    },
  );
  const PIN_SLACK = 40;
  createEffect(
    () => conversation().entries(),
    () => {
      if (log && pinned) log.scrollTop = log.scrollHeight;
    },
  );

  function stop(): void {
    conversation().stop();
    props.focusComposer();
  }

  function retry(): void {
    conversation().retry();
    props.focusComposer();
  }

  return (
    <>
      <div
        ref={log}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned =
            element.scrollHeight - element.scrollTop - element.clientHeight < PIN_SLACK;
        }}
        class="assistant-panel-log"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        aria-busy={streaming() ? "true" : "false"}
      >
        <Show when={conversation().entries().length === 0}>
          <div class="assistant-hello">
            <b>Ask for a change, a sound, or how something works.</b>
            <p>It only changes your song when you apply a proposal.</p>
          </div>
        </Show>
        <For
          each={conversation().entries()}
          keyed={(entry: ConversationEntry) => entry.id}
        >
          {(entry) => (
            <Entry
              entry={entry()}
              canRetry={conversation().canRetry(entry())}
              onRetry={retry}
              asking={conversation().pendingAsk()?.replyId === entry().id}
              chat={props.chat}
              holdExpandedVideo={props.holdExpandedVideo}
            />
          )}
        </For>
      </div>
      <Show
        when={props.chat.account().registered}
        fallback={<SignInPrompt signIn={props.chat.account().signIn} />}
      >
        <Show when={conversation().pendingAsk()}>
          {(pending) => (
            <AssistantAskCard
              pending={pending()}
              draft={props.chat.ask}
              streaming={streaming()}
              bindText={(element) => props.bindAskText(element)}
              takeFocus={() =>
                composerElement !== undefined &&
                document.activeElement === composerElement &&
                props.chat.draft().trim().length === 0
              }
            />
          )}
        </Show>
        {/* Coproducer's one nudge a day (GRV-25), above the suggestions. */}
        <Show
          when={
            !streaming() && !conversation().pendingAsk() && props.chat.nudge?.lesson()
          }
        >
          {(lesson) => (
            <section class="assistant-card cue-nudge" aria-label={NUDGE_LABEL}>
              <b>Want to try "{lesson()}"?</b>
              <div class="memory-proposal-actions">
                <button
                  type="button"
                  class="assistant-button-primary"
                  onClick={() => props.chat.nudge?.tryIt()}
                >
                  Let's try it
                </button>
                <button
                  type="button"
                  class="memory-proposal-secondary"
                  onClick={() => props.chat.nudge?.dismiss()}
                >
                  Not today
                </button>
              </div>
            </section>
          )}
        </Show>
        <Show
          when={
            !streaming() &&
            !conversation().pendingAsk() &&
            props.chat.suggestions().length > 0
          }
        >
          <fieldset class="assistant-suggestions" aria-label="Suggestions">
            <For each={props.chat.suggestions()}>
              {(suggestion) => (
                <button
                  type="button"
                  class="assistant-chip"
                  title={suggestion.rationale}
                  onClick={() => props.chat.sendSuggestion(suggestion)}
                >
                  {suggestion.label}
                </button>
              )}
            </For>
          </fieldset>
        </Show>
        <div class="assistant-panel-composer">
          <textarea
            ref={(element) => {
              composerElement = element;
              props.bindComposer(element);
            }}
            class="assistant-panel-input"
            rows={2}
            aria-label={COMPOSER_LABEL}
            placeholder="Ask for a change, a sound, or how something works"
            maxlength={MAX_MESSAGE_CHARS}
            value={props.chat.draft()}
            onInput={(event) => props.chat.setDraft(event.currentTarget.value)}
          />
          <div class="assistant-composer-row">
            <button
              type="button"
              class="assistant-scope"
              aria-label={`Scope: ${scope().label}`}
              title={`What ${ASSISTANT_NAME} reads and may change: your selection, the selected track, or the whole song. Click to widen it.`}
              onClick={() => props.chat.widenScope()}
            >
              <span class="assistant-scope-label">Scope</span>
              {scope().label}
            </button>
            <span class="assistant-composer-hint">
              {streaming()
                ? "Editing still works while it writes"
                : "Enter sends · Shift+Enter adds a line"}
            </span>
            {/* One button that turns from Send to Stop and back, so focus on
                it is never lost to the swap. */}
            <button
              type="button"
              class="assistant-send"
              aria-label={streaming() ? "Stop" : "Send"}
              title={streaming() ? "Stop the reply" : "Send"}
              disabled={!streaming() && props.chat.draft().trim().length === 0}
              onClick={() => (streaming() ? stop() : props.chat.sendDraft())}
            >
              <Show when={streaming()} fallback={<SendIcon size={14} />}>
                <StopIcon size={12} />
              </Show>
            </button>
          </div>
        </div>
      </Show>
    </>
  );
}

function Entry(props: {
  readonly entry: ConversationEntry;
  /** Only the error that ended the conversation offers Try again. */
  readonly canRetry: boolean;
  onRetry(): void;
  /** Whether this reply's question is the one waiting above the composer. */
  readonly asking: boolean;
  readonly chat: AssistantChat;
  holdExpandedVideo?(collapse: () => void): () => void;
}): JSX.Element {
  return (
    <Switch>
      <Match when={props.entry.kind === "message" && props.entry}>
        {(message) => (
          <div class="assistant-message">
            <span class="assistant-entry-label">
              {message().answers
                ? `Answer · ${message().answers}`
                : `Scope · ${message().scopeLabel}`}
            </span>
            {/* A space between the stamp and the message, so their text reads
                as two words to a screen reader and a search, not one. The flex
                column does not draw it. */}{" "}
            <p>{message().text}</p>
          </div>
        )}
      </Match>
      {/* A reply that only asked a question has nothing to show while the
          question waits above the composer: the card is all of it. */}
      <Match
        when={
          props.entry.kind === "reply" &&
          !(props.asking && props.entry.text.length === 0) &&
          props.entry
        }
      >
        {(reply) => (
          <div class="assistant-reply">
            <span class="assistant-entry-label assistant-reply-who">
              <SparkIcon size={10} />
              {ASSISTANT_NAME}
            </span>{" "}
            <p>
              {reply().text}
              <Show when={reply().streaming}>
                <span class="assistant-caret" aria-hidden="true" />
              </Show>
              <Show when={reply().stopped}>
                {reply().text.length > 0 ? " " : ""}
                <span class="assistant-stopped">Stopped.</span>
              </Show>
              {/* A reply cut off by a failure says so, so it does not read as
                  a finished answer above the error. */}
              <Show when={reply().failed}>
                {reply().text.length > 0 ? " " : ""}
                <span class="assistant-stopped">Interrupted.</span>
              </Show>
            </p>
            {/* Once its question is answered or put away, the reply keeps it,
                so the answer below reads against what was asked. */}
            <Show when={!props.asking && reply().ask}>
              {(ask) => <p class="assistant-reply-asked">Asked: {ask().question}</p>}
            </Show>
            {/* A finished answer can be rated (GRV-103); one still on its way
                or cut off by a failure cannot. */}
            <Show when={!reply().streaming && !reply().failed && reply().text.length > 0}>
              <ReplyRating
                rating={reply().rating}
                onRate={(rating) => props.chat.rateReply(reply().id, rating)}
              />
            </Show>
          </div>
        )}
      </Match>
      {/* A turn's later cards wait until the one before is decided (GRV-129). */}
      <Match
        when={props.entry.kind === "proposal" && !props.chat.cards.held(props.entry.id)}
      >
        <Show
          when={props.chat.proposals}
          fallback={
            // No editor to apply it to: the reply says a change was proposed
            // and nothing more. Nothing in the song changes.
            <section class="assistant-card" aria-label="Proposal">
              <b>A change was proposed</b>
              <span>Open a project to preview and apply it. Your song is unchanged.</span>
            </section>
          }
        >
          {(proposals) => (
            <>
              {/* A proposal whose parts streamed has a card of its own (GRV-144). */}
              <Show
                when={proposals().streamed(props.entry.id) !== undefined}
                fallback={
                  <ProposalCard
                    entryId={props.entry.id}
                    proposals={proposals()}
                    canAsk={
                      props.chat.account().registered &&
                      !props.chat.conversation.streaming()
                    }
                    heldAfter={props.chat.cards.heldAfter(props.entry.id)}
                  />
                }
              >
                <StreamedProposalCard
                  entryId={props.entry.id}
                  proposals={proposals()}
                  canAsk={
                    props.chat.account().registered &&
                    !props.chat.conversation.streaming()
                  }
                  heldAfter={props.chat.cards.heldAfter(props.entry.id)}
                />
              </Show>
              <Show when={props.chat.cards.skipped(props.entry.id)}>
                {(count) => <p class="assistant-panel-note">{skippedLine(count())}</p>}
              </Show>
            </>
          )}
        </Show>
      </Match>
      <Match
        when={
          props.entry.kind === "recommendation" && !props.chat.cards.held(props.entry.id)
        }
      >
        <Show
          when={props.chat.recommendations}
          fallback={
            // No editor to try it in: the reply says a sound was recommended
            // and nothing more. Nothing in the song changes.
            <section class="assistant-card" aria-label="Recommended pack">
              <b>A sound was recommended</b>
              <span>Open a project to hear and try it. Your song is unchanged.</span>
            </section>
          }
        >
          {(recommendations) => (
            <>
              <RecommendationCard
                entryId={props.entry.id}
                recommendations={recommendations()}
                canAsk={
                  props.chat.account().registered && !props.chat.conversation.streaming()
                }
                heldAfter={props.chat.cards.heldAfter(props.entry.id)}
              />
            </>
          )}
        </Show>
      </Match>
      <Match when={props.entry.kind === "memory"}>
        <Show when={props.chat.memory}>
          {(memory) => <MemoryProposalCard entryId={props.entry.id} memory={memory()} />}
        </Show>
      </Match>
      <Match when={props.entry.kind === "video" && props.entry}>
        {(entry) => (
          // A card that cannot render says so in its place, and nothing else
          // in the conversation goes with it (ADR 0009: failures are isolated).
          <Errored
            fallback={
              <section class="assistant-card" aria-label="Tutorial video">
                <b>A video was recommended</b>
                <span>It can't be shown right now. Nothing else is affected.</span>
              </section>
            }
          >
            <VideoCard
              video={entry().video}
              analytics={props.chat.analytics}
              holdExpanded={props.holdExpandedVideo}
            />
          </Errored>
        )}
      </Match>
      <Match when={props.entry.kind === "error" && props.entry}>
        {(failure) => (
          <div class="assistant-error" role="alert">
            <b>{ERROR_HEADING}</b>
            <span>
              {errorMessage(failure().error)} {ERROR_REASSURANCE}
            </span>
            <Show when={props.canRetry}>
              <div>
                <button
                  type="button"
                  class="assistant-button-primary"
                  onClick={() => props.onRetry()}
                >
                  Try again
                </button>
              </div>
            </Show>
          </div>
        )}
      </Match>
    </Switch>
  );
}

function SignInPrompt(props: { readonly signIn?: () => void }): JSX.Element {
  return (
    <div class="assistant-panel-composer assistant-sign-in">
      <p class="assistant-panel-note">{SIGN_IN_NOTE}</p>
      <Show when={props.signIn}>
        {(signIn) => (
          <div>
            <button
              type="button"
              class="assistant-button-primary"
              onClick={() => signIn()()}
            >
              Sign in
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
