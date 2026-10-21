import { type Accessor, createEffect } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import type { EditorViewName, ViewChangeSource } from "./editorViews";

export interface UseEditorNavigationOptions {
  /** The view on screen, which comes from the URL (`UI-001`). */
  readonly view: Accessor<EditorViewName>;
  /** Navigates to a view. The editor asks; the route is what actually moves. */
  readonly onSelectView: (view: EditorViewName) => void;
  readonly analytics: Accessor<Analytics>;
}

export interface EditorNavigation {
  /**
   * Switches to a view, saying how the switch was asked for. Asking for the
   * view already on screen does nothing.
   */
  selectView(next: EditorViewName, via: ViewChangeSource): void;
  /** Where leaving the Library goes back to (`UI-002`): the view it came from. */
  libraryReturn(): EditorViewName;
}

/**
 * Moving between the editor's views (`UI-001`, `UI-002`), and the
 * `view_changed` event every switch logs.
 *
 * The view lives in the URL, so switching is a navigation and the editor
 * holds no "current view" state to fall out of step with the address bar.
 * What this does hold is *how* the next switch was asked for, because the
 * address alone cannot say whether the dock, the keyboard, or the back button
 * moved you — and which entrypoint producers actually reach for is the
 * measure `view_changed` exists to take.
 */
export function useEditorNavigation(
  options: UseEditorNavigationOptions,
): EditorNavigation {
  let lastView: EditorViewName | undefined;
  let pendingVia: ViewChangeSource | null = null;
  // Where leaving the Library goes back to (`UI-002`): the view it came from.
  let libraryReturn: EditorViewName = "instrument";

  function selectView(next: EditorViewName, via: ViewChangeSource): void {
    // Asking for the view you are already on is not a switch, so it neither
    // navigates nor logs — otherwise clicking the current dock entry twice
    // would report two switches that never happened.
    const current = options.view();
    if (next === current) return;
    if (next === "library") libraryReturn = current;
    pendingVia = via;
    options.onSelectView(next);
  }

  // One event per switch, whatever moved: the dock and the keyboard set
  // `pendingVia` on their way through `selectView`, and anything else — the
  // back button, a deep link followed in-session — is `url` by elimination.
  // The first run only records where we arrived: opening a project is not a
  // switch, and `project_opened` already measures it.
  createEffect(
    // Both reactive reads are in the compute half, which is the only tracked
    // one: an `analytics` read moved into the apply half below would be read
    // once and never again.
    () => ({ view: options.view(), analytics: options.analytics() }),
    ({ view, analytics }) => {
      const previous = lastView;
      lastView = view;
      const via = pendingVia ?? "url";
      pendingVia = null;
      if (previous === undefined || previous === view) return;
      analytics.log("view_changed", { view, via });
    },
  );

  return { selectView, libraryReturn: () => libraryReturn };
}
