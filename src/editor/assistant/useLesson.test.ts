import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_PARTS, controlAddress } from "../../commands/controlAddress";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { starterWorld } from "../../testing/lessonWorld";
import type { EditorViewName } from "../editorViews";
import { useLesson } from "./useLesson";

function setup() {
  const [project, setProject] = createSignal<Project>(starterWorld().project);
  const [view, setView] = createSignal<EditorViewName>("arrangement");
  const [streaming, setStreaming] = createSignal(false);
  const registry = createControlRegistry();
  const sendLesson = vi.fn(() => true);
  const log = vi.fn();
  const lesson = createRoot(() =>
    useLesson({
      project,
      view,
      playing: () => false,
      conversation: { sendLesson, streaming },
      registry,
      analytics: () => ({ log, logFeatureFirstUse: vi.fn() }),
    }),
  );
  return {
    lesson,
    project,
    setProject,
    setView,
    setStreaming,
    registry,
    sendLesson,
    log,
  };
}

describe("the lesson under way (GRV-43)", () => {
  it("marks where to act, dashed, until the step is over", () => {
    const h = setup();
    const clip = h.project().clips[0];
    if (!clip) throw new Error("no clip");
    const notes = controlAddress(clip.id, CONTROL_PARTS.notes);
    // Four on the floor, with no genre in memory: the backbeat is still to write.
    h.lesson.start("beat", "asked", "beat-snare");
    flush();
    expect(h.registry.markOf(notes)).toBe("previewed");
    h.lesson.skip();
    flush();
    expect(h.registry.markOf(notes)).toBe("none");
  });

  it("holds a lesson's turn while a reply is on its way, and sends the newest", () => {
    const h = setup();
    h.setStreaming(true);
    h.lesson.start("tour", "asked", "tour-library");
    flush();
    expect(h.sendLesson).not.toHaveBeenCalled();
    h.setView("library");
    flush();
    h.setStreaming(false);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
    expect(h.sendLesson).toHaveBeenCalledWith(
      'Finished "The Library": I did it myself.',
      expect.objectContaining({ moment: "bite_done", biteId: "tour-library" }),
      "Tour the studio",
    );
  });

  it("keeps how each bite ended, and starts a chapter at its first bite not done", () => {
    const h = setup();
    h.lesson.start("tour", "asked", "tour-arrangement");
    flush();
    // The arrangement is on screen already: that stop is done at once.
    expect(h.lesson.state()?.endings).toEqual({ "tour-arrangement": "did_it" });
    expect(h.lesson.done()).toEqual(["tour-arrangement"]);
    h.lesson.leave();
    h.lesson.start("tour", "asked");
    flush();
    expect(h.lesson.state()?.biteIndex).toBe(1);
  });

  it("has nothing to show without an editor", () => {
    const h = setup();
    expect(h.lesson.canShowMe).toBe(false);
  });
});
