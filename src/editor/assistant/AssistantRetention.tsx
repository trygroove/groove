import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { ASSISTANT_NAME } from "../../../site.config.mjs";
import {
  ACCEPT_ANSWER,
  DECLINE_ANSWER,
  DISCLOSURE_CLOSING,
  DISCLOSURE_PARAGRAPHS,
  DISCLOSURE_TITLE,
  NOTE_DECLINE,
  NOTE_DISMISS,
  NOTE_HOW_IT_WORKS,
  NOTE_LABEL,
  NOTE_TEXT,
  NOTICE_CHANGE,
  NOTICE_HEADING,
  OPTED_IN_CONFIRMATION,
  OPTED_OUT_CONFIRMATION,
  RETENTION_LABEL,
  RETENTION_SAVE_FAILED,
  RETENTION_SCOPE,
  SETTINGS_TITLE,
} from "./retentionCopy";
import type { AssistantRetention } from "./useAssistantRetention";

/** What the panel says while it looks up the account's answer. */
export const RETENTION_LOADING = `Checking your ${ASSISTANT_NAME} settings…`;

/** What is sent, what the provider does with it, and what Groove keeps. */
function DisclosureText(): JSX.Element {
  return <For each={DISCLOSURE_PARAGRAPHS}>{(paragraph) => <p>{paragraph}</p>}</For>;
}

/**
 * The one-line note under the composer (GRV-205, ADR 0007 decision 5 as
 * amended): the disclosure is available before the first message, never a
 * gate on it. It stays until the producer taps "Got it" (which keeps, the
 * default, and is stored like any answer), opts out, or answers in the full
 * text. Opting out says what it did, right here, until it is put away.
 */
export function RetentionNote(props: {
  readonly retention: AssistantRetention;
  /** Opens the full disclosure (Coproducer settings). */
  onHowItWorks(): void;
  /** Where focus goes when a button here is pressed and goes away. */
  focusComposer(): void;
}): JSX.Element {
  const [confirmation, setConfirmation] = createSignal<string | null>(null);
  const visible = () =>
    props.retention.known() && (!props.retention.answered() || confirmation() !== null);

  async function decline() {
    if (await props.retention.answer(false)) {
      setConfirmation(OPTED_OUT_CONFIRMATION);
      props.focusComposer();
    }
  }

  async function keep() {
    if (await props.retention.answer(true)) props.focusComposer();
  }

  return (
    <Show when={visible()}>
      <section class="assistant-note" aria-label={NOTE_LABEL}>
        <Show
          when={confirmation()}
          fallback={
            <>
              <p>{NOTE_TEXT}</p>
              <div class="assistant-note-actions">
                <button
                  type="button"
                  class="assistant-note-link"
                  onClick={() => {
                    props.retention.disclosureOpened();
                    props.onHowItWorks();
                  }}
                >
                  {NOTE_HOW_IT_WORKS}
                </button>
                <button
                  type="button"
                  class="assistant-note-link"
                  onClick={() => void decline()}
                >
                  {NOTE_DECLINE}
                </button>
                <button
                  type="button"
                  class="assistant-note-link"
                  onClick={() => void keep()}
                >
                  {NOTE_DISMISS}
                </button>
              </div>
              <Show when={props.retention.saveFailed()}>
                <p class="assistant-retention-error" role="alert">
                  {RETENTION_SAVE_FAILED}
                </p>
              </Show>
            </>
          }
        >
          {(text) => (
            <>
              <output>{text()}</output>
              <div class="assistant-note-actions">
                <button
                  type="button"
                  class="assistant-note-link"
                  onClick={() => {
                    setConfirmation(null);
                    props.focusComposer();
                  }}
                >
                  {NOTE_DISMISS}
                </button>
              </div>
            </>
          )}
        </Show>
      </section>
    </Show>
  );
}

/**
 * The assistant's full disclosure (GRV-8, ADR 0007 decision 5), shown in
 * Coproducer settings while the account has not answered it, and reached
 * from the composer's note ({@link RetentionNote}). Keeping is the default (GRV-97), so it is a
 * notice rather than a question: "OK" keeps them, "Don't keep them" beside
 * it, the same size, opts out. The control's scope sits right under them.
 */
