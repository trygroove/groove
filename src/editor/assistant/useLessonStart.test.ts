import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { LessonSource } from "../../lessons/ids";
import { biteOf, type LessonState, type LessonTransition } from "../../lessons/session";
import { beatStyleFor } from "../../lessons/style";
import { InMemoryLessonRepository } from "../../persistence/inMemoryLessonRepository";
import { emptyLessonRecord, type LessonRecord } from "../../persistence/lessonDocuments";
import { createManualClock } from "../../shared/clock";
import { starterWorld } from "../../testing/lessonWorld";
import { useLessonRecord } from "./useLessonRecord";
import { useLessonStart } from "./useLessonStart";

const OWNER = { uid: "user_1", projectId: "prj_1" } as const;

/** The tour stored as under way at its Mixer bite. */
const TOUR_AT_MIXER: LessonRecord = {
  ...emptyLessonRecord(),
  underWay: {
    lessonId: "tour",
    chapterIndex: 0,
    biteId: "tour-mixer",
    stepIndex: 0,
    endings: {},
    passed: [],
  },
};

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
  }
}

function setup(stored?: LessonRecord) {
  const repository = new InMemoryLessonRepository({ clock: createManualClock(10) });
  if (stored) void repository.saveRecord(OWNER.uid, OWNER.projectId, stored);
  const [state, setState] = createSignal<LessonState | null>(null);
  const begun: { transition: LessonTransition; source: LessonSource }[] = [];
  const log = vi.fn();
  const starts = createRoot(() => {
    const record = useLessonRecord({
      owner: () => OWNER,
      repository: async () => repository,
    });
    return useLessonStart({
      record,
      world: () => starterWorld(),
      settings: () => ({ style: beatStyleFor([]) }),
      current: state,
      restore: (back) => setState(back),
      begin: (transition, source) => {
        begun.push({ transition, source });
        setState(transition.state);
      },
      analytics: () => ({ log }),
    });
  });
  return { starts, state, begun, log };
}

describe("starting a lesson beside its record (GRV-190)", () => {
  it("brings the stored lesson back once the record is read, without beginning it", async () => {
    const h = setup(TOUR_AT_MIXER);
    await settle();
    const back = h.state();
    expect(back && biteOf(back).id).toBe("tour-mixer");
    expect(h.begun).toHaveLength(0);
  });

  it("holds a start asked for before the read, then begins it from the record", async () => {
    const h = setup(TOUR_AT_MIXER);
    expect(h.starts.start("tour", "list")).toBe(true);
    flush();
    expect(h.begun).toHaveLength(0);
    await settle();
    expect(h.begun).toHaveLength(1);
    expect(h.begun[0]?.source).toBe("list");
    expect(biteOf(h.begun[0]?.transition.state as LessonState).id).toBe("tour-mixer");
  });

  it("forgets a held start", async () => {
    const h = setup();
    h.starts.start("tour", "asked");
    h.starts.forget();
    await settle();
    expect(h.begun).toHaveLength(0);
    expect(h.state()).toBeNull();
  });

  it("drops out of the lesson under way when another starts", async () => {
    const h = setup();
    await settle();
    h.starts.start("tour", "asked");
    flush();
    expect(h.log).not.toHaveBeenCalled();
    h.starts.start("beat", "list");
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith("lesson_dropped_out", {
      chapter_id: "tour",
      bite_id: expect.any(String),
    });
    flush();
    expect(h.state()?.lessonId).toBe("beat");
  });

  it("drops out of another lesson the record had under way when a held start replaces it", async () => {
    const h = setup(TOUR_AT_MIXER);
    h.starts.start("beat", "list");
    await settle();
    expect(h.state()?.lessonId).toBe("beat");
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith("lesson_dropped_out", {
      chapter_id: "tour",
      bite_id: "tour-mixer",
    });
  });

  it("does not drop out of the stored lesson when a held start carries it on", async () => {
    const h = setup(TOUR_AT_MIXER);
    h.starts.start("tour", "list");
    await settle();
    expect(h.state() && biteOf(h.state() as LessonState).id).toBe("tour-mixer");
    expect(h.log).not.toHaveBeenCalled();
  });
});
