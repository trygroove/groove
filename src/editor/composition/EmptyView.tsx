import { For, type JSX } from "@solidjs/web";
import { createUniqueId } from "solid-js";
import type { EditorViewName } from "./editorViews";
import { ViewIcon, type ViewIconName } from "./viewIcons";
import "./EmptyView.css";

/** A fix the empty screen offers: go to the view where it can be made. */
export interface EmptyViewFix {
  readonly view: EditorViewName;
  /** The view's name, which is also the button's accessible name. */
  readonly label: string;
  /** The key that reaches it, shown on the button so the fix teaches it. */
  readonly keyLabel: string;
}

export interface EmptyViewProps {
  /** The view that has nothing to show; its icon is drawn struck through. */
  readonly view: ViewIconName;
  /** What is missing, and the region's accessible name. */
  readonly title: string;
  /** One line on the fix. */
  readonly body: string;
  readonly fixes: readonly EmptyViewFix[];
  onFix(view: EditorViewName): void;
}

/**
 * The one empty screen (`UI-002`). The view keys always go to their view, so
 * a view the selection does not fit says so instead of refusing the key: its
 * icon struck through, a title naming what is missing, one line on the fix,
 * and a button for each fix carrying the key that does the same thing.
 */
export default function EmptyView(props: EmptyViewProps): JSX.Element {
  const titleId = createUniqueId();
  return (
    <section class="empty-view" aria-labelledby={titleId}>
      <span class="empty-view-icon">
        <ViewIcon view={props.view} size={48} struck />
      </span>
      <h2 id={titleId} class="empty-view-title">
        {props.title}
      </h2>
      <p class="empty-view-body">{props.body}</p>
      <div class="empty-view-fixes">
        <For each={props.fixes}>
          {(fix) => (
            <button
              type="button"
              class="empty-view-fix"
              aria-label={fix.label}
              aria-keyshortcuts={fix.keyLabel}
              onClick={() => props.onFix(fix.view)}
            >
              <kbd class="empty-view-key">{fix.keyLabel}</kbd>
              <span>{fix.label}</span>
            </button>
          )}
        </For>
      </div>
    </section>
  );
}
