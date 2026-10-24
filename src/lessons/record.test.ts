import { describe, expect, it } from "vitest";
import { emptyLessonRecord } from "../persistence/lessonDocuments";
import { startedAt, starterWorld } from "../testing/lessonWorld";
import {
  doneBites,
  finishedBites,
  recordWith,
  underWayOf,
  withLessonsDone,
} from "./record";
import { skip, startLesson } from "./session";

const settings = { style: "boom_bap" } as const;

describe("the lesson record, as the lessons keep it (GRV-190)", () => {
  it("keeps where the lesson stands, and a bite over past its last step", () => {
    const world = starterWorld();
    const { state } = startedAt("tour", "tour-library", world, settings);
    expect(underWayOf(state)).toEqual({
      lessonId: "tour",
      chapterIndex: 0,
      biteId: "tour-library",
      stepIndex: state.step?.index,
      endings: {},
      passed: [],
    });
    const ended = skip(state, world, settings);
    if (!ended) throw new Error("not skipped");
    expect(underWayOf(ended.state)).toMatchObject({
      stepIndex: 2,
      endings: { "tour-library": "skipped" },
    });
  });

  it("comes back at the same step from what it kept: a reload, a tab, a device", () => {
    const world = starterWorld();
    const { state } = startedAt("sound", "sound-wave", world, settings);
    const moved = skip(state, world, settings);
    if (!moved) throw new Error("not skipped");
    const record = recordWith(emptyLessonRecord(), moved.state, 5);
    const resumed = startLesson("sound", record, world, settings);
    expect(resumed?.state).toMatchObject({
      biteIndex: moved.state.biteIndex,
      step: { index: moved.state.step?.index },
    });
  });

  it("writes a finished bite with how and when, and null once the lesson is over", () => {
    const record = recordWith(emptyLessonRecord(), null, 7, {
      biteId: "beat-kick",
      how: "skipped",
    });
    expect(record).toEqual({
      underWay: null,
      finished: { "beat-kick": { how: "skipped", at: 7 } },
      updatedAt: 7,
    });
  });

  it("never counts a skipped bite as done, and derives the profile's list from the done", () => {
    const record = {
      ...emptyLessonRecord(),
      finished: {
        "beat-kick": { how: "did_it", at: 1 },
        "beat-snare": { how: "skipped", at: 1 },
        "beat-gone": { how: "did_it", at: 1 },
        "beat-play": { how: "show_me", at: 1 },
      },
    } as const;
    expect(finishedBites(record)).toEqual({
      "beat-kick": "did_it",
      "beat-snare": "skipped",
      "beat-play": "show_me",
    });
    expect(doneBites(record)).toEqual(["beat-kick", "beat-play"]);
    expect(withLessonsDone(["tour-mixer", "track-under-way"], record)).toEqual([
      "tour-mixer",
      "beat-kick",
      "beat-play",
    ]);
  });
});
