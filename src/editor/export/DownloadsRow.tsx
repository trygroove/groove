import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import "./DownloadsRow.css";

export type DownloadState = "waiting" | "now" | "done" | "bad";

/** One file the export will hand over: a stereo WAV, or one ZIP of the stems. */
export interface DownloadCard {
  readonly name: string;
  /** The file's own name when `name` is a short label such as `ZIP 2 of 3`. */
  readonly title?: string;
  /** `21 files · 1.3 GiB`. */
  readonly detail: string;
  readonly state: DownloadState;
  /** How much is printed, 0..1; the fill line along the card's bottom. */
  readonly fraction: number;
}

function stateText(card: DownloadCard): string {
  switch (card.state) {
    case "now":
      return `Printing ${Math.floor(card.fraction * 100)}%`;
    case "done":
      return "✓ Downloaded";
    case "bad":
      return "Failed";
    default:
      return "Waiting";
  }
}

/**
 * The Downloads row of the Release design (EXP-004): a DOWNLOADS label then one
 * card per file, each with its state and a 2px line filling along its bottom as
 * it prints. Always present and a fixed height, so a longer list of files or a
 * state change never moves the footer below it.
 */
export default function DownloadsRow(props: {
  readonly cards: readonly DownloadCard[];
}): JSX.Element {
  return (
    <section class="downloads" aria-label="Downloads">
      <span class="export-label">Downloads</span>
      <Show when={props.cards.length === 0}>
        <span class="download-empty">Nothing to export</span>
      </Show>
      <For each={props.cards} keyed={(card) => card.name}>
        {(card) => (
          <div class={["download", card().state]}>
            <b title={card().title ?? card().name}>{card().name}</b>
            <span class="download-detail">{card().detail}</span>
            <span class="download-state">{stateText(card())}</span>
            <i aria-hidden="true" style={{ width: `${card().fraction * 100}%` }} />
          </div>
        )}
      </For>
    </section>
  );
}
