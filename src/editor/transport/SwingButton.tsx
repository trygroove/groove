import { type JSX, Portal, Show } from "@solidjs/web";
import { type Accessor, createEffect, createSignal } from "solid-js";
import { parameterControl, SONG_ENTITY } from "../../commands/controlAddress";
import type { ControlSettle } from "../../commands/controlGesture";
import { control } from "../../controls/control";
import { SONG_SWING } from "../../domain/parameters";
import { ariaBool } from "../../shared/aria";
import { useCloseOnEscape } from "../../shortcuts";
import SwingControl from "./SwingControl";
import SwingGlyph from "./SwingGlyph";
import "./SwingButton.css";

export interface SwingButtonProps {
  /** The song's swing, 50-75 (%). */
  readonly swing: Accessor<number>;
  onInput(value: number): void;
  onCommit(value: number, settle: ControlSettle): void;
}

/**
 * The transport toolbar's swing entry (#500): a button showing the swing glyph
 * and its value (#819) that opens a small panel holding the swing slider. It
 * reads "on" (brighter) above 50%, and pressed while the panel is open. Like the track colour picker, the panel is
 * portalled, closes on a press outside, on focus leaving, and on
 * `view.close_surface` (Escape); opening focuses the slider and closing
 * returns focus to the button.
 */
export default function SwingButton(props: SwingButtonProps): JSX.Element {
  const [at, setAt] = createSignal<{ left: number; top: number } | null>(null);
  let button: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;

  const open = () => at() !== null;
  const close = (refocus: boolean) => {
    setAt(null);
    if (refocus) button?.focus();
  };
  const toggle = () => {
    if (open() || !button) return close(false);
    const rect = button.getBoundingClientRect();
    setAt({ left: rect.left, top: rect.bottom + 4 });
  };

  createEffect(open, (isOpen) => {
    if (!isOpen) return;
    queueMicrotask(() => panel?.querySelector<HTMLElement>("input[type=range]")?.focus());
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel?.contains(target) && !button?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  });

  const title = () => `Swing ${Math.round(props.swing())}%`;
  // The swing value's home while its panel is closed (`UI-004`): the button
  // shows it, so the button is what a reveal focuses and a mark outlines.
  const swingControl = control(parameterControl(SONG_ENTITY, SONG_SWING.id));
  return (
    <>
      <button
        ref={[
          (el: HTMLButtonElement) => {
            button = el;
          },
          swingControl,
        ]}
        type="button"
        class={props.swing() > 50 ? "swing-toggle is-on" : "swing-toggle"}
        aria-label="Swing"
        title={title()}
        aria-haspopup="dialog"
        aria-expanded={ariaBool(open())}
        onClick={toggle}
      >
        <SwingGlyph size={16} />
        {/* The value, so the bar shows the song's swing without the panel
            (#819). The aria-label stays the button's name. */}
        <span class="swing-value">{Math.round(props.swing())}%</span>
      </button>
      <Show when={at()}>
        {(position) => (
          <Portal>
            <CloseOnEscape onClose={() => close(true)} />
            <div
              ref={panel}
              class="swing-panel"
              role="dialog"
              aria-label="Swing"
              onFocusOut={(event) => {
                const next = event.relatedTarget as Node | null;
                if (next && !panel?.contains(next) && !button?.contains(next)) {
                  close(false);
                }
              }}
              style={{ left: `${position().left}px`, top: `${position().top}px` }}
            >
              <SwingControl
                swing={props.swing}
                onInput={props.onInput}
                onCommit={props.onCommit}
              />
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}

/** `view.close_surface` for the open panel, mounted only while it is open. */
function CloseOnEscape(props: { onClose(): void }): JSX.Element {
  useCloseOnEscape(() => props.onClose());
  return null;
}
