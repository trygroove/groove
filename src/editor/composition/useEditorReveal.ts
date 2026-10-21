import { type Accessor, onCleanup } from "solid-js";
import type { ControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { type Scheduler, timeoutScheduler } from "../../shared/scheduler";
import type { TrackSelection } from "../tracks/useTrackSelection";
import {
  createEditorControls,
  type EditorControlsHandle,
  type EditorLocation,
} from "./editorControls";
import type { EditorViewName } from "./editorViews";
import type { EditorNavigation } from "./useEditorNavigation";

export interface UseEditorRevealOptions {
  /** The editor's controls by address (`UI-004`). */
  readonly registry: ControlRegistry;
  readonly project: Accessor<Project | null>;
  /** The view on screen, which comes from the URL (`UI-001`). */
  readonly view: Accessor<EditorViewName>;
  readonly navigation: Pick<EditorNavigation, "selectView">;
  readonly selection: Pick<
    TrackSelection,
    "location" | "restore" | "selectTrack" | "selectPad" | "selectPlacement"
  >;
  /** Deferred work, so the focus waits for the view to mount. */
  readonly scheduler?: Scheduler;
}

/**
 * Finding and showing a control by its address (`UI-004`), for the editor
 * that owns the view, the selection and the clip `2` edits.
 *
 * A reveal moves only UI state — the view (a navigation, logged as
 * `reveal`), the selection, the clip `2` edits — and hands back where the
 * editor was, so the caller can put it back. Nothing here reaches the
 * project, its history or a save. A reveal still waiting for its control is
 * cancelled when the editor goes.
 */
export function useEditorReveal(options: UseEditorRevealOptions): EditorControlsHandle {
  const { navigation, selection } = options;
  const editorControls = createEditorControls({
    registry: options.registry,
    project: options.project,
    location: (): EditorLocation => ({
      view: options.view(),
      ...selection.location(),
    }),
    goTo(home) {
      if (home.view) navigation.selectView(home.view, "reveal");
      if (home.trackId) {
        selection.selectTrack(home.trackId);
        if (home.padId) selection.selectPad(home.trackId, home.padId);
      }
      if (home.placementId !== undefined) selection.selectPlacement(home.placementId);
    },
    restore(location) {
      navigation.selectView(location.view, "reveal");
      selection.restore(location);
    },
    scheduler: options.scheduler ?? timeoutScheduler,
  });
  onCleanup(() => editorControls.dispose());
  return editorControls;
}
