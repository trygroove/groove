import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import {
  DECLINE_ANSWER,
  DISCLOSURE_CLOSING,
  DISCLOSURE_PARAGRAPHS,
  DISCLOSURE_TITLE,
  KEEP_ANSWER,
  OPTED_IN_CONFIRMATION,
  OPTED_OUT_CONFIRMATION,
  RETENTION_LABEL,
  RETENTION_SAVE_FAILED,
  RETENTION_SCOPE,
  SETTINGS_TITLE,
} from "./retentionCopy";
import type { AssistantRetention } from "./useAssistantRetention";

/** What the panel says while it looks up the account's answer. */
export const RETENTION_LOADING = "Checking your assistant settings…";

/** What is sent, what the provider does with it, and what Groove keeps. */
function DisclosureText(): JSX.Element {
  return <For each={DISCLOSURE_PARAGRAPHS}>{(paragraph) => <p>{paragraph}</p>}</For>;
}

/**
 * The assistant's disclosure (GRV-8, ADR 0007 decision 5), shown in place of
 * the composer until a signed-in account has answered it: the assistant
 * cannot be messaged before. Keeping and not keeping are two buttons of the
 * same weight, and the control's scope sits right under them.
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
        aria-labelledby="assistant-retention-question"
        aria-describedby="assistant-retention-scope"
      >
        <b id="assistant-retention-question">{RETENTION_LABEL}?</b>
        <div class="assistant-retention-answers">
          <button
            type="button"
            class="assistant-button"
            disabled={props.retention.saving()}
            onClick={() => void props.retention.answer(true)}
          >
            {KEEP_ANSWER}
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
              disabled={props.retention.saving()}
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
