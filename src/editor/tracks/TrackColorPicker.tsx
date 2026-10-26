import { For, type JSX, Portal, Show } from "@solidjs/web";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import { updateTrack } from "../../commands";
import type { Track } from "../../domain/entities";
import { TRACK_PALETTE } from "../../domain/trackPalette";
import { ariaBool } from "../../shared/aria";
import { useShortcutScope } from "../../shortcuts";
import "./TrackColorPicker.css";

export interface TrackColorPickerProps {
  readonly track: Track;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  /**
   * Opens the gesture everything chosen while the menu is open commits
   * through, as one undo entry. Without it each choice is its own edit.
   */
  readonly beginGesture?: (options?: GestureOptions) => Gesture | undefined;
  /** Defaults to the application singleton; injectable for tests. */
  readonly analytics?: Analytics;
  /**
   * "swatch" (default) is the small colour square of a track header; "bar" is
   * a transparent hit area laid over the colour border along a mixer strip's
   * top edge, which is what shows the colour there.
   */
  readonly variant?: "swatch" | "bar";
}

/**
 * A track's colour swatch, which is also where the colour is chosen (#447).
 * It opens the track palette; a choice is one `track.update`, undoable like
 * any edit. The swatches are a native radio group — one Tab stop, arrow keys
 * move and choose between them, no key handler of ours — and the menu closes
 * on a click, a press anywhere else, focus leaving it, or `view.close_surface`.
 *
 * Arrowing previews each colour live, but everything chosen while the menu is
 * open is one gesture: one undo entry and one revision, committed when the menu
 * closes (none if nothing changed). Escape cancels the gesture, so the track
 * returns to the colour it had when the menu opened.
 *
 * The menu is portalled to the body: the arrangement's header column clips
 * and translates its rows, which would cut a menu off inside the row.
 */
export default function TrackColorPicker(props: TrackColorPickerProps): JSX.Element {
  const analytics = () => props.analytics ?? defaultAnalytics;
  const [at, setAt] = createSignal<{ left: number; top: number } | null>(null);
  let button: HTMLButtonElement | undefined;
  let menu: HTMLFieldSetElement | undefined;

  let gesture: Gesture | undefined;
  const endGesture = (revert: boolean) => {
    if (revert) gesture?.cancel();
    else if (gesture?.active) gesture.commit();
    gesture = undefined;
  };
  onCleanup(() => endGesture(false));

  const open = () => at() !== null;
  const close = (refocus: boolean, revert = false) => {
    endGesture(revert);
    setAt(null);
    if (refocus) button?.focus();
  };
  const toggle = () => {
    if (open() || !button) return close(false);
    const rect = button.getBoundingClientRect();
    setAt({ left: rect.left, top: rect.bottom + 4 });
  };
  // A radio's arrow keys select as they move, so a change is a choice that
  // leaves the menu open; only a pointer click closes it (a click with
  // `detail > 0` — a keyboard-synthesised one reports 0).
  let pointerChoice = false;
  const choose = (color: string) => {
    const closing = pointerChoice;
    pointerChoice = false;
    if (color !== props.track.color) {
      const command = updateTrack(props.track.id, { color });
      if (!gesture?.active) {
        gesture = props.beginGesture?.({ summary: "Change track colour" });
      }
      const result = gesture ? gesture.apply(command) : props.dispatch(command);
      if (result?.ok) analytics().logFeatureFirstUse("track_color");
    }
    if (closing) close(true);
  };

  // While open, a press outside closes it, and the current colour (or the
  // first) takes focus so the keyboard starts inside the palette.
  createEffect(open, (isOpen) => {
    if (!isOpen) return;
    queueMicrotask(() =>
      (
        menu?.querySelector<HTMLElement>("input:checked") ??
        menu?.querySelector<HTMLElement>("input")
      )?.focus(),
    );
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu?.contains(target) && !button?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  });

  return (
    <>
      <button
        ref={button}
        type="button"
        class={props.variant === "bar" ? "mixer-strip-color" : "track-header-swatch"}
        style={props.variant === "bar" ? undefined : { background: props.track.color }}
        aria-expanded={ariaBool(open())}
        aria-label={`Colour for ${props.track.name}`}
        onClick={toggle}
      />
      <Show when={at()}>
        {(position) => (
          <Portal>
            <PaletteKeys
              onCancel={() => close(true, true)}
              onConfirm={() => close(true)}
            />
            <fieldset
              ref={menu}
              class="track-color-menu"
              onFocusOut={(event) => {
                const next = event.relatedTarget as Node | null;
                if (!menu?.contains(next) && !button?.contains(next)) close(false);
              }}
              style={{ left: `${position().left}px`, top: `${position().top}px` }}
            >
              <legend class="visually-hidden">{`Colour for ${props.track.name}`}</legend>
              <For each={TRACK_PALETTE}>
                {(color, index) => (
                  <input
                    type="radio"
                    name={`track-colour-${props.track.id}`}
                    checked={color === props.track.color}
                    aria-label={`Colour ${index() + 1} of ${TRACK_PALETTE.length}`}
                    style={{ background: color }}
                    onClick={(event) => {
                      pointerChoice = event.detail > 0;
                      // Clicking the swatch already chosen fires no change.
                      if (pointerChoice && color === props.track.color) choose(color);
                    }}
                    onChange={() => choose(color)}
                  />
                )}
              </For>
            </fieldset>
          </Portal>
        )}
      </Show>
    </>
  );
}

/**
 * The open palette's keys, mounted only while it is open: a closed picker, one
 * per track header, installs no shortcut scope at all. `view.close_surface`
 * (Escape) cancels the previewed colour; `track.colour_confirm` (Enter, Space)
 * keeps it (GRV-217): arrowing already chose it, so confirming is closing, which
 * commits the gesture. A radio does neither natively.
 */
function PaletteKeys(props: { onCancel(): void; onConfirm(): void }): JSX.Element {
  useShortcutScope({
    handlers: () => ({
      "view.close_surface": { run: props.onCancel },
      "track.colour_confirm": { run: props.onConfirm },
    }),
    contexts: () => ["colour_palette"],
  });
  return null;
}
