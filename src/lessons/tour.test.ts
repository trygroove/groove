import { describe, expect, it } from "vitest";
import { EDITOR_VIEWS } from "../analytics/catalog";
import { applyShowMe, lessonContext, starterWorld } from "../testing/lessonWorld";
import { TOUR_CHAPTER } from "./tour";

describe("Tour the studio (GRV-43)", () => {
  it("visits the five views in dock order, one bite each", () => {
    expect(TOUR_CHAPTER.bites).toHaveLength(EDITOR_VIEWS.length);
    expect(TOUR_CHAPTER.bites.map((bite) => bite.id)).toEqual(
      EDITOR_VIEWS.map((view) => `tour-${view}`),
    );
  });

  it.each(EDITOR_VIEWS)("is done on the %s view, which Show me opens", (view) => {
    const bite = TOUR_CHAPTER.bites.find((one) => one.id === `tour-${view}`);
    const step = bite?.steps[0];
    if (!step) throw new Error(view);
    const elsewhere = starterWorld({ view: view === "mixer" ? "library" : "mixer" });
    const settings = { style: "trap" } as const;
    expect(step.done(elsewhere, elsewhere, settings)).toBe(false);
    const after = applyShowMe(
      elsewhere,
      step.showMe(elsewhere, settings, lessonContext()),
    );
    expect(after.view).toBe(view);
    expect(step.done(after, elsewhere, settings)).toBe(true);
  });
});
