import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_PARTS, controlAddress } from "../../commands/controlAddress";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { TICKS_PER_BAR } from "../../domain/time";
import { BITE_IDS, TRACK_UNDER_WAY } from "../../lessons/ids";
import { biteOf } from "../../lessons/session";
import { BEAT_PATTERNS, beatStyleFor } from "../../lessons/style";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import { emptyProfile, type ProducerProfile } from "../../persistence/profileDocuments";
import { starterWorld } from "../../testing/lessonWorld";
import type { EditorViewName } from "../composition/editorViews";
import { createLessonStore, type LessonStore } from "./lessonStore";
import { type LessonEditorPort, SHOW_ME_SETTLE_MS, useLesson } from "./useLesson";

/** `project` at `tempo` BPM, as a committed edit would leave it. */
function tempoed(project: Project | null, tempo: number): Project {
  if (!project) throw new Error("no project");
  return { ...project, song: { ...project.song, tempo } };
}

/** A loaded profile that has been through `lessonsDone`, saved in memory. */
function profileStore(lessonsDone: readonly string[]): ProducerProfileStore {
  const [profile, setProfile] = createSignal<ProducerProfile | null>({
    ...emptyProfile(0),
    lessonsDone,
  });
  return {
    profile,
    loaded: () => true,
    failed: () => false,
    current: profile,
    async update(change) {
      const saved = profile();
      if (!saved) return null;
      const next = change(saved);
      setProfile(next);
      return next;
    },
  };
}

function setup(
  editor?: LessonEditorPort,
  open = true,
  profile?: ProducerProfileStore,
  saved?: { key: () => string | null; store: LessonStore },
) {
  const [project, setProject] = createSignal<Project | null>(
    open ? starterWorld().project : null,
  );
  const [playing, setPlaying] = createSignal(false);
  const [view, setView] = createSignal<EditorViewName>("arrangement");
  const [streaming, setStreaming] = createSignal(false);
  const [stemExports, setStemExports] = createSignal(0);
  const registry = createControlRegistry();
  const sendLesson = vi.fn(() => true);
  const log = vi.fn();
  const lesson = createRoot(() =>
    useLesson({
      project,
      view,
      playing,
      listening: {
        bar: () => 0,
        barsHeard: () => 0,
        masterClips: () => 0,
        stemExports,
      },
      conversation: { sendLesson, streaming },
      registry,
      editor,
      profile,
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
    setStemExports,
    registry,
    sendLesson,
    log,
  };
}

/** A Show me port that applies nothing and records what it is asked. */
function recordingEditor(): LessonEditorPort {
  return {
    apply: vi.fn(() => true),
    goTo: vi.fn(),
    point: vi.fn(),
    play: vi.fn(async () => {}),
    putSound: vi.fn(async () => false),
    openExport: vi.fn(),
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
      openExport: vi.fn(),
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
        openExport: vi.fn(),
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
        openExport: vi.fn(),
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
      openExport: vi.fn(),
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
      openExport: vi.fn(),
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
    const before = setup(undefined, true, undefined, saved);
    before.lesson.start("tour", "asked", "tour-sequence");
    flush();
    before.lesson.skip();
    flush();
    before.lesson.next();
    flush();
    expect(before.lesson.state()?.biteIndex).toBe(2);

    // The page reloads: a new lesson, over the same storage.
    const after = setup(undefined, true, undefined, saved);
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
    const again = setup(undefined, true, undefined, saved);
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
    const h = setup(undefined, false, undefined, { key: () => "lesson-key", store });
    flush();
    expect(h.lesson.state()).toBeNull();
    expect(storage.size).toBe(1);
    h.setProject(starterWorld().project);
    flush();
    expect(h.lesson.state()).toMatchObject({ chapter: "beat", biteIndex: 1 });
  });
});

