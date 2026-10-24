import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_PARTS, controlAddress } from "../../commands/controlAddress";
import { createControlRegistry } from "../../controls/registry";
import { createFactoryContext } from "../../domain/factories";
import type { LessonState } from "../../lessons/session";
import { startedAt, starterWorld } from "../../testing/lessonWorld";
import type { EditorViewName } from "../composition/editorViews";
import {
  type LessonEditorPort,
  SHOW_ME_FAILED,
  useLessonShowMe,
} from "./useLessonShowMe";

const settings = { style: "boom_bap" } as const;

function setup(editor?: LessonEditorPort) {
  const [state, setState] = createSignal<LessonState | null>(null);
  const [view] = createSignal<EditorViewName>("arrangement");
  const registry = createControlRegistry();
  const world = starterWorld();
  const shows = createRoot(() =>
    useLessonShowMe({
      state,
      setState,
      world: () => world,
      settings: () => settings,
      view,
      playing: () => false,
      editor,
      registry,
      factory: () => createFactoryContext(),
    }),
  );
  return { shows, state, setState, registry, world };
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

  it("opens the Export dialog as a step that only opens it starts", () => {
    const editor = editorPort();
    const h = setup(editor);
    h.shows.arrive(startedAt("track", "mix-export", h.world, settings).state);
    expect(editor.openExport).toHaveBeenCalledTimes(1);
  });
});
