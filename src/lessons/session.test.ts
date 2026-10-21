import { describe, expect, it } from "vitest";
import { applyShowMe, lessonContext, starterWorld } from "../testing/lessonWorld";
import {
  biteEnding,
  biteOf,
  chapterFinished,
  markShown,
  observe,
  resumeLesson,
  skip,
  startBite,
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
    const { state, event } = startBite("beat", null, world, settings);
    expect(event).toEqual({ kind: "bite_started", passed: [] });
    expect(biteOf(state).id).toBe("beat-library");
    expect(state.step?.index).toBe(1);
    expect(stepWords(state)).toMatch(/^Open the Library/);
  });

  it("waits while the step's predicate does not hold, and ends the bite as done once it does", () => {
    const world = starterWorld({ view: "mixer" });
    const { state } = startBite("tour", "tour-library", world, settings);
    expect(observe(state, world, settings)).toBeNull();
    const ended = observe(state, { ...world, view: "library" }, settings);
    expect(ended?.event).toEqual({
      kind: "bite_done",
      how: "did_it",
      changes: [],
      chapterDone: false,
      trackDone: false,
    });
    expect(ended?.state.step).toBeNull();
    expect(ended?.state.endings).toEqual({ "tour-library": "did_it" });
  });

  it("counts a step Show me did as shown, and says what it changed", () => {
    const world = starterWorld();
    const started = startBite("beat", "beat-snare", world, settings).state;
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
    const { state } = startBite("beat", "beat-hats", world, settings);
    const skipped = skip(state, world, settings);
    expect(skipped?.event).toMatchObject({ kind: "bite_done", how: "skipped" });
  });

  it("goes on to a bite's next step before ending it", () => {
    const world = starterWorld();
    const { state } = startBite("sound", "sound-wave", world, settings);
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
    const first = startBite("tour", "tour-instrument", world, settings).state;
    expect(startNextBite(first, world, settings)).toBeNull();
    const ended = skip(first, world, settings);
    if (!ended) throw new Error("not skipped");
    const next = startNextBite(ended.state, world, settings);
    expect(next && biteOf(next.state).id).toBe("tour-library");
    expect(next?.state.endings).toEqual({ "tour-instrument": "skipped" });

    const last = startBite("tour", "tour-mixer", world, settings).state;
    const over = skip(last, world, settings);
    expect(over?.event).toMatchObject({ kind: "bite_done", chapterDone: true });
    if (!over) throw new Error("not over");
    expect(chapterFinished(over.state)).toBe(true);
    expect(startNextBite(over.state, world, settings)).toBeNull();
  });

  it("starts at the bite asked for, or the chapter's first when it has no such bite", () => {
    const world = starterWorld();
    expect(biteOf(startBite("beat", "beat-loop", world, settings).state).id).toBe(
      "beat-loop",
    );
    expect(biteOf(startBite("beat", "tour-mixer", world, settings).state).id).toBe(
      "beat-library",
    );
  });
});

describe("resumeLesson (GRV-43)", () => {
  const world = starterWorld({ view: "mixer" });

  it("starts the bite under way again, keeping how the others ended", () => {
    const state = resumeLesson("tour", "tour-library", world, settings, {
      "tour-arrangement": "skipped",
    });
    expect(state).toMatchObject({
      chapter: "tour",
      biteIndex: 3,
      endings: { "tour-arrangement": "skipped" },
    });
    expect(state?.step).not.toBeNull();
  });

  it("waits for Next after a bite that was over, and is gone after the last", () => {
    const over = resumeLesson("tour", "tour-library", world, settings, {
      "tour-library": "did_it",
    });
    expect(over).toMatchObject({ biteIndex: 3, step: null });
    expect(
      resumeLesson("tour", "tour-mixer", world, settings, { "tour-mixer": "did_it" }),
    ).toBeNull();
  });
});