describe("Finish a track in the panel (GRV-44)", () => {
  it("starts on the beat, passing over the starter's kick and saving it as done", () => {
    const h = setup();
    expect(h.lesson.start("track", "asked")).toBe(true);
    flush();
    const state = h.lesson.state();
    expect(state?.track).toBe(true);
    expect(state?.chapter).toBe("beat");
    expect(state?.passed).toEqual(["beat-kick"]);
    h.lesson.skip();
    flush();
    h.lesson.next();
    flush();
    // Pick a kick, then straight on to Hear it: the starter already plays the kick.
    expect(h.lesson.state()?.biteIndex).toBe(2);
    expect(h.lesson.done()).toContain("beat-kick");
    const completed = h.log.mock.calls
      .filter(([name]) => (name as string) === "lesson_bite_completed")
      .map((call) => (call as unknown as [string, { bite_id: string }])[1].bite_id);
    expect(completed).toEqual(["beat-library"]);
  });

  it("saves the lesson as under way as it starts, before any bite is done", () => {
    const profile = profileStore([]);
    const h = setup(undefined, true, profile);
    h.lesson.start("track", "asked");
    flush();
    expect(profile.profile()?.lessonsDone).toContain(TRACK_UNDER_WAY);
    expect(h.lesson.done()).toContain(TRACK_UNDER_WAY);
  });

  it("picks up at Bass once the beat is done in it and Bass is not started", () => {
    const beat = BITE_IDS.filter((id) => id.startsWith("beat-"));
    const h = setup(undefined, true, profileStore([TRACK_UNDER_WAY, ...beat]));
    expect(h.lesson.start("track", "nudge")).toBe(true);
    flush();
    const state = h.lesson.state();
    expect(state?.track).toBe(true);
    expect(state?.chapter).toBe("bass");
    expect(h.log).toHaveBeenCalledWith(
      "lesson_bite_started",
      expect.objectContaining({
        chapter_id: "bass",
        bite_id: "bass-key",
        source: "nudge",
      }),
    );
  });

  it("picks the beat up inside it when left part-way through, so Bass follows", () => {
    const done = [TRACK_UNDER_WAY, "beat-library", "beat-kick"];
    // The nudge offers the beat's next bite, and starts it as its chapter.
    const h = setup(undefined, true, profileStore(done));
    expect(h.lesson.start("beat", "nudge", "beat-play")).toBe(true);
    flush();
    expect(h.lesson.state()?.track).toBe(true);
    expect(h.lesson.state()?.chapter).toBe("beat");
    expect(h.lesson.state()?.biteIndex).toBe(2);
    // "Finish a track" from where it was left lands on the same bite.
    const resumed = setup(undefined, true, profileStore(done));
    resumed.lesson.start("track", "asked");
    flush();
    expect(resumed.lesson.state()?.track).toBe(true);
    expect(resumed.lesson.state()?.biteIndex).toBe(2);
  });

  it("keeps Make a beat a chapter alone when the lesson is not under way on it", () => {
    const solo = setup(undefined, true, profileStore(["beat-library"]));
    solo.lesson.start("beat", "asked");
    flush();
    expect(solo.lesson.state()?.track).toBe(false);
    const beat = BITE_IDS.filter((id) => id.startsWith("beat-"));
    const past = setup(undefined, true, profileStore([TRACK_UNDER_WAY, ...beat]));
    past.lesson.start("beat", "asked");
    flush();
    expect(past.lesson.state()?.track).toBe(false);
  });

  it("goes on to the next chapter after a chapter's last bite, without leaving the panel", () => {
    const h = setup();
    h.lesson.start("bass", "asked", "bass-sound");
    flush();
    expect(h.lesson.state()?.track).toBe(true);
    // The starter has no Bass track: adding one comes first. Skip both steps.
    h.lesson.skip();
    flush();
    h.lesson.skip();
    flush();
    // Bass is over, but the lesson goes on.
    expect(h.lesson.state()).not.toBeNull();
    expect(h.log).toHaveBeenCalledWith("lesson_chapter_completed", {
      chapter_id: "bass",
    });
    h.lesson.next();
    flush();
    expect(h.lesson.state()?.chapter).toBe("chords");
    expect(h.log).toHaveBeenCalledWith(
      "lesson_bite_started",
      expect.objectContaining({
        chapter_id: "chords",
        bite_id: "chords-loop",
        source: "next",
      }),
    );
  });

  it("still offers the next chapter after a reload at a chapter's end (GRV-43 resume)", () => {
    const storage = new Map<string, string>();
    const store = createLessonStore({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    });
    const saved = { key: () => "lesson-key", store };
    const before = setup(undefined, true, undefined, saved);
    before.lesson.start("bass", "asked", "bass-sound");
    flush();
    before.lesson.skip();
    flush();
    before.lesson.skip();
    flush();
    expect(before.lesson.state()).toMatchObject({ chapter: "bass", step: null });

    // The page reloads at Bass's end: the card is still "Finish a track".
    const after = setup(undefined, true, undefined, saved);
    flush();
    expect(after.lesson.state()).toMatchObject({
      chapter: "bass",
      track: true,
      step: null,
    });
    expect(after.lesson.upcoming()?.chapter).toBe("chords");
    after.lesson.next();
    flush();
    expect(after.lesson.state()).toMatchObject({ chapter: "chords", track: true });
  });

  it("opens the Export dialog as the last bite starts, and ends the lesson once stems are exported", () => {
    const editor = recordingEditor();
    const h = setup(editor);
    h.lesson.start("mix", "asked", "mix-export");
    flush();
    expect(editor.openExport).toHaveBeenCalledTimes(1);
    expect(h.lesson.state()?.step).not.toBeNull();
    h.setStemExports(1);
    flush();
    expect(h.lesson.state()).toBeNull();
    expect(h.log).toHaveBeenCalledWith(
      "lesson_bite_completed",
      expect.objectContaining({ bite_id: "mix-export", how: "did_it" }),
    );
    const ends = h.log.mock.calls.filter(([name]) =>
      ["lesson_chapter_completed", "lesson_track_completed"].includes(name as string),
    );
    expect(ends).toEqual([
      ["lesson_chapter_completed", { chapter_id: "mix" }],
      ["lesson_track_completed", {}],
    ]);
  });

  it("picks up where the producer is, not at a bite they skipped on the way", () => {
    // "Round it off" skipped (not saved), everything else done up to the intro.
    const done = [
      TRACK_UNDER_WAY,
      "bass-key",
      "bass-line",
      "chords-loop",
      "chords-hook",
      "chords-pluck",
      "arrange-copy",
      "arrange-intro",
    ];
    const h = setup(undefined, true, profileStore(done));
    expect(h.lesson.start("track", "nudge")).toBe(true);
    flush();
    expect(h.lesson.state()?.chapter).toBe("arrange");
    const resumed = h.lesson.state();
    expect(resumed && biteOf(resumed).id).toBe("arrange-breakdown");
  });

  it("goes back for a skipped bite, then on past what is done, not over it again", () => {
    const done = [
      TRACK_UNDER_WAY,
      "bass-key",
      "bass-line",
      "chords-loop",
      "chords-hook",
      "chords-pluck",
      "arrange-copy",
      "arrange-intro",
    ];
    const h = setup(undefined, true, profileStore(done));
    h.lesson.start("bass", "asked");
    flush();
    const back = h.lesson.state();
    expect(back && biteOf(back).id).toBe("bass-sound");
    h.lesson.skip();
    flush();
    h.lesson.skip();
    flush();
    const ahead = h.lesson.upcoming();
    expect(ahead && biteOf(ahead).id).toBe("arrange-breakdown");
    h.lesson.next();
    flush();
    const now = h.lesson.state();
    expect(now && biteOf(now).id).toBe("arrange-breakdown");
    const started = h.log.mock.calls
      .filter(([name]) => (name as string) === "lesson_bite_started")
      .map((call) => (call as unknown as [string, { bite_id: string }])[1].bite_id);
    expect(started).toEqual(["bass-sound", "arrange-breakdown"]);
  });

  it("does not count the track completed when its last bite, the export, is skipped", () => {
    const editor = recordingEditor();
    const h = setup(editor);
    h.lesson.start("mix", "asked", "mix-export");
    flush();
    h.lesson.skip();
    flush();
    expect(h.lesson.state()).toBeNull();
    expect(h.log).toHaveBeenCalledWith("lesson_chapter_completed", { chapter_id: "mix" });
    expect(h.log).not.toHaveBeenCalledWith("lesson_track_completed", expect.anything());
  });

  it("plays from where Show me says, for the drop", () => {
    const editor = recordingEditor();
    const h = setup(editor);
    h.lesson.start("arrange", "asked", "arrange-drop");
    flush();
    // The starter's beat stops after bar 1, so bringing it back for the drop
    // comes first; skip to the listening.
    h.lesson.skip();
    flush();
    h.lesson.showMe();
    flush();
    expect(editor.play).toHaveBeenCalledWith(12 * TICKS_PER_BAR);
  });
});
