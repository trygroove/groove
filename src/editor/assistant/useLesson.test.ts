import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_PARTS, controlAddress } from "../../commands/controlAddress";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { BEAT_PATTERNS, beatStyleFor } from "../../lessons/style";
import { starterWorld } from "../../testing/lessonWorld";
import type { EditorViewName } from "../editorViews";
import { createLessonStore, type LessonStore } from "./lessonStore";
import { type LessonEditorPort, SHOW_ME_SETTLE_MS, useLesson } from "./useLesson";

/** `project` at `tempo` BPM, as a committed edit would leave it. */
function tempoed(project: Project | null, tempo: number): Project {
  if (!project) throw new Error("no project");
  return { ...project, song: { ...project.song, tempo } };
}

function setup(
  editor?: LessonEditorPort,
  open = true,
  saved?: { key: () => string | null; store: LessonStore },
) {
  const [project, setProject] = createSignal<Project | null>(
    open ? starterWorld().project : null,
  );
  const [playing, setPlaying] = createSignal(false);
  const [view, setView] = createSignal<EditorViewName>("arrangement");
  const [streaming, setStreaming] = createSignal(false);
  const registry = createControlRegistry();
  const sendLesson = vi.fn(() => true);
  const log = vi.fn();
  const lesson = createRoot(() =>
    useLesson({
      project,
      view,
      playing,
      conversation: { sendLesson, streaming },
      registry,
      editor,
      analytics: () => ({ log, logFeatureFirstUse: vi.fn() }),
      saved,
    }),
  );
  return {
    lesson,
    project,
    setProject,
    setView,
    setPlaying,
    setStreaming,
    registry,
    sendLesson,
    log,
  };
}

