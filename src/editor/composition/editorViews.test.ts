import { describe, expect, it } from "vitest";
import { EDITOR_VIEWS } from "../../analytics/catalog";
import { SHORTCUT_ACTION_IDS } from "../../shortcuts";
import {
  DEFAULT_EDITOR_VIEW,
  EDITOR_VIEW_SPECS,
  editorViewFromPath,
  editorViewPath,
  editorViewSpec,
} from "./editorViews";

describe("editorViews", () => {
  it("specs exactly the views the analytics catalog publishes, in dock order", () => {
    expect(EDITOR_VIEW_SPECS.map((spec) => spec.view)).toEqual([...EDITOR_VIEWS]);
  });

  it("names a registered shortcut action for every view", () => {
    for (const spec of EDITOR_VIEW_SPECS) {
      expect(SHORTCUT_ACTION_IDS).toContain(spec.actionId);
    }
  });

  it("puts the default view at the bare project address, and the rest below it", () => {
    expect(editorViewSpec(DEFAULT_EDITOR_VIEW).segment).toBe("");
    expect(editorViewPath("prj_abc", "arrangement")).toBe("/projects/prj_abc");
    expect(editorViewPath("prj_abc", "sequence")).toBe("/projects/prj_abc/sequence");
    expect(editorViewPath("prj_abc", "instrument")).toBe("/projects/prj_abc/instrument");
    expect(editorViewPath("prj_abc", "library")).toBe("/projects/prj_abc/library");
    expect(editorViewPath("prj_abc", "mixer")).toBe("/projects/prj_abc/mixer");
  });

  it("reads a view back out of the address it was built from", () => {
    for (const spec of EDITOR_VIEW_SPECS) {
      const path = editorViewPath("prj_abc", spec.view);
      expect(editorViewFromPath(path), path).toBe(spec.view);
    }
  });

  it("tolerates a trailing slash, which a pasted link often carries", () => {
    expect(editorViewFromPath("/projects/prj_abc/mixer/")).toBe("mixer");
  });

  it("falls back to the arrangement rather than to no view at all", () => {
    // The first two are unreachable through the router, which matches only the
    // three registered paths — reachable if it and this module ever drift. The
    // last is the one that could bite: a project id is not a view segment.
    expect(editorViewFromPath("/projects/prj_abc/devices")).toBe(DEFAULT_EDITOR_VIEW);
    expect(editorViewFromPath("/projects")).toBe(DEFAULT_EDITOR_VIEW);
    expect(editorViewFromPath("/projects/mixer")).toBe(DEFAULT_EDITOR_VIEW);
  });

  it("refuses a view it does not know", () => {
    expect(() => editorViewSpec("devices" as never)).toThrow(TypeError);
  });
});
