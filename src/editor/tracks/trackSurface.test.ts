import { describe, expect, it, vi } from "vitest";
import { trackSurfaceHandlers } from "./trackSurface";

/** A surface with a control, a self-selecting button and a bare area. */
function surface(selected: boolean) {
  document.body.innerHTML = `<div id="root"><input id="fader"><button class="edit">Edit</button><span id="bare"></span></div>`;
  const onSelect = vi.fn();
  const onDragStart = vi.fn();
  const handlers = trackSurfaceHandlers({
    selected: () => selected,
    onSelect,
    onDragStart,
    controls: "input",
    clickExempt: ".edit",
  });
  const at = (selector: string) => ({ target: document.querySelector(selector) });
  return { handlers, onSelect, onDragStart, at };
}

describe("trackSurfaceHandlers (#447)", () => {
  it("starts a drag from the surface, never from its controls", () => {
    const { handlers, onDragStart, at } = surface(false);
    handlers.onPointerDown(at("#fader") as unknown as PointerEvent);
    expect(onDragStart).not.toHaveBeenCalled();
    handlers.onPointerDown(at("#bare") as unknown as PointerEvent);
    handlers.onPointerDown(at(".edit") as unknown as PointerEvent);
    expect(onDragStart).toHaveBeenCalledTimes(2);
  });

  it("selects on a click or a changed value, but not from what selects itself", () => {
    const { handlers, onSelect, at } = surface(false);
    handlers.onClick(at(".edit") as unknown as MouseEvent);
    expect(onSelect).not.toHaveBeenCalled();
    handlers.onClick(at("#bare") as unknown as MouseEvent);
    handlers.onInput();
    handlers.onChange();
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("does not select a track that already is", () => {
    const { handlers, onSelect, at } = surface(true);
    handlers.onClick(at("#bare") as unknown as MouseEvent);
    handlers.onInput();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
