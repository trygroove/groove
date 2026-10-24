import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_PARTS, controlAddress } from "../../commands/controlAddress";
import { createControlRegistry } from "../../controls/registry";
import { createFactoryContext } from "../../domain/factories";
import type { LessonState } from "../../lessons/session";
import { startedAt, starterWorld } from "../../testing/lessonWorld";
import type { EditorViewName } from "../composition/editorViews";
import {
  CANNOT_SHOW,
  type LessonEditorPort,
  NOTHING_TO_SHOW,
  SHOW_ME_FAILED,
  useLessonShowMe,
} from "./useLessonShowMe";

const settings = { style: "boom_bap" } as const;

function setup(editor?: LessonEditorPort) {
  const [state, setState] = createSignal<LessonState | null>(null);
  const [view] = createSignal<EditorViewName>("arrangement");
  const registry = createControlRegistry();
  const world = starterWorld();
  const [now, setNow] = createSignal(world);
  const shows = createRoot(() =>
    useLessonShowMe({
      state,
      setState,
      world: now,
      settings: () => settings,
      view,
      playing: () => false,
      editor,
      registry,
      factory: () => createFactoryContext(),
    }),
  );
  return { shows, state, setState, registry, world, setNow };
}

function editorPort(): LessonEditorPort {
  return {
    apply: vi.fn(() => true),
    goTo: vi.fn(),
    point: vi.fn(),
    play: vi.fn(async () => {}),
    putSound: vi.fn(async () => true),
    openExport: vi.fn(),
  };
}

describe("Show me (GRV-190)", () => {
  it("marks where to act and selects it while the step is under way", () => {
    const editor = editorPort();
    const h = setup(editor);
    const clip = h.world.project.clips[0];
    if (!clip) throw new Error("no clip");
    h.setState(startedAt("beat", "beat-snare", h.world, settings).state);
    flush();
    const notes = controlAddress(clip.id, CONTROL_PARTS.notes);
    expect(h.registry.markOf(notes)).toBe("previewed");
    expect(editor.point).toHaveBeenCalledWith(notes);
    h.setState(null);
    flush();
    expect(h.registry.markOf(notes)).toBe("none");
  });

  it("marks the step shown and applies its change through the editor", () => {
    const editor = editorPort();
    const h = setup(editor);
    h.setState(startedAt("beat", "beat-snare", h.world, settings).state);
    flush();
    h.shows.showMe();
    flush();
    expect(editor.apply).toHaveBeenCalledTimes(1);
    expect(h.state()?.step?.shown).toBe(true);
    expect(h.shows.notice()).toBeNull();
  });

  it("takes the mark back and says so when the change would not go in", () => {
    const editor = { ...editorPort(), apply: vi.fn(() => false) };
    const h = setup(editor);
    h.setState(startedAt("beat", "beat-snare", h.world, settings).state);
    flush();
    h.shows.showMe();
    flush();
    expect(h.state()?.step?.shown).toBe(false);
    expect(h.shows.notice()).toBe(SHOW_ME_FAILED);
    h.shows.clearNotice();
    flush();
    expect(h.shows.notice()).toBeNull();
  });

  it("says it cannot act when a step is not done, and waits for a sound on its way", async () => {
    let resolve: (put: boolean) => void = () => {};
    const editor = {
      ...editorPort(),
      putSound: vi.fn(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      ),
    };
    const h = setup(editor);
    h.setState(startedAt("beat", "beat-library", h.world, settings).state);
    flush();
    h.shows.showMe();
    flush();
    expect(h.shows.busy()).toBe(true);
    // A second press while the library looks does nothing.
    h.shows.showMe();
    expect(editor.putSound).toHaveBeenCalledTimes(1);
    resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    flush();
    expect(h.shows.busy()).toBe(false);
  });

  it("says done only of a step that is done, and otherwise that it cannot act", () => {
    const h = setup(editorPort());
    // The arrangement is already on screen: going there is done.
    h.setState(startedAt("tour", "tour-arrangement", h.world, settings).state);
    flush();
    const started = h.state();
    if (!started?.step) throw new Error("no step");
    // Away from it and back: the "open" step is under way, and done here.
    h.setState({ ...started, step: { ...started.step, index: 1 } });
    flush();
    h.shows.showMe();
    flush();
    expect(h.shows.notice()).not.toBe(CANNOT_SHOW);

    // The backbeat with no drum machine left: Show me has nothing to write
    // into, and the step is not done.
    h.setState(startedAt("beat", "beat-snare", h.world, settings).state);
    flush();
    const song = h.world.project.song;
    h.setNow({
      ...h.world,
      project: { ...h.world.project, song: { ...song, tracks: [], placements: [] } },
    });
    flush();
    h.shows.showMe();
    flush();
    expect(h.shows.notice()).toBe(CANNOT_SHOW);
    expect(CANNOT_SHOW).not.toBe(NOTHING_TO_SHOW);
  });

  it("opens the view a term names", () => {
    const editor = editorPort();
    const h = setup(editor);
    h.shows.openView("library");
    expect(editor.goTo).toHaveBeenCalledWith("library");
  });
});
