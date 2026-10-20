import type { JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import { ShortcutController } from "./ShortcutController";
import { ShortcutRootContext } from "./useShortcutScope";

/**
 * Mounts the app's one `ShortcutController` on the window and hands it to
 * everything below through `ShortcutRootContext` (GRV-186). Surfaces register
 * scopes on it with `useShortcutScope`; none of them listens for keys itself.
 *
 * Listening on the window rather than on an editor element is what makes a
 * shortcut work while focus sits on a transport button or a fader; the
 * controller's own context and text-entry rules decide whether it acts, so
 * "listens everywhere" never means "fires everywhere".
 */
export default function ShortcutRoot(props: {
  controller?: ShortcutController;
  children: JSX.Element;
}): JSX.Element {
  const controller = props.controller ?? new ShortcutController({});
  // `attach` returns its own detach, which `onSettled` takes as its cleanup.
  onSettled(() => controller.attach(window));
  return <ShortcutRootContext value={controller}>{props.children}</ShortcutRootContext>;
}
