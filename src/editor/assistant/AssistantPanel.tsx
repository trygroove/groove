import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, Match, Show, Switch } from "solid-js";
import {
  CloseIcon,
  DockRightIcon,
  FloatIcon,
  MinimiseIcon,
  RestoreIcon,
  SettingsIcon,
  SparkIcon,
} from "../../components/icons";
import AssistantChatView, { WRITING_STATUS } from "./AssistantChatView";
import {
  FLOATING_INSET,
  FLOATING_WIDTH,
  MINIMISED_HEIGHT,
  MINIMISED_WIDTH,
  resizable,
  rightClearance,
} from "./assistantPanelLayout";
import type { AssistantChat } from "./useAssistantChat";
import type { AssistantPanel as AssistantPanelState } from "./useAssistantPanel";
import "./AssistantPanel.css";

export interface AssistantPanelProps {
  readonly panel: AssistantPanelState;
  /**
   * Whether a modal dialog (Export, the shortcut guide) is open.
   * The panel then sits under it and cannot be reached, by pointer or by
   * keyboard, until it closes. The sequence editor is not modal, and the
   * panel floats over it.
   */
  readonly underModal?: () => boolean;
  /**
   * The conversation (GRV-26). Without one the panel is its chrome alone,
   * with a composer that says the assistant is not available.
   */
  readonly chat?: AssistantChat;
}

/**
 * The custom property fixed bottom-right chrome (the release badge, the
 * telemetry disclosure) reads to stand clear of the panel. Set on the root,
 * because that chrome is the app's, not the editor's.
 */
export const CLEARANCE_PROPERTY = "--assistant-clearance";

/** The status a previewed proposal puts in the panel's header and bar (GRV-5). */
export const PREVIEWING_STATUS = "Previewing a change";

/** The status a sound being tried from a recommended pack puts there (GRV-23). */
export const TRYING_STATUS = "Previewing a sound";

function panelStatus(chat: AssistantChat | undefined): string {
  if (chat?.conversation.streaming()) return WRITING_STATUS;
  if (chat?.proposals?.previewing()) return PREVIEWING_STATUS;
  if (chat?.recommendations?.trying()) return TRYING_STATUS;
  return "";
}

/** The note under the composer while there is no conversation to hold. */
export const UNAVAILABLE_NOTE = "The assistant isn't available yet";

/**
 * The assistant's panel (#849, AI-004a): the chrome, its three homes and its
 * resize edge, around the conversation (GRV-26, `AssistantChatView`). It floats bottom-right over the
 * editor, minimises to a bar, docks as a column at the right edge, or closes,
 * and remembers which on this device (`assistantPanelLayout.ts`).
 *
 * The keys are not read here. Escape and the resize edge's arrows go through
 * the shortcut registry (`view.close_surface`, `assistant.grow`/`shrink`), so
 * the panel only says where it is and binds the elements the editor's
 * shortcut layer asks about.
 */
