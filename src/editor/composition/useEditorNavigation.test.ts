import { cleanup, renderHook } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Analytics } from "../../analytics/analytics";
import type { EditorViewName } from "./editorViews";
import { useEditorNavigation } from "./useEditorNavigation";

afterEach(() => cleanup());

/** A route that follows every navigation, and an analytics that records. */
function setup(initial: EditorViewName = "arrangement") {
  const log = vi.fn();
  const analytics = { log } as unknown as Analytics;
  const [view, setView] = createSignal<EditorViewName>(initial);
  const onSelectView = vi.fn((next: EditorViewName) => setView(next));
  const { result } = renderHook(() =>
    useEditorNavigation({ view, onSelectView, analytics: () => analytics }),
  );
  flush();
  return { navigation: result, view, setView, onSelectView, log };
}

describe("useEditorNavigation", () => {
  it("does not log the view the editor opens on", () => {
    const { log } = setup();
    expect(log).not.toHaveBeenCalled();
  });

  it("navigates and logs one view_changed with how the switch was asked for", () => {
    const { navigation, view, onSelectView, log } = setup();
    navigation.selectView("mixer", "dock");
    flush();
    expect(onSelectView).toHaveBeenCalledWith("mixer");
    expect(view()).toBe("mixer");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("view_changed", { view: "mixer", via: "dock" });
  });

  it("neither navigates nor logs when asked for the view already on screen", () => {
    const { navigation, onSelectView, log } = setup("instrument");
    navigation.selectView("instrument", "keyboard");
    flush();
    expect(onSelectView).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a switch the address bar made on its own as `url`", () => {
    const { setView, log } = setup();
    setView("sequence");
    flush();
    expect(log).toHaveBeenCalledWith("view_changed", { view: "sequence", via: "url" });
  });

  it("spends the asked-for source on one switch only", () => {
    const { navigation, setView, log } = setup();
    navigation.selectView("mixer", "keyboard");
    flush();
    setView("arrangement");
    flush();
    expect(log).toHaveBeenLastCalledWith("view_changed", {
      view: "arrangement",
      via: "url",
    });
  });

  it("goes back from the Library to the view it was opened from", () => {
    const { navigation } = setup("mixer");
    expect(navigation.libraryReturn()).toBe("instrument");
    navigation.selectView("library", "keyboard");
    flush();
    expect(navigation.libraryReturn()).toBe("mixer");
  });
});
