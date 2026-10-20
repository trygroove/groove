import { cleanup, render } from "@solidjs/testing-library";
import { type JSX, Show } from "@solidjs/web";
import userEvent from "@testing-library/user-event";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCloseOnEscape } from "./useCloseOnEscape";
import { useShortcuts } from "./useShortcuts";

afterEach(() => cleanup());

function Popover(props: { onClose(): void }): JSX.Element {
  useCloseOnEscape(() => props.onClose());
  return <div>Popover</div>;
}

// GRV-148: a popover's Escape (the Privacy panel, swing, a track's colour)
// closes the popover and nothing under it, and gives way to a modal dialog
// opened over it, even one whose Escape an older controller owns.
describe("useCloseOnEscape (GRV-148)", () => {
  function setup() {
    const [popover, setPopover] = createSignal(true);
    const [modal, setModal] = createSignal(false);
    const below = vi.fn();
    function Editor(): JSX.Element {
      useShortcuts({
        handlers: () => ({
          "view.close_surface": { run: () => (modal() ? setModal(false) : below()) },
        }),
        contexts: () => [],
      });
      return (
        <Show when={modal()}>
          <div role="dialog" aria-modal="true" />
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
