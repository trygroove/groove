import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import type { AssistantPanelLayout } from "./assistantPanelLayout";
import * as layouts from "./assistantPanelLayout";

export interface UseAssistantPanelOptions {
  /** Where the layout is remembered. Defaults to this browser's local storage. */
  readonly storage?: Storage | null;
  /** Read when the panel opens; the shared catalog-backed instance otherwise. */
  readonly analytics?: () => Analytics | undefined;
}

/**
 * One editor's assistant panel (#849): where it is, how big, and the focus it
 * moves. The editor holds one, hands it to the panel, the header's button and
 * the shortcut layer, and every change goes through here, so the three cannot
 * disagree about where the panel is.
 */
export interface AssistantPanel {
  readonly layout: Accessor<AssistantPanelLayout>;
  /**
   * The most the floating panel can be in this window (`floatingRoom`),
   * followed as the window resizes, so the panel is always on screen.
   */
  readonly room: Accessor<number>;
  /**
   * The header button and Cmd/Ctrl+K: open where it was last, or close.
   * `opener` is what gets focus back when the panel closes; it defaults to
   * whatever has focus now.
   */
  toggle(opener?: Element | null): void;
  minimise(): void;
  /** Float the panel: from the bar, or from the dock. */
  float(): void;
  dock(): void;
  close(): void;
  /**
   * One step of a drag on the resize edge: the size it controls in this mode.
   * Shown at once but not remembered until `endResize`, so a drag writes the
   * device's storage once rather than on every pointer move.
   */
  setSize(value: number): void;
  /** The end of a drag on the resize edge: remember the size it left. */
  endResize(): void;
  /** A key on the resize edge: out (positive) or in (negative) by pixels. */
  resizeBy(by: number): void;
  /** A double-click on the resize edge. */
  resetSize(): void;
  /** Escape, while focus is in the panel; `undefined` when it means nothing. */
  dismissAction(): (() => void) | undefined;
  /** Whether the resize edge has keyboard focus, for the `resize_edge` context. */
  edgeHasFocus(): boolean;
  /** Whether the composer has keyboard focus, for the `composer` context. */
  composerHasFocus(): boolean;
  /**
   * Whether a question's "something else" box has focus (GRV-42). It is a
   * composer too: the `composer` context, where Enter sends what it says.
   */
  askTextHasFocus(): boolean;
  /**
   * Whether focus is in the panel but in neither text box nor on the resize
   * edge, where a question's keys (`assistant_ask`, GRV-42) go.
   */
  focusInPanelOutsideFields(): boolean;
  /** Puts focus in the composer, if there is one to type into. */
  focusComposer(): void;
  /** Bound by the panel and the header's button. */
  bindPanel(element: HTMLElement | undefined): void;
  bindEdge(element: HTMLElement | undefined): void;
  bindLauncher(element: HTMLElement | undefined): void;
  /**
   * Bound by the composer while there is one to type into. Opening the panel
   * puts focus there rather than on the panel, so it is ready to type into.
   */
  bindComposer(element: HTMLElement | undefined): void;
  /** Bound by a question's "something else" box while one is waiting. */
  bindAskText(element: HTMLElement | undefined): void;
}

/** Where focus goes once the panel has rendered its next mode. */
type FocusIntent = "panel" | "opener" | null;

export function useAssistantPanel(
  options: UseAssistantPanelOptions = {},
): AssistantPanel {
  const storage = options.storage;
  const [layout, setLayout] = createSignal<AssistantPanelLayout>(
    layouts.loadLayout(storage),
  );
  const windowRoom = () =>
    layouts.floatingRoom(
      typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerHeight,
    );
  const [room, setRoom] = createSignal(windowRoom());
  if (typeof window !== "undefined") {
    const onResize = () => setRoom(windowRoom());
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  }
  let panelElement: HTMLElement | undefined;
  let edgeElement: HTMLElement | undefined;
  let launcherElement: HTMLElement | undefined;
  let composerElement: HTMLElement | undefined;
  let askTextElement: HTMLElement | undefined;
  let opener: HTMLElement | null = null;
  let pendingFocus: FocusIntent = null;

  const focusIsIn = (element: HTMLElement | undefined): boolean => {
    const active = document.activeElement;
    return element?.contains(active) ?? false;
  };

  /** Focus that would be lost with the panel: inside it, or on nothing. */
  const focusWouldDrop = (): boolean =>
    focusIsIn(panelElement) ||
    document.activeElement === null ||
    document.activeElement === document.body;

  function apply(next: AssistantPanelLayout, focus: FocusIntent, save = true): void {
    pendingFocus = focus;
    setLayout(next);
    if (save) layouts.saveLayout(next, storage);
  }

  // Focus moves once the panel has rendered its new mode: into the panel when
  // it opens or changes home from inside, back to the opener when it closes.
  // The mode is the effect's one reactive read; the focus is a DOM write, so
  // it lives in the apply half.
  createEffect(
    () => layout().mode,
    (mode) => {
      const intent = pendingFocus;
      pendingFocus = null;
      if (intent === "panel" && mode !== "closed") {
        const composer = composerElement?.isConnected ? composerElement : undefined;
        (composer ?? panelElement)?.focus();
      }
      if (intent === "opener") {
        const target = opener?.isConnected ? opener : launcherElement;
        opener = null;
        target?.focus();
      }
    },
  );

  function open(from: Element | null | undefined): void {
    const active = from === undefined ? document.activeElement : from;
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
    apply(layouts.toggle(layout()), "panel");
    (options.analytics?.() ?? defaultAnalytics).logFeatureFirstUse("assistant");
  }

  function close(): void {
    apply(layouts.close(layout()), focusWouldDrop() ? "opener" : null);
  }

  /** A move between homes keeps focus in the panel if it was there. */
  function move(next: AssistantPanelLayout): void {
    apply(next, focusWouldDrop() ? "panel" : null);
  }

  return {
    layout,
    room,
    toggle(from) {
      if (layouts.isOpen(layout())) close();
      else open(from);
    },
    minimise: () => move(layouts.minimise(layout())),
    float: () => move(layouts.float(layout())),
    dock: () => move(layouts.dock(layout())),
    close,
    setSize: (value) => apply(layouts.setSize(layout(), value, room()), null, false),
    endResize: () => layouts.saveLayout(layout(), storage),
    resizeBy: (by) => apply(layouts.resizeBy(layout(), by, room()), null),
    resetSize: () => apply(layouts.resetSize(layout(), room()), null),
    dismissAction() {
      if (!focusIsIn(panelElement)) return undefined;
      const next = layouts.dismiss(layout());
      if (!next) return undefined;
      return next.mode === "closed" ? close : () => move(next);
    },
    edgeHasFocus: () =>
      edgeElement !== undefined && document.activeElement === edgeElement,
    composerHasFocus: () =>
      composerElement !== undefined && document.activeElement === composerElement,
    askTextHasFocus: () =>
      askTextElement !== undefined && document.activeElement === askTextElement,
    focusInPanelOutsideFields() {
      const active = document.activeElement;
      return (
        focusIsIn(panelElement) &&
        active !== composerElement &&
        active !== askTextElement &&
        active !== edgeElement
      );
    },
    focusComposer() {
      if (composerElement?.isConnected) composerElement.focus();
    },
    bindPanel(element) {
      panelElement = element;
    },
    bindEdge(element) {
      edgeElement = element;
    },
    bindLauncher(element) {
      launcherElement = element;
    },
    bindComposer(element) {
      composerElement = element;
    },
    bindAskText(element) {
      askTextElement = element;
    },
  };
}
