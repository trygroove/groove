import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_VIEWS, type EditorViewName } from "./editorViews";
import ViewDock from "./ViewDock";

afterEach(cleanup);

function renderDock(
  view: EditorViewName,
  onSelect: (view: EditorViewName) => void = () => {},
) {
  return render(() => (
    <ViewDock
      view={view}
      href={(target) =>
        `/projects/prj_abc${target === "arrangement" ? "" : `/${target}`}`
      }
      onSelect={onSelect}
      keyHint={(target) => String(EDITOR_VIEWS.indexOf(target) + 1)}
    />
  ));
}

function dock(): HTMLElement {
  return screen.getByRole("navigation", { name: "Views" });
}

describe("ViewDock", () => {
  it("names the three views as links to their own addresses", () => {
    renderDock("arrangement");
    const addresses = {
      Arrangement: "/projects/prj_abc",
      Instrument: "/projects/prj_abc/instrument",
      Mixer: "/projects/prj_abc/mixer",
    };
    for (const [name, href] of Object.entries(addresses)) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it("marks exactly one view as the one you are on", () => {
    const [view, setView] = createSignal<EditorViewName>("arrangement");
    render(() => (
      <ViewDock
        view={view()}
        href={(target) => `/${target}`}
        onSelect={setView}
        keyHint={() => "1"}
      />
    ));
    const current = () => dock().querySelectorAll("[aria-current='page']");
    expect(current()).toHaveLength(1);
    expect(current()[0]).toHaveAccessibleName("Arrangement");

    setView("mixer");
    flush();
    expect(current()).toHaveLength(1);
    expect(current()[0]).toHaveAccessibleName("Mixer");
  });

  it("reports a plain click instead of letting the browser follow the link", () => {
    const onSelect = vi.fn();
    renderDock("arrangement", onSelect);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByRole("link", { name: "Mixer" }).dispatchEvent(event);
    expect(onSelect).toHaveBeenCalledWith("mixer");
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a modified click to the browser, so the address still works", () => {
    const onSelect = vi.fn();
    // Same-document hrefs: an uncancelled click on a path would have jsdom
    // attempt a navigation it does not implement, which is noise, not a find.
    render(() => (
      <ViewDock
        view="arrangement"
        href={(target) => `#${target}`}
        onSelect={onSelect}
        keyHint={() => "1"}
      />
    ));
    const link = screen.getByRole("link", { name: "Mixer" });
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    link.dispatchEvent(event);
    expect(onSelect).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("draws five tiles in key order, each its icon and key, named for its view", () => {
    renderDock("arrangement");
    const tiles = within(dock()).getAllByRole("link");
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "Arrangement",
      "Sequence",
      "Instrument",
      "Library",
      "Mixer",
    ]);
    for (const [index, tile] of tiles.entries()) {
      expect(tile).toHaveTextContent(String(index + 1));
      expect(tile).toHaveAttribute("aria-keyshortcuts", String(index + 1));
      expect(tile.querySelector(".view-dock-icon")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(tile).not.toHaveAttribute("title");
    }
  });

  it("names the view, its key and what it will open in a hover tip", () => {
    render(() => (
      <ViewDock
        view="arrangement"
        href={(target) => `#${target}`}
        onSelect={() => {}}
        keyHint={(target) => String(EDITOR_VIEWS.indexOf(target) + 1)}
        opens={(target) => (target === "sequence" ? "Bass loop" : undefined)}
      />
    ));
    expect(screen.queryByRole("tooltip")).toBeNull();
    const sequence = screen.getByRole("link", { name: "Sequence" });
    fireEvent.pointerEnter(sequence);
    flush();
    expect(screen.getByRole("tooltip")).toHaveTextContent("2 Sequence · Bass loop");
    expect(sequence).toHaveAccessibleDescription("2 Sequence · Bass loop");
    fireEvent.pointerLeave(sequence);
    fireEvent.focus(screen.getByRole("link", { name: "Mixer" }));
    flush();
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/^5 Mixer$/);
  });

  it("dims a view the selection does not fit, and dots one with something set", () => {
    render(() => (
      <ViewDock
        view="arrangement"
        href={(target) => `#${target}`}
        onSelect={() => {}}
        keyHint={() => "1"}
        dimmed={(target) => target === "sequence"}
        marked={(target) => target === "library"}
      />
    ));
    const sequence = screen.getByRole("link", { name: "Sequence" });
    expect(sequence).toHaveClass("view-dock-dimmed");
    expect(sequence).toHaveAttribute("href", "#sequence");
    expect(
      screen.getByRole("link", { name: "Library" }).querySelector(".view-dock-dot"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Mixer" }).querySelector(".view-dock-dot"),
    ).toBeNull();
  });

  it("is keyboard operable, because every entry is a real link", () => {
    const onSelect = vi.fn();
    renderDock("arrangement", onSelect);
    // One focusable link per view, and Enter on one dispatches a click — which the
    // dock treats as a pointer activation rather than handling keys itself.
    const links = dock().querySelectorAll("a[href]:not([tabindex='-1'])");
    expect(links).toHaveLength(EDITOR_VIEWS.length);
    fireEvent.click(screen.getByRole("link", { name: "Instrument" }));
    expect(onSelect).toHaveBeenCalledWith("instrument");
  });
});
