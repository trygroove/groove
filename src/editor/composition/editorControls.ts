import { createContext, useContext } from "solid-js";
import type { ControlAddress } from "../../commands/controlAddress";
import type { ControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import type { PlacementId } from "../../domain/ids";
import type { SelectionState } from "../../selection";
import type { CancelScheduled, Scheduler } from "../../shared/scheduler";
import type { PadSelection } from "../sequence/padSelection";
import { type ControlHome, controlHome, revealElement } from "./controlReveal";
import type { EditorViewName } from "./editorViews";

/**
 * Where the editor is: the view on screen, the selected track (and pads), and
 * the clip the sequence view edits. All UI state, none of it in the
 * project. `revealControl` hands back the one it left so a caller can return.
 */
export interface EditorLocation {
  readonly view: EditorViewName;
  readonly selection: SelectionState;
  readonly padSelection: PadSelection;
  readonly openPlacementId: PlacementId | null;
}

/**
 * The editor's controls, for code that needs to find, show or mark one
 * (`UI-004`, #850) — AI-004's proposal card first, onboarding's "show me" and
 * search after it. None of it touches a project, a history or a save.
 */
export interface EditorControls {
  /** Every mounted control by address, and the mark on each. */
  readonly registry: ControlRegistry;
  /**
   * Opens the view that shows `address`, selects the track it belongs to
   * (and, for a clip's notes, the clip the sequence view edits), then scrolls the control
   * into view and focuses it once it has mounted. A control with no on-screen
   * home in this layout reveals its track instead. Returns where the editor
   * was, for {@link restoreView}.
   *
   * `focus: false` moves the editor without taking focus from where it is:
   * the assistant's Preview shows a change while the producer's focus stays
   * on the proposal they are deciding about (GRV-5).
   */
  revealControl(address: ControlAddress, options?: RevealOptions): EditorLocation;
  /** Puts the editor back where a reveal found it: its view, selection and the clip `2` edits. */
  restoreView(location: EditorLocation): void;
}

export interface RevealOptions {
  /** Whether to focus the control once it mounts. Defaults to true. */
  readonly focus?: boolean;
}

export const EditorControlsContext = createContext<EditorControls>();

/** The open editor's controls. Throws outside an editor. */
export function useEditorControls(): EditorControls {
  return useContext(EditorControlsContext);
}

/** What `createEditorControls` needs from the editor it serves. */
export interface EditorControlsHost {
  readonly registry: ControlRegistry;
  project(): Project | null | undefined;
  /** Where the editor is now. */
  location(): EditorLocation;
  /** Moves the editor to a control's home. */
  goTo(home: ControlHome): void;
  /** Moves the editor back to a location. */
  restore(location: EditorLocation): void;
  /** Deferred work, so the focus waits for the view to mount. */
  readonly scheduler: Scheduler;
}

/** How often a reveal looks for its control while the view mounts. */
const POLL_MS = 16;
/** Polls before the owner's header is accepted in place of the control itself. */
const FALLBACK_AFTER = 3;
/** Polls before a reveal gives up on focusing anything. */
const GIVE_UP_AFTER = 60;

export interface EditorControlsHandle extends EditorControls {
  /** Cancels a reveal still waiting for its control to mount. */
  dispose(): void;
}

export function createEditorControls(host: EditorControlsHost): EditorControlsHandle {
  let pending: CancelScheduled | null = null;

  const cancelPending = () => {
    pending?.();
    pending = null;
  };

  /** The most recently mounted element still in the document. */
  const mounted = (address: ControlAddress | null): HTMLElement | undefined => {
    if (!address) return undefined;
    return host.registry
      .elementsFor(address)
      .filter((element) => element.isConnected)
      .at(-1);
  };

  /**
   * Focuses the control once its view has mounted. A view switch is a
   * navigation, and the parts register as they mount, so this looks on a short
   * poll rather than once: the control itself as soon as it appears, its
   * owner's header only after a few polls have shown nothing does.
   */
  const focusWhenMounted = (address: ControlAddress, fallback: ControlAddress | null) => {
    let polls = 0;
    const attempt = () => {
      pending = null;
      const element =
        mounted(address) ?? (polls >= FALLBACK_AFTER ? mounted(fallback) : undefined);
      if (element) {
        revealElement(element);
        return;
      }
      polls += 1;
      if (polls < GIVE_UP_AFTER) pending = host.scheduler.schedule(attempt, POLL_MS);
    };
    pending = host.scheduler.schedule(attempt, 0);
  };

  return {
    registry: host.registry,
    revealControl(address, options = {}) {
      const before = host.location();
      cancelPending();
      const project = host.project();
      if (!project) return before;
      const home = controlHome(project, address);
      host.goTo(home);
      if (options.focus !== false) focusWhenMounted(address, home.fallback);
      return before;
    },
    restoreView(location) {
      cancelPending();
      host.restore(location);
    },
    dispose: cancelPending,
  };
}
