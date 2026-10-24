import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_PARTS, controlAddress } from "../../commands/controlAddress";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { TICKS_PER_BAR } from "../../domain/time";
import { bite } from "../../lessons/chapters";
import { BITE_IDS } from "../../lessons/ids";
import { biteOf, chapterOf } from "../../lessons/session";
import { BEAT_PATTERNS, beatStyleFor } from "../../lessons/style";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import { InMemoryLessonRepository } from "../../persistence/inMemoryLessonRepository";
import { emptyLessonRecord, type LessonRecord } from "../../persistence/lessonDocuments";
import { emptyProfile, type ProducerProfile } from "../../persistence/profileDocuments";
import { createManualClock } from "../../shared/clock";
import { showBite, starterWorld } from "../../testing/lessonWorld";
import type { EditorViewName } from "../composition/editorViews";
import { useLesson } from "./useLesson";
import { useLessonRecord } from "./useLessonRecord";
import { type LessonEditorPort, SHOW_ME_SETTLE_MS } from "./useLessonShowMe";

const OWNER = { uid: "user_1", projectId: "prj_1" } as const;

/** A store for the lesson records, as another page load would find it. */
function recordStore(record?: LessonRecord): InMemoryLessonRepository {
  const repository = new InMemoryLessonRepository({ clock: createManualClock(10) });
  if (record) void repository.saveRecord(OWNER.uid, OWNER.projectId, record);
  return repository;
}

