import { describe, expect, it } from "vitest";
import { stringifyProject } from "../../domain/serialize";
import { buildAssistantPayload } from "../payload";
import { assistantContextPayloadSchema } from "../protocol";
import {
  casePairs,
  EVAL_CAPABILITIES,
  EVAL_CASES,
  resolveScope,
  resolveSelection,
} from "./cases";
import { checkBundled } from "./checks";

describe("the eval cases", () => {
  it("ask every capability once conventionally and once at an extreme, on one fixture", () => {
    const pairs = casePairs();
    expect(pairs.map((pair) => pair.conventional.capability)).toEqual([
      ...EVAL_CAPABILITIES,
    ]);
    for (const { conventional, extreme } of pairs) {
      expect(extreme.fixture).toBe(conventional.fixture);
    }
  });

  it("have unique IDs", () => {
    const ids = EVAL_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(EVAL_CASES.map((entry) => [entry.id, entry] as const))(
    "%s: builds the same valid project every time, with only factory sounds",
    (_id, entry) => {
      const project = entry.fixture();
      expect(stringifyProject(entry.fixture())).toBe(stringifyProject(project));
      expect(checkBundled([], project).status).toBe("pass");
      // The selection and scope resolve against the fixture's names.
      const selection = resolveSelection(project, entry.selection);
      expect(resolveScope(project, entry.scope).tracks.size).toBeGreaterThanOrEqual(0);
      const context = assistantContextPayloadSchema.parse(
        buildAssistantPayload(project, selection),
      );
      if (entry.selection) expect(context.selectedNotes?.noteCount).toBeGreaterThan(0);
      else expect(context.selectedNotes).toBeNull();
    },
  );

  it("show a loop sketch every drum pad it can play", () => {
    const sketch = EVAL_CASES.find((entry) => entry.capability === "loopSketch");
    if (!sketch) throw new Error("no sketch case");
    const project = sketch.fixture();
    const context = buildAssistantPayload(
      project,
      resolveSelection(project, sketch.selection),
    );
    const seen = new Set(
      context.selectedNotes?.clips.flatMap((clip) =>
        clip.events.flatMap((event) =>
          event.trigger.kind === "pad" ? [event.trigger.padId] : [],
        ),
      ),
    );
    const drums = project.song.tracks[0].instrument;
    expect(drums?.kind).toBe("drumMachine");
    if (drums?.kind === "drumMachine") {
      expect(seen).toEqual(new Set(drums.pads.map((pad) => pad.id)));
    }
  });

  it("refuse a name the fixture does not have", () => {
    const project = EVAL_CASES[0].fixture();
    expect(() => resolveSelection(project, { tracks: ["Nope"] })).toThrow(
      /no track named/,
    );
  });
});
