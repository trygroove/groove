import { cleanup, render, screen } from "@solidjs/testing-library";
import { Show } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickAndFlush } from "../testing/events";
import Dialog from "./Dialog";

afterEach(cleanup);

/**
 * The shared dialog shell (`UI-001`).
 *
 * What these hold to is the part a producer learns once and then expects
 * everywhere: the same name, the same ways out, and focus that comes back.
 * The three dialogs that adopted this had disagreed about all of it.
 */
describe("Dialog", () => {
  it("names itself, and names its two ways out distinctly", () => {
    render(() => (
      <Dialog label="Sequence editor" onClose={() => {}}>
        <p>contents</p>
      </Dialog>
    ));

    expect(screen.getByRole("dialog", { name: "Sequence editor" })).toBeVisible();
    // The surface's name in its own case mid-sentence, and a different verb for
    // the scrim — two controls with one name is ambiguous to anyone choosing
    // between them by name.
    expect(screen.getByRole("button", { name: "Close sequence editor" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Dismiss sequence editor" })).toBeTruthy();
  });

  it("closes from the close control and from the scrim alike", () => {
    const onClose = vi.fn();
    render(() => (
      <Dialog label="Library" onClose={onClose}>
        <p>contents</p>
      </Dialog>
    ));

    clickAndFlush(screen.getByRole("button", { name: "Close library" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    clickAndFlush(screen.getByRole("button", { name: "Dismiss library" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("is not dismissed by the second click of a double-click that opened it", () => {
    const onClose = vi.fn();
    render(() => (
      <Dialog label="Export" onClose={onClose}>
        <p>contents</p>
      </Dialog>
    ));
    const scrim = screen.getByRole("button", { name: "Dismiss export" });

    // The first click opened the dialog; the second (detail 2) lands on the
    // scrim that appeared under the pointer.
    scrim.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    flush();
    expect(onClose).not.toHaveBeenCalled();

    scrim.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes focus when it opens and gives it back when it closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(() => (
      <Dialog label="Packs" onClose={() => {}}>
        <p>contents</p>
      </Dialog>
    ));

    // A dialog opened by a double-click on a canvas leaves focus nowhere
    // useful, so it takes focus itself rather than stranding a keyboard.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close packs" }),
    );

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps a close control even when its contents carry the heading", () => {
    // The library's heading changes with what it is filtered to, so it renders
    // its own and passes no header. The way out still has to be there, and
    // still has to be what takes focus.
    render(() => (
      <Dialog label="Library" size="jumbo" onClose={() => {}}>
        <h2>Loops</h2>
      </Dialog>
    ));

    const close = screen.getByRole("button", { name: "Close library" });
    expect(close).toBeVisible();
    expect(document.activeElement).toBe(close);
    expect(screen.getByRole("heading", { name: "Loops" })).toBeVisible();
  });

  // #876: moving focus in on open was all it did, so Shift+Tab from the
  // library's search field walked straight out to the editor behind the scrim.
  it("makes everything behind it inert while it is open, and only then", () => {
    const [open, setOpen] = createSignal(true);
    render(() => (
      <main>
        <nav>
          <button type="button">Add reverb device</button>
        </nav>
        <section aria-label="Editor">
          <button type="button">Add delay device</button>
          <Show when={open()}>
            <Dialog label="Library" onClose={() => setOpen(false)}>
              <input aria-label="Search sounds" />
            </Dialog>
          </Show>
        </section>
      </main>
    ));

    const reverb = screen.getByRole("button", { name: "Add reverb device" });
    const delay = screen.getByRole("button", { name: "Add delay device" });
    const dialog = screen.getByRole("dialog", { name: "Library" });

    // A sibling at its own level and one an ancestor further out both go inert,
    // while the dialog and the path down to it stay live.
    expect(delay).toHaveAttribute("inert");
    expect(reverb.parentElement).toHaveAttribute("inert");
    expect(dialog.closest("[inert]")).toBeNull();

    setOpen(false);
    flush();
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("lets the newest of two stacked dialogs win, and hands back on close", () => {
    const [second, setSecond] = createSignal(true);
    const [first, setFirst] = createSignal(true);
    render(() => (
      <div>
        <button type="button">Add reverb device</button>
        <Show when={first()}>
          <Dialog label="Library" onClose={() => setFirst(false)}>
            <input aria-label="Search sounds" />
          </Dialog>
        </Show>
        <Show when={second()}>
          <Dialog label="Packs" onClose={() => setSecond(false)}>
            <p>packs</p>
          </Dialog>
        </Show>
      </div>
    ));

    const app = screen.getByRole("button", { name: "Add reverb device" });
    const library = screen.getByRole("dialog", { name: "Library" });
    const packs = screen.getByRole("dialog", { name: "Packs" });

    expect(app).toHaveAttribute("inert");
    expect(library.closest("[inert]")).not.toBeNull();
    expect(packs.closest("[inert]")).toBeNull();

    // The one underneath becomes interactive again; the app does not.
    setSecond(false);
    flush();
    expect(app).toHaveAttribute("inert");
    expect(library.closest("[inert]")).toBeNull();

    // Only the last one closing gives the app back.
    setFirst(false);
    flush();
    expect(document.querySelector("[inert]")).toBeNull();
  });
});