export function RetentionDisclosure(props: {
  readonly retention: AssistantRetention;
}): JSX.Element {
  return (
    <section class="assistant-disclosure" aria-labelledby="assistant-disclosure-title">
      <h2 id="assistant-disclosure-title" class="assistant-disclosure-title">
        {DISCLOSURE_TITLE}
      </h2>
      <DisclosureText />
      <fieldset
        class="assistant-retention-choice"
        aria-labelledby="assistant-retention-notice"
        aria-describedby="assistant-retention-change assistant-retention-scope"
      >
        <b id="assistant-retention-notice">{NOTICE_HEADING}</b>
        <p id="assistant-retention-change">{NOTICE_CHANGE}</p>
        <div class="assistant-retention-answers">
          <button
            type="button"
            class="assistant-button"
            disabled={props.retention.saving()}
            onClick={() => void props.retention.answer(true)}
          >
            {ACCEPT_ANSWER}
          </button>
          <button
            type="button"
            class="assistant-button"
            disabled={props.retention.saving()}
            onClick={() => void props.retention.answer(false)}
          >
            {DECLINE_ANSWER}
          </button>
        </div>
        <p id="assistant-retention-scope" class="assistant-retention-scope">
          {RETENTION_SCOPE}
        </p>
      </fieldset>
      <Show when={props.retention.saveFailed()}>
        <p class="assistant-retention-error" role="alert">
          {RETENTION_SAVE_FAILED}
        </p>
      </Show>
      <p>{DISCLOSURE_CLOSING}</p>
    </section>
  );
}

/**
 * The durable setting (GRV-8): the same control, its scope beside it, and
 * the disclosure under them. Opening it changes nothing; the box shows the
 * account's stored answer. Unanswered, it is the disclosure itself.
 */
export function RetentionSettings(props: {
  readonly retention: AssistantRetention;
  onDone(): void;
}): JSX.Element {
  const [confirmation, setConfirmation] = createSignal<string | null>(null);

  async function change(event: Event & { currentTarget: HTMLInputElement }) {
    const want = event.currentTarget.checked;
    // The box shows what is stored, not what was clicked, until it is stored.
    event.currentTarget.checked = props.retention.retain() === true;
    // Never `disabled` while saving: that drops keyboard focus to the document.
    if (props.retention.saving()) return;
    setConfirmation(null);
    if (await props.retention.answer(want)) {
      setConfirmation(want ? OPTED_IN_CONFIRMATION : OPTED_OUT_CONFIRMATION);
    }
  }

  return (
    <section class="assistant-settings" aria-labelledby="assistant-settings-title">
      <h2 id="assistant-settings-title" class="assistant-disclosure-title">
        {SETTINGS_TITLE}
      </h2>
      <Show
        when={props.retention.known()}
        fallback={<p class="assistant-panel-note">{RETENTION_LOADING}</p>}
      >
        <Show
          when={props.retention.answered()}
          fallback={<RetentionDisclosure retention={props.retention} />}
        >
          <label class="assistant-setting">
            <input
              type="checkbox"
              checked={props.retention.retain() === true}
              aria-disabled={props.retention.saving() ? "true" : undefined}
              aria-describedby="assistant-setting-scope"
              onChange={(event) => void change(event)}
            />
            {RETENTION_LABEL}
          </label>
          <p id="assistant-setting-scope" class="assistant-retention-scope">
            {RETENTION_SCOPE}
          </p>
          <output class="assistant-retention-status">{confirmation() ?? ""}</output>
          <Show when={props.retention.saveFailed()}>
            <p class="assistant-retention-error" role="alert">
              {RETENTION_SAVE_FAILED}
            </p>
          </Show>
          <h3 class="assistant-disclosure-subtitle">{DISCLOSURE_TITLE}</h3>
          <DisclosureText />
          <p>{DISCLOSURE_CLOSING}</p>
        </Show>
      </Show>
      <div>
        <button type="button" class="assistant-button" onClick={() => props.onDone()}>
          Back to the conversation
        </button>
      </div>
    </section>
  );
}
