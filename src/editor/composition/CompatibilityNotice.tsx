import { For, Show } from "@solidjs/web";
import { createSignal } from "solid-js";
import type { CapabilityMessage } from "../../browser/capabilityMessages";
import "./CompatibilityNotice.css";

/** One thing this browser can't do, as the editor explains it (#75). */
export interface CompatibilityNoticeItem {
  /**
   * Identifies the notice for dismissal. A failure that happens again gets a
   * new key, so dismissing one notice never hides the next.
   */
  readonly key: string;
  readonly message: CapabilityMessage;
}

export interface CompatibilityNoticeProps {
  readonly items: readonly CompatibilityNoticeItem[];
}

/**
 * Says what this browser can't do here, what it costs, and what to do next
 * (PRD section 10; #75). Each notice is dismissed on its own and stays
 * dismissed for this visit to the editor; it is never a reason the editor
 * refuses to open.
 */
export default function CompatibilityNotice(props: CompatibilityNoticeProps) {
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const shown = () => props.items.filter((item) => !dismissed().has(item.key));

  function dismiss(key: string): void {
    setDismissed((previous) => new Set([...previous, key]));
  }

  return (
    <Show when={shown().length > 0}>
      <section
        class="compatibility-notice"
        aria-label="Browser support"
        aria-live="polite"
      >
        <For each={shown()}>
          {(item) => (
            <div class="compatibility-notice-item">
              <p class="compatibility-notice-text">
                <strong class="compatibility-notice-title">{item.message.title}.</strong>{" "}
                {item.message.detail}{" "}
                <span class="compatibility-notice-action">{item.message.action}</span>
              </p>
              <button
                type="button"
                class="compatibility-notice-dismiss"
                aria-label={`Dismiss: ${item.message.title}`}
                onClick={() => dismiss(item.key)}
              >
                Dismiss
              </button>
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}