describe("the lesson under way (GRV-43)", () => {
  it("marks where to act, dashed, until the step is over", () => {
    const h = setup();
    const clip = h.project()?.clips[0];
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

  it("holds a lesson's turn while a reply is on its way, then sends it", () => {
    const h = setup();
    h.setStreaming(true);
    h.lesson.start("tour", "asked", "tour-library");
    flush();
    expect(h.sendLesson).not.toHaveBeenCalled();
    h.setStreaming(false);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
    expect(h.sendLesson).toHaveBeenCalledWith(
      'Let\'s do "The Library".',
      expect.objectContaining({ moment: "bite_started", earlier: [] }),
      "Tour the studio",
    );
  });

  it("still brings a bite finished while Coproducer writes to it, with the next bite", () => {
    const h = setup();
    h.setStreaming(true);
    // Coproducer is still writing as the producer finishes "Pick a kick" and
    // goes straight on to the next bite.
    h.lesson.start("beat", "asked", "beat-library");
    flush();
    h.lesson.skip();
    flush();
    h.lesson.next();
    flush();
    expect(h.sendLesson).not.toHaveBeenCalled();
    h.setStreaming(false);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
    expect(h.sendLesson).toHaveBeenCalledWith(
      'Skipped "Pick a kick". Let\'s do "The kick pattern".',
      expect.objectContaining({
        moment: "bite_started",
        biteId: "beat-kick",
        // The first bite's intro is stale by now; its end is not.
        earlier: [
          {
            moment: "bite_done",
            chapter: "Make a beat",
            bite: "Pick a kick",
            how: "skipped",
            changes: [],
          },
        ],
      }),
      "Make a beat",
    );
  });

  it("keeps a bite's intro with the step done before it went, and sends each turn once", () => {
    const h = setup();
    h.setStreaming(true);
    h.lesson.start("tour", "asked", "tour-library");
    flush();
    h.setView("library");
    flush();
    h.setStreaming(false);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
    expect(h.sendLesson).toHaveBeenCalledWith(
      'Let\'s do "The Library". Finished "The Library": I did it myself.',
      expect.objectContaining({
        moment: "bite_done",
        earlier: [
          expect.objectContaining({ moment: "bite_started", bite: "The Library" }),
        ],
      }),
      "Tour the studio",
    );
    // Nothing waits any more: a later turn goes alone.
    h.lesson.next();
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(2);
    expect(h.sendLesson).toHaveBeenLastCalledWith(
      'Let\'s do "The Mixer".',
      expect.objectContaining({ earlier: [] }),
      "Tour the studio",
    );
  });

  it("does not start without a project, and says so", () => {
    const h = setup(undefined, false);
    expect(h.lesson.start("beat", "nudge", "beat-kick")).toBe(false);
    expect(h.lesson.state()).toBeNull();
    const open = setup();
    expect(open.lesson.start("beat", "nudge", "beat-kick")).toBe(true);
  });

  it("keeps how each bite ended, and starts a chapter at its first bite not done", () => {
    const h = setup();
    h.lesson.start("tour", "asked", "tour-arrangement");
    flush();
    // The arrangement is on screen already, which is not going there: the
    // stop is done once the producer steps away and comes back.
    expect(h.lesson.state()?.endings).toEqual({});
    h.setView("sequence");
    flush();
    expect(h.lesson.state()?.endings).toEqual({});
    h.setView("arrangement");
    flush();
    expect(h.lesson.state()?.endings).toEqual({ "tour-arrangement": "did_it" });
    expect(h.lesson.done()).toEqual(["tour-arrangement"]);
    h.lesson.leave();
    h.lesson.start("tour", "asked");
    flush();
    expect(h.lesson.state()?.biteIndex).toBe(1);
  });

  it("counts Show me only once the editor has acted", async () => {
    const editor: LessonEditorPort = {
      apply: vi.fn(() => false),
      goTo: vi.fn(),
      point: vi.fn(),
      play: vi.fn(async () => {}),
      putSound: vi.fn(async () => false),
    };
    const h = setup(editor);
    // The editor refuses the backbeat's commands (a gesture under way, say).
    h.lesson.start("beat", "asked", "beat-snare");
    flush();
    h.lesson.showMe();
    flush();
    expect(editor.apply).toHaveBeenCalledTimes(1);
    expect(h.lesson.notice()).not.toBeNull();
    expect(h.lesson.state()?.step?.shown).toBe(false);

    // The library has no kick to give.
    h.lesson.start("beat", "asked", "beat-library");
    flush();
    h.lesson.showMe();
    flush();
    // Marked while the library looks, so the sound it puts is Show me's.
    expect(h.lesson.state()?.step?.shown).toBe(true);
    await Promise.resolve();
    flush();
    expect(editor.putSound).toHaveBeenCalledTimes(1);
    expect(h.lesson.notice()).not.toBeNull();
    expect(h.lesson.state()?.step?.shown).toBe(false);
  });

  it("takes Show me back when the song does not start or the view does not open", async () => {
    vi.useFakeTimers();
    try {
      const editor: LessonEditorPort = {
        apply: vi.fn(() => true),
        goTo: vi.fn(),
        point: vi.fn(),
        // Playback could not start (the browser blocked it, say).
        play: vi.fn(async () => {}),
        putSound: vi.fn(async () => false),
      };
      const h = setup(editor);
      h.lesson.start("tour", "asked", "tour-mixer");
      flush();
      h.lesson.showMe();
      flush();
      expect(editor.goTo).toHaveBeenCalledWith("mixer");
      expect(h.lesson.state()?.step?.shown).toBe(true);
      vi.advanceTimersByTime(SHOW_ME_SETTLE_MS);
      flush();
      expect(h.lesson.state()?.step?.shown).toBe(false);

      // At the style's tempo, so "Hear it" goes straight to Play.
      h.setProject(tempoed(h.project(), BEAT_PATTERNS[beatStyleFor([])].tempo));
      flush();
      h.lesson.start("beat", "asked", "beat-play");
      flush();
      expect(h.lesson.state()?.step?.index).toBe(1);
      h.lesson.showMe();
      flush();
      expect(h.lesson.state()?.step?.shown).toBe(true);
      await Promise.resolve();
      flush();
      expect(editor.play).toHaveBeenCalledTimes(1);
      expect(h.lesson.state()?.step?.shown).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Show me's mark when the view it asked for opens", () => {
    vi.useFakeTimers();
    try {
      const editor: LessonEditorPort = {
        apply: vi.fn(() => true),
        goTo: vi.fn(),
        point: vi.fn(),
        play: vi.fn(async () => {}),
        putSound: vi.fn(async () => false),
      };
      const h = setup(editor);
      editor.goTo = vi.fn((view) => h.setView(view));
      h.lesson.start("tour", "asked", "tour-mixer");
      flush();
      h.lesson.showMe();
      flush();
      expect(h.lesson.state()).toBeNull();
      vi.advanceTimersByTime(SHOW_ME_SETTLE_MS);
      flush();
      expect(h.lesson.done()).toContain("tour-mixer");
      expect(h.log).toHaveBeenCalledWith(
        "lesson_bite_completed",
        expect.objectContaining({ bite_id: "tour-mixer", how: "show_me" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps the chapter up once its last bite is done, once, even after a reply", () => {
    const editor: LessonEditorPort = {
      apply: vi.fn(() => true),
      goTo: vi.fn(),
      point: vi.fn(),
      play: vi.fn(async () => {}),
      putSound: vi.fn(async () => false),
    };
    const h = setup(editor);
    editor.goTo = vi.fn((view) => h.setView(view));
    // Coproducer is still writing as the tour's last bite starts and ends.
    h.setStreaming(true);
    h.lesson.start("tour", "asked", "tour-mixer");
    flush();
    h.lesson.showMe();
    flush();
    expect(h.lesson.state()).toBeNull();
    expect(h.sendLesson).not.toHaveBeenCalled();
    h.setStreaming(false);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
    const [text, cue, chapter] = h.sendLesson.mock.lastCall as unknown as [
      string,
      { moment: string; next: readonly string[] },
      string,
    ];
    expect(chapter).toBe("Tour the studio");
    expect(text).toContain('That was the last bite of "Tour the studio".');
    expect(cue.moment).toBe("chapter_done");
    expect(cue.next.length).toBeGreaterThanOrEqual(2);
    expect(cue.next.length).toBeLessThanOrEqual(3);
    // Its wrap-up reply comes and goes: nothing is sent again.
    h.setStreaming(true);
    flush();
    h.setStreaming(false);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
  });

  it("sends the wrap-up as its own turn when nothing was on its way", () => {
    const editor: LessonEditorPort = {
      apply: vi.fn(() => true),
      goTo: vi.fn(),
      point: vi.fn(),
      play: vi.fn(async () => {}),
      putSound: vi.fn(async () => false),
    };
    const h = setup(editor);
    editor.goTo = vi.fn((view) => h.setView(view));
    h.lesson.start("tour", "asked", "tour-mixer");
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
    h.lesson.showMe();
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(2);
    const [, cue] = h.sendLesson.mock.lastCall as unknown as [
      string,
      { moment: string; next: readonly string[]; earlier: readonly unknown[] },
    ];
    expect(cue.moment).toBe("chapter_done");
    expect(cue.earlier).toEqual([]);
    expect(cue.next.length).toBeGreaterThanOrEqual(2);
    expect(cue.next.length).toBeLessThanOrEqual(3);
  });

  it("logs a chapter completed once, as its last bite ends, and no other (GRV-44)", () => {
    const h = setup();
    h.lesson.start("tour", "asked", "tour-library");
    flush();
    h.lesson.skip();
    flush();
    expect(h.log).not.toHaveBeenCalledWith("lesson_chapter_completed", expect.anything());
    h.lesson.next();
    flush();
    h.lesson.skip();
    flush();
    const completed = h.log.mock.calls.filter(
      ([name]) => (name as string) === "lesson_chapter_completed",
    );
    expect(completed).toEqual([["lesson_chapter_completed", { chapter_id: "tour" }]]);
    // A chapter taught alone is not the track lesson.
    expect(h.log).not.toHaveBeenCalledWith("lesson_track_completed", expect.anything());
  });

  it("has nothing to show without an editor", () => {
    const h = setup();
    expect(h.lesson.canShowMe).toBe(false);
  });

  it("does not count a skipped bite as done, so it is still the next unfinished one", () => {
    const h = setup();
    h.lesson.start("tour", "asked", "tour-sequence");
    flush();
    h.lesson.skip();
    flush();
    expect(h.lesson.state()?.endings).toEqual({ "tour-sequence": "skipped" });
    expect(h.lesson.done()).toEqual([]);
    h.lesson.leave();
    h.lesson.start("tour", "asked");
    flush();
    expect(h.lesson.state()?.biteIndex).toBe(0);
  });

  it("comes back after a reload at the bite it was on, with how the others ended", () => {
    const storage = new Map<string, string>();
    const store = createLessonStore({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    });
    const saved = { key: () => "lesson-key", store };
    const before = setup(undefined, true, saved);
    before.lesson.start("tour", "asked", "tour-sequence");
    flush();
    before.lesson.skip();
    flush();
    before.lesson.next();
    flush();
    expect(before.lesson.state()?.biteIndex).toBe(2);

    // The page reloads: a new lesson, over the same storage.
    const after = setup(undefined, true, saved);
    flush();
    expect(after.lesson.state()).toMatchObject({
      chapter: "tour",
      biteIndex: 2,
      endings: { "tour-sequence": "skipped" },
    });
    expect(after.lesson.state()?.step).not.toBeNull();
    // Coming back is not a new start: nothing is said or logged.
    expect(after.sendLesson).not.toHaveBeenCalled();
    expect(after.log).not.toHaveBeenCalled();

    // Leaving forgets it.
    after.lesson.leave();
    flush();
    expect(storage.size).toBe(0);
    const again = setup(undefined, true, saved);
    flush();
    expect(again.lesson.state()).toBeNull();
  });

  it("waits for the project before bringing a lesson back, and keeps it meanwhile", () => {
    const storage = new Map<string, string>();
    const store = createLessonStore({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    });
    store.save("lesson-key", { chapter: "beat", bite: "beat-kick", endings: {} });
    const h = setup(undefined, false, { key: () => "lesson-key", store });
    flush();
    expect(h.lesson.state()).toBeNull();
    expect(storage.size).toBe(1);
    h.setProject(starterWorld().project);
    flush();
    expect(h.lesson.state()).toMatchObject({ chapter: "beat", biteIndex: 1 });
  });
});
