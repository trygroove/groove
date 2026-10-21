import { describe, expect, it } from "vitest";
import { EDITOR_VIEWS, type EditorViewName } from "../analytics/catalog";
import { applyShowMe, lessonContext, starterWorld } from "../testing/lessonWorld";
import { nextStep } from "./chapters";
import { observe, skip, startBite } from "./session";
import { TOUR_CHAPTER } from "./tour";

describe("Tour the studio (GRV-43)", () => {
  it("visits the five views in dock order, one bite each", () => {
    expect(TOUR_CHAPTER.bites).toHaveLength(EDITOR_VIEWS.length);
    expect(TOUR_CHAPTER.bites.map((bite) => bite.id)).toEqual(
      EDITOR_VIEWS.map((view) => `tour-${view}`),
    );
  });

  const settings = { style: "trap" } as const;
  const biteFor = (view: EditorViewName) => {
    const found = TOUR_CHAPTER.bites.find((one) => one.id === `tour-${view}`);
    if (!found) throw new Error(view);
    return found;
  };

  it.each(EDITOR_VIEWS)(
    "is done once the producer goes to the %s view, which Show me opens",
    (view) => {
      const elsewhere = starterWorld({ view: view === "mixer" ? "library" : "mixer" });
      const next = nextStep(biteFor(view), elsewhere, settings);
      if (!next) throw new Error(view);
      // Not on the view: the bite goes straight to opening it.
      expect(next.step.id).toBe("open");
      expect(next.step.done(elsewhere, elsewhere, settings)).toBe(false);
      const after = applyShowMe(
        elsewhere,
        next.step.showMe(elsewhere, settings, lessonContext()),
      );
      expect(after.view).toBe(view);
      expect(next.step.done(after, elsewhere, settings)).toBe(true);
    },
  );

  it("does not finish the Arrangement at once on the arrangement the editor opens on", () => {
    // The starter world is on the arrangement, as the editor opens.
    const world = starterWorld();
    expect(world.view).toBe("arrangement");
    const bite = biteFor("arrangement");
    let state = startBite("tour", bite.id, world, settings).state;
    expect(state.step?.index).toBe(0);
    expect(bite.steps[0].id).toBe("away");
    // Being on it is not going there.
    expect(observe(state, world, settings)).toBeNull();

    const away = starterWorld({ view: "sequence" });
    const left = observe(state, away, settings);
    expect(left?.event).toMatchObject({ kind: "step_done", how: "did_it" });
    if (!left) throw new Error("did not step away");
    state = left.state;
    expect(bite.steps[state.step?.index ?? -1]?.id).toBe("open");
    expect(observe(state, away, settings)).toBeNull();

    const back = observe(state, world, settings);
    expect(back?.event).toMatchObject({ kind: "bite_done", how: "did_it" });
  });

  it("Show me steps away and back again from the view it starts on", () => {
    const world = starterWorld();
    const bite = biteFor("arrangement");
    const away = bite.steps[0].showMe(world, settings, lessonContext());
    expect(away).toEqual({ kind: "view", view: "sequence" });
    const left = applyShowMe(world, away);
    expect(bite.steps[0].done(left, world, settings)).toBe(true);
    const back = applyShowMe(left, bite.steps[1].showMe(left, settings, lessonContext()));
    expect(bite.steps[1].done(back, left, settings)).toBe(true);
    // From the sequence view's own bite, Show me steps away to the arrangement.
    const sequence = starterWorld({ view: "sequence" });
    expect(
      biteFor("sequence").steps[0].showMe(sequence, settings, lessonContext()),
    ).toEqual({ kind: "view", view: "arrangement" });
  });

  it("moves on to the next bite when the step away is skipped (QA, GRV-43)", () => {
    // The editor opens on the arrangement, so its bite asks to step away first.
    const world = starterWorld();
    const started = startBite("tour", "tour-arrangement", world, settings).state;
    expect(started.step?.index).toBe(0);
    const skipped = skip(started, world, settings);
    // Still on the arrangement, there is nothing left to open: the bite is over.
    expect(skipped?.event).toMatchObject({ kind: "bite_done", how: "skipped" });
    expect(skipped?.state.step).toBeNull();
    expect(skipped?.state.endings).toEqual({ "tour-arrangement": "skipped" });
  });
});