export default function AssistantPanel(props: AssistantPanelProps): JSX.Element {
  const mode = () => props.panel.layout().mode;
  const expanded = () => mode() === "floating" || mode() === "docked";
  const underModal = () => props.underModal?.() ?? false;
  // The assistant's settings (GRV-8), in place of the conversation.
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const hasSettings = () =>
    Boolean(props.chat?.retention && props.chat.account().registered);

  // The room the panel takes at the window's right edge, published for the
  // app's bottom-right chrome so none of it is ever drawn over the panel's
  // buttons or composer. The clearance is the one reactive read; the root
  // write is the apply half's, and its cleanup clears it when the panel goes.
  createEffect(
    () => rightClearance(props.panel.layout()),
    (clearance) => {
      const root = document.documentElement;
      root.style.setProperty(CLEARANCE_PROPERTY, `${clearance}px`);
      return () => root.style.removeProperty(CLEARANCE_PROPERTY);
    },
  );

  return (
    <Show when={mode() !== "closed"}>
      <section
        ref={(element) => props.panel.bindPanel(element)}
        class={["assistant-panel", { "assistant-panel-under-modal": underModal() }]}
        data-mode={props.panel.layout().mode}
        inert={underModal() || undefined}
        style={{
          // The height on screen: never more than the window has room for.
          "--assistant-height": `${Math.min(props.panel.layout().height, props.panel.room())}px`,
          "--assistant-width": `${props.panel.layout().width}px`,
          "--assistant-floating-width": `${FLOATING_WIDTH}px`,
          "--assistant-bar-width": `${MINIMISED_WIDTH}px`,
          "--assistant-bar-height": `${MINIMISED_HEIGHT}px`,
          "--assistant-inset": `${FLOATING_INSET}px`,
        }}
        aria-label="Assistant"
        tabindex={-1}
      >
        <Show when={expanded()}>
          <ResizeEdge panel={props.panel} />
        </Show>
        <header class="assistant-panel-header">
          {/* A click on the bar floats it again. The Restore button is the
              keyboard's way to do the same, so this is pointer sugar only. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer sugar for the Restore button beside it */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the Restore button is the keyboard path */}
          <div
            class="assistant-panel-grab"
            onClick={() => {
              if (mode() === "minimised") props.panel.float();
            }}
          >
            <span class="assistant-panel-title">
              <SparkIcon size={12} />
              Assistant
            </span>
            {/* The status slot, so the minimised bar still says it:
                "Writing…" while a reply streams, "Previewing a change" while a
                proposal is previewed (GRV-5), "Previewing a sound" while a
                recommended sound is tried (GRV-23). */}
            <span class="assistant-panel-status">{panelStatus(props.chat)}</span>
          </div>
          <Switch>
            <Match when={mode() === "docked"}>
              <HeaderButton
                label="Float"
                title="Float over the view"
                onClick={() => props.panel.float()}
              >
                <FloatIcon size={14} />
              </HeaderButton>
            </Match>
            <Match when={mode() === "minimised"}>
              <HeaderButton label="Restore" onClick={() => props.panel.float()}>
                <RestoreIcon size={14} />
              </HeaderButton>
              <HeaderButton
                label="Dock to the right"
                title="Dock to the right edge"
                onClick={() => props.panel.dock()}
              >
                <DockRightIcon size={14} />
              </HeaderButton>
            </Match>
            <Match when={mode() === "floating"}>
              <HeaderButton label="Minimise" onClick={() => props.panel.minimise()}>
                <MinimiseIcon size={14} />
              </HeaderButton>
              <HeaderButton
                label="Dock to the right"
                title="Dock to the right edge"
                onClick={() => props.panel.dock()}
              >
                <DockRightIcon size={14} />
              </HeaderButton>
            </Match>
          </Switch>
          <Show when={expanded() && hasSettings()}>
            <button
              type="button"
              class="assistant-panel-button"
              aria-label="Assistant settings"
              title="Assistant settings: what Groove keeps of your conversations"
              aria-pressed={settingsOpen() ? "true" : "false"}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SettingsIcon size={14} />
            </button>
          </Show>
          <HeaderButton label="Close" onClick={() => props.panel.close()}>
            <CloseIcon size={14} />
          </HeaderButton>
        </header>
        <Show when={expanded() && props.chat}>
          {(chat) => (
            <AssistantChatView
              chat={chat()}
              bindComposer={(element) => props.panel.bindComposer(element)}
              bindAskText={(element) => props.panel.bindAskText(element)}
              focusComposer={() => props.panel.focusComposer()}
              settingsOpen={settingsOpen}
              closeSettings={() => setSettingsOpen(false)}
            />
          )}
        </Show>
        <Show when={expanded() && !props.chat}>
          <div class="assistant-panel-log" role="log" aria-label="Conversation" />
          <div class="assistant-panel-composer">
            <textarea
              class="assistant-panel-input"
              aria-label="Message the assistant"
              aria-describedby="assistant-panel-unavailable"
              disabled
            />
            <p id="assistant-panel-unavailable" class="assistant-panel-note">
              {UNAVAILABLE_NOTE}
            </p>
          </div>
        </Show>
      </section>
    </Show>
  );
}

function HeaderButton(props: {
  readonly label: string;
  readonly title?: string;
  readonly onClick: () => void;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      class="assistant-panel-button"
      aria-label={props.label}
      title={props.title ?? props.label}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

/**
 * The resize edge: the top edge while floating (the height), the left edge
 * while docked (the width). A separator with its value, so a screen reader
 * announces the size; dragged with the pointer, stepped with the arrows
 * through the registry, and reset with a double-click.
 */
function ResizeEdge(props: { readonly panel: AssistantPanelState }): JSX.Element {
  const docked = () => props.panel.layout().mode === "docked";
  const size = () => resizable(props.panel.layout(), props.panel.room());

  function startDrag(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (event.button !== 0) return;
    const current = size();
    if (!current) return;
    event.preventDefault();
    const edge = event.currentTarget;
    edge.setPointerCapture?.(event.pointerId);
    edge.focus();
    const alongWidth = docked();
    const from = alongWidth ? event.clientX : event.clientY;
    const move = (moved: PointerEvent) => {
      const to = alongWidth ? moved.clientX : moved.clientY;
      // The edge is on the panel's top or left, so moving it up or left grows it.
      props.panel.setSize(current.value + (from - to));
    };
    const end = () => {
      props.panel.endResize();
      edge.removeEventListener("pointermove", move);
      edge.removeEventListener("pointerup", end);
      edge.removeEventListener("pointercancel", end);
    };
    edge.addEventListener("pointermove", move);
    edge.addEventListener("pointerup", end);
    edge.addEventListener("pointercancel", end);
  }

  return (
    // biome-ignore lint/a11y/useFocusableInteractive: it is focusable; Solid's JSX types spell the attribute `tabindex`, which the rule does not read
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or a pointer drag, and this separator is a focusable splitter
    <div
      ref={(element) => props.panel.bindEdge(element)}
      class="assistant-panel-edge"
      role="separator"
      tabindex={0}
      aria-orientation={docked() ? "vertical" : "horizontal"}
      aria-label={docked() ? "Resize width" : "Resize height"}
      aria-valuemin={size()?.range.min}
      aria-valuemax={size()?.range.max}
      aria-valuenow={size()?.value}
      title="Drag to resize; double-click to reset"
      onPointerDown={startDrag}
      onDblClick={() => props.panel.resetSize()}
    />
  );
}
