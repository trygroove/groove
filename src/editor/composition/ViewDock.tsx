import { For, type JSX } from "@solidjs/web";
import { createSignal, createUniqueId, Show } from "solid-js";
import { MASK_CONTENT } from "../../monitoring/replayPrivacy";
import { EDITOR_VIEW_SPECS, type EditorViewName } from "./editorViews";
import { ViewIcon } from "./viewIcons";
import "./ViewDock.css";

export interface ViewDockProps {
  /** The view currently on screen, from the URL (`UI-001`). */
  readonly view: EditorViewName;
  /** Where each view lives, so every entry is a real, copyable address. */
  href(view: EditorViewName): string;
  /** Called for an ordinary activation, so the host navigates and measures. */
  onSelect(view: EditorViewName): void;
  /** The key that reaches this view, from the registry. */
  keyHint(view: EditorViewName): string;
  /**
   * What the view will open, for its hover tip: the clip's name for Sequence,
   * "sounds for BD" for the Library. Undefined when it names nothing.
   */
  opens?(view: EditorViewName): string | undefined;
  /** A view the selection does not fit, drawn dimmed but still reachable. */
  dimmed?(view: EditorViewName): boolean;
  /** A view with something set, drawn with a dot: the Library's target. */
  marked?(view: EditorViewName): boolean;
}

/**
 * The floating dock (`UI-001`, `UI-002`): the number row drawn on screen. Five
 * square tiles in key order, each an abstract icon with its key in the corner
 * and no label; the view's name and what it will open are in the hover tip,
 * and the name is the tile's accessible name.
 *
 * **Navigation, not tabs**: a view is an address, so each tile is a real
 * `<a href>`, openable in a new tab, copyable, reachable with the back button,
 * and marked with `aria-current`. An ordinary left-click is handled here, so
 * the host can record *how* the view was reached (`view_changed`'s `via`)
 * before it navigates; a modified click is left to the browser.
 */
export default function ViewDock(props: ViewDockProps): JSX.Element {
  const [tipFor, setTipFor] = createSignal<EditorViewName | null>(null);
  const tipId = createUniqueId();

  /** The plain activation the dock owns; anything the browser gives its own
   * meaning — a middle click, a modifier — belongs to the anchor. */
  const isPlainActivation = (event: MouseEvent): boolean =>
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey;

  return (
    <nav class="view-dock" aria-label="Views">
      <ul class="view-dock-list">
        <For each={EDITOR_VIEW_SPECS}>
          {(spec) => {
            const current = () => props.view === spec.view;
            const showTip = () => setTipFor(spec.view);
            const hideTip = () => setTipFor((open) => (open === spec.view ? null : open));
            return (
              <li class="view-dock-item">
                <a
                  class={[
                    "view-dock-link",
                    { "view-dock-dimmed": props.dimmed?.(spec.view) ?? false },
                  ]}
                  href={props.href(spec.view)}
                  aria-label={spec.label}
                  aria-current={current() ? "page" : undefined}
                  aria-keyshortcuts={props.keyHint(spec.view)}
                  aria-describedby={tipFor() === spec.view ? tipId : undefined}
                  onPointerEnter={showTip}
                  onPointerLeave={hideTip}
                  onFocus={showTip}
                  onBlur={hideTip}
                  onClick={(event) => {
                    if (!isPlainActivation(event)) return;
                    event.preventDefault();
                    props.onSelect(spec.view);
                  }}
                >
                  <span class="view-dock-key" aria-hidden="true">
                    {props.keyHint(spec.view)}
                  </span>
                  <span class="view-dock-icon" aria-hidden="true">
                    <ViewIcon view={spec.view} size={24} />
                  </span>
                  <Show when={props.marked?.(spec.view)}>
                    <span class="view-dock-dot" aria-hidden="true" />
                  </Show>
                </a>
                <Show when={tipFor() === spec.view}>
                  {/* What it opens is a clip's or a track's name: the user's. */}
                  <span id={tipId} role="tooltip" class={`view-dock-tip ${MASK_CONTENT}`}>
                    {props.keyHint(spec.view)} {spec.label}
                    <Show when={props.opens?.(spec.view)}>
                      {(opens) => ` · ${opens()}`}
                    </Show>
                  </span>
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    </nav>
  );
}
