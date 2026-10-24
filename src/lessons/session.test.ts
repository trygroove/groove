import { describe, expect, it } from "vitest";
import { emptyLessonRecord, type LessonRecord } from "../persistence/lessonDocuments";
import {
  applyShowMe,
  lessonContext,
  startedAt,
  starterWorld,
} from "../testing/lessonWorld";
import {
  biteEnding,
  biteOf,
  chapterFinished,
  markShown,
  observe,
  skip,
  startLesson,
  startNextBite,
  stepWords,
} from "./session";
import type { LessonWorld } from "./types";

const settings = { style: "boom_bap" } as const;

/** Show me on the step under way, applied to `world`. */
function shown(world: LessonWorld, state: Parameters<typeof biteOf>[0]): LessonWorld {
  const step = biteOf(state).steps[state.step?.index ?? 0];
  return applyShowMe(world, step.showMe(world, settings, lessonContext()));
}

describe("a lesson as it runs (GRV-43)", () => {
  it("starts a chapter on its first bite, with the step's words read as it starts", () => {
    const world = starterWorld();
    const { state, event } = startedAt("beat", null, world, settings);
    expect(event).toEqual({ kind: "bite_started", passed: [] });
    expect(biteOf(state).id).toBe("beat-library");
    expect(state.step?.index).toBe(1);
    expect(stepWords(state)).toMatch(/^Open the Library/);
  });

  it("waits while the step's predicate does not hold, and ends the bite as done once it does", () => {
    const world = starterWorld({ view: "mixer" });
    const { state } = startedAt("tour", "tour-library", world, settings);
    expect(observe(state, world, settings)).toBeNull();
    const ended = observe(state, { ...world, view: "library" }, settings);
    expect(ended?.event).toEqual({
      kind: "bite_done",
      how: "did_it",
      changes: [],
      chapterDone: false,
      lessonDone: false,
    });
    expect(ended?.state.step).toBeNull();
    expect(ended?.state.endings).toEqual({ "tour-library": "did_it" });
  });

  it("counts a step Show me did as shown, and says what it changed", () => {
    const world = starterWorld();
    const started = startedAt("beat", "beat-snare", world, settings).state;
    const pressed = markShown(started);
    const after = shown(world, pressed);
    const ended = observe(pressed, after, settings);
    expect(ended?.event.kind).toBe("bite_done");
    if (ended?.event.kind !== "bite_done") return;
    expect(ended.event.how).toBe("show_me");
    expect(ended.event.changes.join(" ")).toMatch(/Snare/);
  });

  it("skips a step, and the bite ends skipped", () => {
    const world = starterWorld();
    const { state } = startedAt("beat", "beat-hats", world, settings);
    const skipped = skip(state, world, settings);
    expect(skipped?.event).toMatchObject({ kind: "bite_done", how: "skipped" });
  });

  it("goes on to a bite's next step before ending it", () => {
    const world = starterWorld();
    const { state } = startedAt("sound", "sound-wave", world, settings);
    expect(state.step?.index).toBe(0);
    const after = shown(world, markShown(state));
    const next = observe(markShown(state), after, settings);
    expect(next?.event).toMatchObject({ kind: "step_done", how: "show_me" });
    expect(next?.state.step?.index).toBe(2);
    expect(next?.state.stepEndings).toEqual(["show_me"]);
  });

  it("takes the worst of how a bite's steps ended", () => {
    expect(biteEnding(["did_it", "did_it"])).toBe("did_it");
    expect(biteEnding(["did_it", "show_me"])).toBe("show_me");
    expect(biteEnding(["show_me", "skipped", "did_it"])).toBe("skipped");
  });

  it("is pulled to the next bite, and over after the chapter's last", () => {
    const world = starterWorld();
    const first = startedAt("tour", "tour-instrument", world, settings).state;
    expect(startNextBite(first, world, settings)).toBeNull();
    const ended = skip(first, world, settings);
    if (!ended) throw new Error("not skipped");
    const next = startNextBite(ended.state, world, settings);
    expect(next && biteOf(next.state).id).toBe("tour-library");
    expect(next?.state.endings).toEqual({ "tour-instrument": "skipped" });

    const last = startedAt("tour", "tour-mixer", world, settings).state;
    const over = skip(last, world, settings);
    expect(over?.event).toMatchObject({ kind: "bite_done", chapterDone: true });
    if (!over) throw new Error("not over");
    expect(chapterFinished(over.state)).toBe(true);
    expect(startNextBite(over.state, world, settings)).toBeNull();
  });

  it("starts at the bite asked for, or the lesson's first when it has no such bite", () => {
    const world = starterWorld();
    expect(biteOf(startedAt("beat", "beat-loop", world, settings).state).id).toBe(
      "beat-loop",
    );
    expect(biteOf(startedAt("beat", "tour-mixer", world, settings).state).id).toBe(
      "beat-library",
    );
  });
});

