import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import "./ViewFrame.css";

export interface ViewFrameProps {
  /** The view's accessible name, as a region. */
  readonly label: string;
  readonly class: string;
  readonly header?: JSX.Element;
  readonly footer?: JSX.Element;
  readonly children: JSX.Element;
}

/**
 * A view's frame (`UI-002`): a named region with a header, a body and a
 * footer, filling the editor's body. It is what the shared `Dialog` shell was
 * to the windows the Library used to open in, minus everything that made it a
 * window: no scrim, no close control, no focus trap. A view is left by another
 * view's key.
 */
export default function ViewFrame(props: ViewFrameProps): JSX.Element {
  return (
    <section class={`view-frame ${props.class}`} aria-label={props.label}>
      <Show when={props.header}>
        <header class="view-frame-header">{props.header}</header>
      </Show>
      <div class="view-frame-body">{props.children}</div>
      <Show when={props.footer}>
        <footer class="view-frame-footer">{props.footer}</footer>
      </Show>
    </section>
  );
}
