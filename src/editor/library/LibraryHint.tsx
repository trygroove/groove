import { type JSX, Match, Show, Switch } from "@solidjs/web";
import type { ShortcutActionId } from "../../shortcuts";

/** What the window's main area shows, which decides what the hint teaches. */
export type LibraryPlace = "sounds" | "packs" | "similar" | "other";

export interface LibraryHintProps {
  readonly place: LibraryPlace;
  /** Where auditions play ("the BD pad"); unset when they play on their own. */
  readonly where?: string;
  /** The sound the slot holds, which leaving the Library puts back. */
  readonly current?: string | null;
  readonly selected?: string;
  keyLabel?(action: ShortcutActionId): string;
}

/**
 * The footer's live hint (#814, the reference's `render()`): it names where
 * auditions are heard and the keys that matter in the view showing, and says
 * what leaving will put back (`UI-002`: a view key leaves, not Escape). Every
 * key label comes from the registry.
 */
export default function LibraryHint(props: LibraryHintProps): JSX.Element {
  const key = (action: ShortcutActionId) => (
    <Show when={props.keyLabel?.(action)}>
      {(label) => <kbd class="library-modal-key">{label()}</kbd>}
    </Show>
  );
  const putsBack = () =>
    props.current
      ? `leaving puts back ${props.current}.`
      : "leaving keeps the slot empty.";

  return (
    <span class="library-modal-hint">
      <Switch>
        <Match when={props.place === "packs"}>
          Pick a pack to see its sounds.
          <Show when={props.selected && props.where}>
            {" "}
            <b>{props.selected}</b> is still playing in {props.where}.
          </Show>
        </Match>
        <Match when={props.place === "similar"}>
          <Show when={props.where} fallback="Pick a result to hear it. ">
            Every result plays in <b>{props.where}</b>.{" "}
          </Show>
          Press its similar button to hop on from it; the trail above takes you back.
        </Match>
        <Match when={props.place === "sounds"}>
          <Show when={props.where}>
            {props.selected ? "Playing in " : "Sounds play in "}
            <b>{props.where}</b> over your beat.{" "}
          </Show>
          {key("library.select_previous")} {key("library.select_next")} for the next,{" "}
          {key("library.insert_and_return")} to insert
          {props.where ? `; ${putsBack()}` : "."}
        </Match>
        <Match when={props.place === "other"}>
          Pick a place on the left to find sounds.
        </Match>
      </Switch>
    </span>
  );
}
