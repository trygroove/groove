import { For, type JSX, Show } from "@solidjs/web";
import { ariaBool } from "../shared/aria";
import type { ShortcutActionId } from "../shortcuts";
import { type GenreCount, LOOP_BARS_CHOICES, type TempoFilter } from "./filters";
import { ChipKey } from "./Shelf";
import { roleLabel as genreLabel } from "./shelf";
import "./SoundsView.css";

/** "Any bars", "1 bar", "4 bars": a Bars segment's full meaning, for its name. */
function barsName(bars: number | null): string {
  if (bars === null) return "Any bars";
  return `${bars} bar${bars === 1 ? "" : "s"}`;
}

/**
 * The Sounds view's filter row (LIB-010): a Genre multi-select menu with counts
 * so it can grow without taking a row, under Loops the Tempo window and the
 * Bars count, and the live result count. Every value is the caller's: this
 * only draws the controls. Segments show short text ("Any", "4"); each
 * button's accessible name carries the full meaning ("Any tempo", "4 bars").
 */
export default function FilterRow(props: {
  genres: readonly GenreCount[];
  selectedGenres: readonly string[];
  menuOpen: boolean;
  loops: boolean;
  tempo: TempoFilter;
  songBpm: number;
  bars: number | null;
  count: number;
  /** Key badge text for a registry action, from the registry. */
  keyLabel?(action: ShortcutActionId): string | undefined;
  onMenuOpen(open: boolean): void;
  /** The genre menu's button, which Escape hands focus back to (#874). */
  genreButtonRef?(button: HTMLButtonElement): void;
  /** The open menu, as it appears, for the caller to move focus into. */
  menuRef?(menu: HTMLFieldSetElement): void;
  onGenre(genre: string): void;
  /** The menu's *Any genre* row: clear every genre at once. */
  onClearGenres(): void;
  onTempo(tempo: TempoFilter): void;
  onBars(bars: number | null): void;
}): JSX.Element {
  const label = () => {
    const [first, ...rest] = props.selectedGenres;
    if (first === undefined) return "Any genre";
    const name = genreLabel(first);
    return rest.length > 0 ? `${name} +${rest.length}` : name;
  };
  const genreKey = () => props.keyLabel?.("library.genre_menu");
  const tempoKey = () => props.keyLabel?.("library.loop_tempo");
  return (
    <div class="filter-row">
      <div class="filter-genre">
        <button
          ref={(button) => props.genreButtonRef?.(button)}
          type="button"
          class={["filter-pick", { "filter-pick-set": props.selectedGenres.length > 0 }]}
          aria-haspopup="true"
          aria-expanded={ariaBool(props.menuOpen)}
          aria-keyshortcuts={genreKey()}
          onClick={() => props.onMenuOpen(!props.menuOpen)}
        >
          <ChipKey label={genreKey()} />
          {label()}
        </button>
        <Show when={props.menuOpen}>
          <fieldset
            ref={(menu) => props.menuRef?.(menu)}
            class="filter-menu"
            aria-label="Genres"
          >
            <div class="filter-menu-options">
              {/* Keyed by genre: a toggle re-counts the menu, and the row (and
                  the focus on its checkbox) must survive that (#890). */}
              <For each={props.genres} keyed={(entry) => entry.genre}>
                {(entry) => (
                  <label class="filter-option">
                    <input
                      type="checkbox"
                      checked={props.selectedGenres.includes(entry().genre)}
                      onChange={() => props.onGenre(entry().genre)}
                    />
                    {genreLabel(entry().genre)}{" "}
                    <small class="filter-option-count">{entry().count}</small>
                  </label>
                )}
              </For>
            </div>
            <hr class="filter-menu-rule" />
            <button
              type="button"
              class="filter-menu-clear"
              onClick={() => props.onClearGenres()}
            >
              Any genre
            </button>
          </fieldset>
        </Show>
      </div>
      <Show when={props.loops}>
        <fieldset class="filter-group">
          <legend class="filter-label">Tempo</legend>
          <button
            type="button"
            class="shelf-chip filter-segment"
            aria-label={`Near ${props.songBpm} BPM`}
            aria-pressed={ariaBool(props.tempo === "near")}
            aria-keyshortcuts={tempoKey()}
            onClick={() => props.onTempo("near")}
          >
            <ChipKey label={tempoKey()} />
            Near {props.songBpm}
          </button>
          <button
            type="button"
            class="shelf-chip filter-segment"
            aria-label="Any tempo"
            aria-pressed={ariaBool(props.tempo === "any")}
            onClick={() => props.onTempo("any")}
          >
            Any
          </button>
        </fieldset>
        <fieldset class="filter-group">
          <legend class="filter-label">Bars</legend>
          <For each={LOOP_BARS_CHOICES}>
            {(bars) => (
              <button
                type="button"
                class="shelf-chip filter-segment"
                aria-label={barsName(bars)}
                aria-pressed={ariaBool(props.bars === bars)}
                onClick={() => props.onBars(bars)}
              >
                {bars ?? "Any"}
              </button>
            )}
          </For>
        </fieldset>
      </Show>
      <span class="filter-count" aria-live="polite">
        {props.count} {props.count === 1 ? "sound" : "sounds"}
      </span>
    </div>
  );
}
