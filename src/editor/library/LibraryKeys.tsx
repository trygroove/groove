import { For, type JSX } from "@solidjs/web";
import { createMemo, onSettled } from "solid-js";
import { detectPlatform, type ShortcutActionId, shortcutLabel } from "../../shortcuts";

/** One line of the sheet: the keys that do it, and what it does. */
interface KeyRow {
  /** Two keys joined by "…" read as a range ("1 … 9"); otherwise each is shown. */
  readonly keys: readonly ShortcutActionId[];
  readonly range?: boolean;
  readonly text: string;
}

/**
 * The library's keys as the reference groups them (#449, step 8). Only the
 * grouping and wording live here: every key label comes from the registry.
 */
const GROUPS: readonly { readonly title: string; readonly rows: readonly KeyRow[] }[] = [
  {
    title: "Sounds",
    rows: [
      {
        keys: ["library.select_previous", "library.select_next"],
        text: "Previous / next sound, and hear it",
      },
      { keys: ["library.audition"], text: "Hear it again" },
      { keys: ["library.insert_and_return"], text: "Insert, and go back" },
      { keys: ["library.insert"], text: "Insert, and stay to try another" },
      { keys: ["library.like"], text: "Like: favourite the selected sound" },
      { keys: ["library.similar"], text: "Similar sounds" },
      { keys: ["library.shuffle"], text: "Shuffle" },
      { keys: ["view.show_instrument"], text: "Back without inserting" },
    ],
  },
  {
    title: "Categories",
    rows: [
      { keys: ["library.pick_all"], text: "All of the family" },
      {
        keys: ["library.category_previous", "library.category_next"],
        text: "Previous / next category",
      },
      {
        keys: ["library.family_previous", "library.family_next"],
        text: "Previous / next family",
      },
      { keys: ["library.genre_menu"], text: "Genre menu" },
      { keys: ["library.loop_tempo"], text: "Loops: near the song tempo, or any" },
    ],
  },
  {
    title: "Where you are",
    rows: [
      { keys: ["library.all_sounds"], text: "All sounds" },
      { keys: ["library.favourites"], text: "Favourites" },
      { keys: ["library.browse_packs"], text: "Browse packs" },
      {
        keys: ["library.back"],
        text: "Back: out of similar sounds, a pack, or Browse packs",
      },
      { keys: ["library.search"], text: "Search" },
      { keys: ["help.shortcut_guide"], text: "This list" },
    ],
  },
];

/**
 * The sheet `?` opens inside the library (#813): only the keys the library
 * answers to, since the editor's are off while it is open.
 */
export default function LibraryKeys(props: { onClose(): void }): JSX.Element {
  const platform = createMemo(() => detectPlatform());
  const label = (id: ShortcutActionId) => shortcutLabel(id, platform());
  let close: HTMLButtonElement | undefined;

  onSettled(() => {
    const previous = document.activeElement;
    close?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  });

  return (
    <div class="library-keys" role="dialog" aria-label="Library keys">
      <div class="library-keys-head">
        <h2>Library keys</h2>
        <button
          type="button"
          class="library-keys-close"
          aria-label="Close key list"
          ref={close}
          onClick={() => props.onClose()}
        >
          ×
        </button>
      </div>
      <p>
        These keys work only while the library is open. While it is, the editor's own
        shortcuts are off, so none of them clash. Typing in search keeps every key for the
        search; press {label("view.close_surface")} or {label("library.select_next")} to
        leave it.
      </p>
      <div class="library-keys-grid">
        <For each={GROUPS}>
          {(group) => (
            <section>
              <h3 class="library-modal-label">{group.title}</h3>
              <dl>
                <For each={group.rows}>
                  {(row) => (
                    <>
                      <dt>
                        <For each={row.keys}>
                          {(id, i) => (
                            <>
                              {i() > 0 && row.range ? (
                                <kbd class="library-modal-key">…</kbd>
                              ) : null}
                              <kbd class="library-modal-key">{label(id)}</kbd>
                            </>
                          )}
                        </For>
                      </dt>
                      <dd>{row.text}</dd>
                    </>
                  )}
                </For>
              </dl>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}