describe("startLesson, from the project's record (GRV-190)", () => {
  const world = starterWorld({ view: "mixer" });
  const underWay = (
    over: Partial<NonNullable<LessonRecord["underWay"]>>,
  ): Pick<LessonRecord, "underWay"> => ({
    underWay: {
      lessonId: "tour",
      chapterIndex: 0,
      biteId: "tour-library",
      stepIndex: 0,
      endings: {},
      passed: [],
      ...over,
    },
  });

  it("starts at the first bite from an empty record", () => {
    const started = startLesson("tour", emptyLessonRecord(), world, settings);
    expect(started?.state).toMatchObject({
      lessonId: "tour",
      chapterIndex: 0,
      biteIndex: 0,
      endings: {},
    });
    expect(started?.event).toEqual({ kind: "bite_started", passed: [] });
  });

  it("resumes the lesson under way at its bite and step, keeping how the others ended", () => {
    const started = startLesson(
      "sound",
      underWay({
        lessonId: "sound",
        biteId: "sound-wave",
        stepIndex: 2,
        endings: { "sound-filter": "skipped" },
      }),
      world,
      settings,
    );
    expect(started && biteOf(started.state).id).toBe("sound-wave");
    expect(started?.state.step?.index).toBe(2);
    expect(started?.state.endings).toEqual({ "sound-filter": "skipped" });
  });

  it("never infers a place from the bites finished: with none under way it starts over", () => {
    const record = {
      ...emptyLessonRecord(),
      finished: {
        "tour-arrangement": { how: "did_it", at: 1 },
        "tour-sequence": { how: "did_it", at: 1 },
      },
    } satisfies LessonRecord;
    const started = startLesson("tour", record, world, settings);
    expect(started && biteOf(started.state).id).toBe("tour-arrangement");
    // The track starts at chapter 1, passing over only what the song has.
    const house = { style: "four_on_the_floor" } as const;
    const track = startLesson("track", record, starterWorld(), house);
    expect(track?.state).toMatchObject({ chapterIndex: 0, passed: ["beat-kick"] });
    expect(track && biteOf(track.state).id).toBe("beat-library");
  });

  it("resumes at a skipped bite as skipped, waiting on Next, never as done", () => {
    const started = startLesson(
      "tour",
      underWay({
        biteId: "tour-instrument",
        stepIndex: 1,
        endings: { "tour-instrument": "skipped" },
      }),
      world,
      settings,
    );
    if (!started) throw new Error("not started");
    expect(biteOf(started.state).id).toBe("tour-instrument");
    expect(started.state.step).toBeNull();
    expect(started.state.endings["tour-instrument"]).toBe("skipped");
    const next = startNextBite(started.state, world, settings);
    expect(next && biteOf(next.state).id).toBe("tour-library");
  });

  it("resumes across a chapter boundary: a chapter's end waits on the next chapter", () => {
    const started = startLesson(
      "track",
      underWay({
        lessonId: "track",
        chapterIndex: 1,
        biteId: "bass-sound",
        stepIndex: 9,
        endings: { "bass-sound": "did_it" },
        passed: ["bass-key"],
      }),
      starterWorld(),
      settings,
    );
    if (!started) throw new Error("not started");
    expect(started.state).toMatchObject({
      chapterIndex: 1,
      step: null,
      passed: ["bass-key"],
    });
    expect(chapterFinished(started.state)).toBe(true);
    const next = startNextBite(started.state, starterWorld(), settings);
    expect(next?.state).toMatchObject({
      lessonId: "track",
      chapterIndex: 2,
      biteIndex: 0,
    });
    expect(next && biteOf(next.state).id).toBe("chords-loop");
  });

  it("starts another lesson fresh, and a lesson whose last bite was over from its start", () => {
    const other = startLesson("beat", underWay({}), world, settings);
    expect(other && biteOf(other.state).id).toBe("beat-library");
    const over = startLesson(
      "tour",
      underWay({ biteId: "tour-mixer", endings: { "tour-mixer": "did_it" } }),
      world,
      settings,
    );
    expect(over && biteOf(over.state).id).toBe("tour-arrangement");
  });

  it("drops what the record names that the lesson does not have", () => {
    const started = startLesson(
      "tour",
      underWay({ biteId: "tour-gone", endings: { "tour-gone": "did_it" } }),
      world,
      settings,
    );
    expect(started && biteOf(started.state).id).toBe("tour-arrangement");
    const kept = startLesson(
      "tour",
      underWay({ endings: { "tour-gone": "did_it", "tour-mixer": "show_me" } }),
      world,
      settings,
    );
    expect(kept?.state.endings).toEqual({ "tour-mixer": "show_me" });
  });

  it("starts at the bite asked for", () => {
    expect(biteOf(startedAt("beat", "beat-loop", world, settings).state).id).toBe(
      "beat-loop",
    );
  });
});