/** Lets the record's reads and writes settle, then draws. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
  }
}

async function stored(
  repository: InMemoryLessonRepository,
): Promise<LessonRecord | null> {
  const result = await repository.loadRecord(OWNER.uid, OWNER.projectId);
  return result.ok ? result.record : null;
}

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
  repository?: InMemoryLessonRepository,
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
      record: repository
        ? useLessonRecord({
            owner: () => OWNER,
            repository: async () => repository,
            profile,
          })
        : undefined,
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

  it("keeps how each bite ended, and starts a left lesson over from its first bite (GRV-190)", () => {
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
    expect(h.lesson.finished()).toEqual({ "tour-arrangement": "did_it" });
    h.lesson.leave();
    h.lesson.start("tour", "asked");
    flush();
    // Nothing is inferred from what is finished: a restart is from the top,
    // and this time through nothing is done yet.
    expect(h.lesson.state()?.biteIndex).toBe(0);
    expect(h.lesson.state()?.endings).toEqual({});
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
      expect(h.lesson.finished()["tour-mixer"]).toBe("show_me");
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

  it("keeps a skipped bite as skipped, never as done, on the profile or in the record", async () => {
    const profile = profileStore([]);
    const repository = recordStore();
    const h = setup(undefined, true, profile, repository);
    await settle();
    h.lesson.start("tour", "asked", "tour-sequence");
    flush();
    h.lesson.skip();
    await settle();
    expect(h.lesson.state()?.endings).toEqual({ "tour-sequence": "skipped" });
    expect(h.lesson.finished()).toEqual({ "tour-sequence": "skipped" });
    expect(profile.profile()?.lessonsDone).toEqual([]);
    expect((await stored(repository))?.finished["tour-sequence"]?.how).toBe("skipped");
  });

  it("writes the bites done onto the profile's list, derived from the record", async () => {
    const profile = profileStore(["beat-kick"]);
    const repository = recordStore();
    const h = setup(undefined, true, profile, repository);
    await settle();
    h.lesson.start("tour", "asked", "tour-library");
    flush();
    h.setView("library");
    await settle();
    expect(profile.profile()?.lessonsDone).toEqual(["beat-kick", "tour-library"]);
  });

  it("sends one turn for one transition, however often it is handled", () => {
    const h = setup();
    h.lesson.start("tour", "asked", "tour-sequence");
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
    h.lesson.skip();
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(2);
    // The bite is over: a second Skip has nothing to end, and says nothing.
    h.lesson.skip();
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(2);
  });

  it("comes back after a reload at the bite and step it was on, from the record alone", async () => {
    const repository = recordStore();
    const before = setup(undefined, true, undefined, repository);
    await settle();
    before.lesson.start("tour", "asked", "tour-sequence");
    flush();
    before.lesson.skip();
    flush();
    before.lesson.next();
    await settle();
    expect(before.lesson.state()?.biteIndex).toBe(2);
    const step = before.lesson.state()?.step?.index;

    // The page reloads, or another tab opens: a new lesson, over the same record.
    const after = setup(undefined, true, undefined, repository);
    await settle();
    expect(after.lesson.state()).toMatchObject({
      lessonId: "tour",
      biteIndex: 2,
      endings: { "tour-sequence": "skipped" },
      step: { index: step },
    });
    // Coming back is not a new start: nothing is said or logged.
    expect(after.sendLesson).not.toHaveBeenCalled();
    expect(after.log).not.toHaveBeenCalled();

    // Leaving keeps the bites finished, and nothing is under way any more.
    after.lesson.leave();
    await settle();
    const left = await stored(repository);
    expect(left?.underWay).toBeNull();
    expect(left?.finished["tour-sequence"]?.how).toBe("skipped");
    const again = setup(undefined, true, undefined, repository);
    await settle();
    expect(again.lesson.state()).toBeNull();
  });

  it("is under way no more once its last bite is over, its bites kept", async () => {
    const repository = recordStore();
    const h = setup(undefined, true, undefined, repository);
    await settle();
    h.lesson.start("tour", "asked", "tour-mixer");
    flush();
    h.lesson.skip();
    await settle();
    expect(h.lesson.state()).toBeNull();
    expect(await stored(repository)).toMatchObject({
      underWay: null,
      finished: { "tour-mixer": { how: "skipped" } },
    });
  });

  it("waits for the project before bringing a lesson back", async () => {
    const repository = recordStore({
      ...emptyLessonRecord(),
      underWay: {
        lessonId: "beat",
        chapterIndex: 0,
        biteId: "beat-kick",
        stepIndex: 0,
        endings: {},
        passed: [],
      },
    });
    const h = setup(undefined, false, undefined, repository);
    await settle();
    expect(h.lesson.state()).toBeNull();
    h.setProject(starterWorld().project);
    flush();
    expect(h.lesson.state()).toMatchObject({ lessonId: "beat", biteIndex: 1 });
  });

  it("starts a lesson asked for before its record was read from where the record has it", async () => {
    const repository = recordStore({
      ...emptyLessonRecord(),
      underWay: {
        lessonId: "track",
        chapterIndex: 3,
        biteId: "arrange-breakdown",
        stepIndex: 0,
        endings: {},
        passed: [],
      },
    });
    const h = setup(undefined, true, undefined, repository);
    // Asked for at once: the record has not been read yet.
    expect(h.lesson.start("track", "asked")).toBe(true);
    flush();
    expect(h.lesson.state()).toBeNull();
    await settle();
    const back = h.lesson.state();
    expect(back).toMatchObject({ lessonId: "track", chapterIndex: 3 });
    expect(back && biteOf(back).id).toBe("arrange-breakdown");
    // Nothing wrote the empty record's chapter 1 over the stored place.
    expect((await stored(repository))?.underWay).toMatchObject({
      chapterIndex: 3,
      biteId: "arrange-breakdown",
    });
  });

  it("starts nothing asked for before the read once it is left", async () => {
    const repository = recordStore();
    const h = setup(undefined, true, undefined, repository);
    h.lesson.start("tour", "asked");
    h.lesson.leave();
    await settle();
    expect(h.lesson.state()).toBeNull();
    expect((await stored(repository))?.underWay ?? null).toBeNull();
  });

  it("writes a lesson started before its record was read over what was stored", async () => {
    const repository = recordStore({
      ...emptyLessonRecord(),
      finished: { "beat-kick": { how: "did_it", at: 1 } },
    });
    const h = setup(undefined, true, undefined, repository);
    h.lesson.start("tour", "asked", "tour-mixer");
    flush();
    await settle();
    const record = await stored(repository);
    expect(record?.underWay?.biteId).toBe("tour-mixer");
    expect(record?.finished["beat-kick"]?.how).toBe("did_it");
  });
});

describe("Finish a track in the panel (GRV-44)", () => {
  it("starts on the beat, passing over the starter's kick", () => {
    const h = setup();
    expect(h.lesson.start("track", "asked")).toBe(true);
    flush();
    const state = h.lesson.state();
    expect(state).toMatchObject({ lessonId: "track", chapterIndex: 0 });
    expect(state?.passed).toEqual(["beat-kick"]);
    h.lesson.skip();
    flush();
    h.lesson.next();
    flush();
    // Pick a kick, then straight on to Hear it: the starter already plays the kick.
    expect(h.lesson.state()?.biteIndex).toBe(2);
    // What the song had is passed over, never finished.
    expect(h.lesson.finished()).toEqual({ "beat-library": "skipped" });
    const completed = h.log.mock.calls
      .filter(([name]) => (name as string) === "lesson_bite_completed")
      .map((call) => (call as unknown as [string, { bite_id: string }])[1].bite_id);
    expect(completed).toEqual(["beat-library"]);
  });

  it("keeps the lesson under way in the record from its first bite", async () => {
    const repository = recordStore();
    const h = setup(undefined, true, undefined, repository);
    await settle();
    h.lesson.start("track", "asked");
    await settle();
    expect((await stored(repository))?.underWay).toMatchObject({
      lessonId: "track",
      chapterIndex: 0,
      biteId: "beat-library",
      passed: ["beat-kick"],
    });
  });

  it("teaches the beat in a song without one, though its bites were done before", () => {
    // Make a beat done in another song: this one has only its kick, so the
    // beat is taught from Pick a kick, and only the kick is passed over.
    const beat = BITE_IDS.filter((id) => id.startsWith("beat-"));
    const h = setup(undefined, true, profileStore(beat));
    expect(h.lesson.start("track", "nudge")).toBe(true);
    flush();
    expect(h.lesson.state()).toMatchObject({
      lessonId: "track",
      chapterIndex: 0,
      biteIndex: 0,
      passed: ["beat-kick"],
    });
    expect(h.log).toHaveBeenCalledWith(
      "lesson_bite_started",
      expect.objectContaining({
        chapter_id: "beat",
        bite_id: "beat-library",
        source: "nudge",
      }),
    );
  });

  it("keeps Make a beat a lesson of its own, whatever the track has done", () => {
    const beat = BITE_IDS.filter((id) => id.startsWith("beat-"));
    const h = setup(undefined, true, profileStore(beat));
    h.lesson.start("beat", "asked");
    flush();
    expect(h.lesson.state()).toMatchObject({
      lessonId: "beat",
      biteIndex: 0,
      passed: [],
    });
  });

  it("goes on to the next chapter after a chapter's last bite, without leaving the panel", () => {
    const h = setup();
    h.lesson.start("track", "asked", "bass-sound");
    flush();
    expect(h.lesson.state()?.lessonId).toBe("track");
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
    const now = h.lesson.state();
    expect(now && chapterOf(now).id).toBe("chords");
    expect(h.log).toHaveBeenCalledWith(
      "lesson_bite_started",
      expect.objectContaining({
        chapter_id: "chords",
        bite_id: "chords-loop",
        source: "next",
      }),
    );
  });

  it("still offers the next chapter after a reload at a chapter's end", async () => {
    const repository = recordStore();
    const before = setup(undefined, true, undefined, repository);
    await settle();
    before.lesson.start("track", "asked", "bass-sound");
    flush();
    before.lesson.skip();
    flush();
    before.lesson.skip();
    await settle();
    expect(before.lesson.state()).toMatchObject({ chapterIndex: 1, step: null });

    // The page reloads at Bass's end: the card is still "Finish a track".
    const after = setup(undefined, true, undefined, repository);
    await settle();
    expect(after.lesson.state()).toMatchObject({
      lessonId: "track",
      chapterIndex: 1,
      step: null,
    });
    const ahead = after.lesson.upcoming();
    expect(ahead && chapterOf(ahead).id).toBe("chords");
    after.lesson.next();
    flush();
    expect(after.lesson.state()).toMatchObject({ lessonId: "track", chapterIndex: 2 });
  });

  it("after Leave, asking again starts at chapter 1 and passes over only what the song has", async () => {
    const repository = recordStore({
      ...emptyLessonRecord(),
      underWay: {
        lessonId: "track",
        chapterIndex: 3,
        biteId: "arrange-breakdown",
        stepIndex: 0,
        endings: { "arrange-copy": "did_it", "arrange-intro": "did_it" },
        passed: [],
      },
      finished: { "bass-sound": { how: "skipped", at: 1 } },
    });
    const h = setup(undefined, true, undefined, repository);
    await settle();
    // Back after a reload, then left, then asked for again.
    expect(h.lesson.state()?.lessonId).toBe("track");
    h.lesson.leave();
    await settle();
    expect(h.lesson.start("track", "asked")).toBe(true);
    flush();
    // Left, it is under way no more: it starts from the top, and passes over
    // only the starter's kick, which is all this song has.
    expect(h.lesson.state()).toMatchObject({
      chapterIndex: 0,
      biteIndex: 0,
      passed: ["beat-kick"],
    });

    const fresh = setup(
      undefined,
      true,
      undefined,
      recordStore({
        ...emptyLessonRecord(),
        underWay: {
          lessonId: "track",
          chapterIndex: 3,
          biteId: "arrange-breakdown",
          stepIndex: 0,
          endings: {},
          passed: [],
        },
      }),
    );
    await settle();
    fresh.lesson.leave();
    flush();
    expect(fresh.lesson.state()).toBeNull();
  });

  it("after Leave, asking again lands past the chapters this song already has", async () => {
    const repository = recordStore({
      ...emptyLessonRecord(),
      underWay: {
        lessonId: "track",
        chapterIndex: 3,
        biteId: "arrange-breakdown",
        stepIndex: 0,
        endings: {},
        passed: [],
      },
    });
    const h = setup(undefined, true, undefined, repository);
    await settle();
    h.lesson.leave();
    await settle();
    // The song gains a whole beat, as Make a beat would leave it.
    const settings = { style: beatStyleFor([]) };
    let world = starterWorld();
    for (const id of ["beat-snare", "beat-hats", "beat-loop"] as const) {
      world = showBite(bite(id), world, settings);
    }
    h.setProject(world.project);
    flush();
    expect(h.lesson.start("track", "asked")).toBe(true);
    flush();
    const state = h.lesson.state();
    expect(state && chapterOf(state).id).toBe("bass");
    expect(state).toMatchObject({ lessonId: "track", chapterIndex: 1 });
    await settle();
    expect((await stored(repository))?.underWay).toMatchObject({ chapterIndex: 1 });
  });

  it("opens the Export dialog as the last bite starts, and ends the lesson once stems are exported", () => {
    const editor = recordingEditor();
    const h = setup(editor);
    h.lesson.start("track", "asked", "mix-export");
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

  it("does not count the track completed when its last bite, the export, is skipped", () => {
    const editor = recordingEditor();
    const h = setup(editor);
    h.lesson.start("track", "asked", "mix-export");
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
    h.lesson.start("track", "asked", "arrange-drop");
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
