import type { JSX } from "@solidjs/web";
import { For, Match, Switch } from "solid-js";
import { ASSISTANT_NAME } from "../../site.config.mjs";
import type { ProducerMemory } from "../persistence/profileDocuments";
import { memoryLines } from "./questions";
import type { OnboardingStage } from "./useOnboarding";

/** The box's label: what ticking it shares, and why. */
export const CONSENT_LABEL = "Share my answers' choices to help shape Groove";

/** What the box shares, and what it never does. */
export const CONSENT_NOTE =
  "Only your experience, goal, and the learning and gear options you picked. Never artists, anything you typed, or a note.";

export interface MemoryCardProps {
  readonly memory: ProducerMemory;
  readonly consent: boolean;
  onConsent(consent: boolean): void;
  readonly status: OnboardingStage;
  onRetry(): void;
}

/**
 * The "saved to memory" card (GRV-25): what Cue now remembers, one line per
 * answered question, and the box (unticked unless ticked) to share the
 * answers' fixed choices for customer validation.
 */
export function MemoryCard(props: MemoryCardProps): JSX.Element {
  const lines = () => memoryLines(props.memory);
  return (
    <section class="assistant-card memory-card" aria-label="Saved to memory">
      <b>Saved to memory</b>
      <Switch>
        <Match when={lines().length === 0}>
          <span>Nothing yet. {ASSISTANT_NAME} will learn as you go.</span>
        </Match>
        <Match when={lines().length > 0}>
          <dl class="memory-card-lines">
            <For each={lines()}>
              {(line) => (
                <div class="memory-card-line">
                  <dt>{line.field}</dt>
                  <dd>{line.value}</dd>
                </div>
              )}
            </For>
          </dl>
        </Match>
      </Switch>
      <label class="memory-card-consent">
        <input
          type="checkbox"
          checked={props.consent}
          onChange={(event) => props.onConsent(event.currentTarget.checked)}
        />
        <span>
          {CONSENT_LABEL}
          <small>{CONSENT_NOTE}</small>
        </span>
      </label>
      <Switch>
        <Match when={props.status === "saving"}>
          <output class="memory-card-status">Saving…</output>
        </Match>
        <Match when={props.status === "save_failed"}>
          <output class="memory-card-status">
            Couldn't save to memory.{" "}
            <button
              type="button"
              class="memory-card-retry"
              onClick={() => props.onRetry()}
            >
              Try again
            </button>
          </output>
        </Match>
      </Switch>
    </section>
  );
}
