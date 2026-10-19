import type { JSX } from "@solidjs/web";
import { HiSolidXMark } from "solid-icons/hi";
import { onSettled, Show } from "solid-js";
import "./Dialog.css";
import { holdModal } from "./modalInert";

/**
 * How much of the view the dialog takes.
 *
 * `jumbo` is the working surface: a window over the view that opened it,
 * taking almost all of it. It is for the surfaces the producer *works in* —
 * the sequence editor, whose piano roll exists to be given room, and the
 * library, which is a tree you read rather than a prompt you answer.
 *
 * `panel` is the bounded one, centred and no larger than its contents need.
 * It is for a dialog you answer and dismiss.
 */
export type DialogSize = "jumbo" | "panel" | "modal";

export interface DialogProps {
  /**
   * The dialog's accessible name. Stable, and not the same thing as the
   * visible heading: the library's heading changes with what it is filtered
   * to, while what it *is* stays "Library".
   */
  readonly label: string;
  readonly size?: DialogSize;
  /**
   * An extra class on the dialog itself, for the one surface that needs its own
   * width (the Export dialog). The chrome stays this file's.
   */
  readonly class?: string;
  /**
   * Rendered in the header bar beside the close button. Omit it and there is
   * no header bar at all, for a dialog whose contents carry their own.
   */
  readonly header?: JSX.Element;
  readonly footer?: JSX.Element;
  /**
   * No padding around the contents, for full-bleed panes that draw their own
   * edges. Everything else gets the shell's inset, aligned with the header.
   */
  readonly flush?: boolean;
  readonly children: JSX.Element;
  /** What the close button, and a click on the scrim, both do. */
  onClose(): void;
}

/**
 * The one dialog shell (`UI-001`).
 *
 * The editor grew three of these independently — the sequence editor, the
 * library, and the pack browser — and they disagreed about everything a
 * producer can see: three backdrops at three z-indexes, three paddings, three
 * corner radii, and three different ways to get out (a header ✕, a footer
 * button, and a click on the scrim). That is not a style problem. A dialog is
 * a thing the app interrupts you with, and if each one interrupts differently
 * you have to read it before you can dismiss it.
 *
 * So the chrome lives here and the contents stay theirs. What every dialog
 * now shares:
 *
 * - **A way out that is always the same.** A close button, a scrim you can
 *   click, and `Escape` — which the surface registers through the shortcut
 *   registry (`view.close_surface`), never its own listener.
 * - **The scrim is a real button.** "Click outside to dismiss" is otherwise a
 *   mouse-only affordance; as a button it is one accessible thing, kept out
 *   of the tab order because the close button is the keyboard path.
 * - **Focus goes in and comes back.** The close button takes focus on open,
 *   and whatever opened the dialog gets it back on close, so a keyboard does
 *   not get dropped at the top of the document.
 * - **Nothing behind it can be reached.** While it is open the rest of the
 *   app is `inert` (#876), so Tab, Shift+Tab, a click and a screen reader all
 *   stay inside it. Stacked dialogs hand that on: the newest one wins.
 *   Shortcuts run through the registry's window listener and are unaffected.
 */
export default function Dialog(props: DialogProps): JSX.Element {
  let closeButton!: HTMLButtonElement;
  let backdrop!: HTMLDivElement;

  /**
   * "Close sequence editor", not "Close Sequence editor": the label names the
   * surface, and a name reads as a name mid-sentence only in its own case.
   */
  const closeLabel = (): string =>
    `Close ${props.label.charAt(0).toLowerCase()}${props.label.slice(1)}`;
  /**
   * The scrim is a second way to do the same thing, so it cannot carry the
   * same name — two controls called "Close library" is ambiguous to anyone
   * choosing between them by name, and to any test that looks one up.
   */
  const dismissLabel = (): string =>
    `Dismiss ${props.label.charAt(0).toLowerCase()}${props.label.slice(1)}`;

  onSettled(() => {
    const opener = document.activeElement;
    const release = holdModal(backdrop);
    closeButton.focus();
    return () => {
      // Released first: an inert opener cannot take focus back.
      release();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  });

  return (
    <div
      ref={backdrop}
      class={`dialog-backdrop dialog-backdrop-${props.size ?? "panel"}`}
    >
      <button
        type="button"
        class="dialog-scrim"
        tabindex={-1}
        aria-label={dismissLabel()}
        onClick={(event) => {
          // The second click of a double-click on whatever opened this dialog
          // lands on the scrim that just appeared under the pointer. It is the
          // tail of the gesture that opened the dialog, not a dismissal.
          if (event.detail > 1) return;
          props.onClose();
        }}
      />
      <section
        class={["dialog", `dialog-${props.size ?? "panel"}`, props.class]}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
      >
        <Show when={props.header}>
          <header class="dialog-header">
            {props.header}
            <button
              type="button"
              class="dialog-close"
              ref={closeButton}
              aria-label={closeLabel()}
              onClick={() => props.onClose()}
            >
              <HiSolidXMark size={18} />
            </button>
          </header>
        </Show>
        <div class={props.flush ? "dialog-body dialog-body-flush" : "dialog-body"}>
          {props.children}
        </div>
        <Show when={props.footer}>
          <footer class="dialog-footer">{props.footer}</footer>
        </Show>
        {/*
         * A dialog with no header bar still needs a close button, and it still
         * needs to be the thing that takes focus on open. Rendered last in the
         * DOM but pinned to the corner, so a screen reader meets the contents
         * before the way out of them.
         */}
        <Show when={!props.header}>
          <button
            type="button"
            class="dialog-close dialog-close-floating"
            ref={closeButton}
            aria-label={closeLabel()}
            onClick={() => props.onClose()}
          >
            <HiSolidXMark size={18} />
          </button>
        </Show>
      </section>
    </div>
  );
}
