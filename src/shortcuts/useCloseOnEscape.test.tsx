import { cleanup, render } from "@solidjs/testing-library";
import { type JSX, Show } from "@solidjs/web";
import userEvent from "@testing-library/user-event";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCloseOnEscape } from "./useCloseOnEscape";
import { useShortcutScope } from "./useShortcutScope";

afterEach(() => cleanup());

function Popover(props: { onClose(): void }): JSX.Element {
  useCloseOnEscape(() => props.onClose());
  return <div>Popover</div>;
}

// GRV-148: a popover's Escape (the Privacy panel, swing, a track's colour)
// closes the popover and nothing under it, and gives way to a modal dialog
// opened over it: the dialog's modal scope hides the popover's (GRV-186),
// even though the dialog's owner was mounted long before the popover.
describe("useCloseOnEscape (GRV-148)", () => {
  function setup() {
    const [popover, setPopover] = createSignal(true);
    const [modal, setModal] = createSignal(false);
    const below = vi.fn();
    function Modal(): JSX.Element {
      useShortcutScope({
        modal: true,
        handlers: () => ({ "view.close_surface": { run: () => setModal(false) } }),
        contexts: () => ["dialog"],
      });
      return <div role="dialog" aria-modal="true" />;
    }
    function Editor(): JSX.Element {
      useShortcutScope({
        handlers: () => ({ "view.close_surface": { run: () => below() } }),
        contexts: () => [],
      });
      return (
        <Show when={modal()}>
          <Modal />
        </Show>
      );
    }
    render(() => (
      <>
        <Editor />
        <Show when={popover()}>
          <Popover onClose={() => setPopover(false)} />
        </Show>
      </>
    ));
    return { popover, modal, setModal, below, user: userEvent.setup() };
  }

  it("closes the popover alone", async () => {
    const { popover, below, user } = setup();
    await user.keyboard("{Escape}");
    flush();
    expect(popover()).toBe(false);
    expect(below).not.toHaveBeenCalled();
  });

  it("stands down for a modal dialog open over it", async () => {
    const { popover, modal, setModal, user } = setup();
    setModal(true);
    flush();
    await user.keyboard("{Escape}");
    flush();
    expect(modal()).toBe(false);
    expect(popover()).toBe(true);
    await user.keyboard("{Escape}");
    flush();
    expect(popover()).toBe(false);
  });
});
