import { describe, expect, it } from "vitest";
import { noteEventsOf } from "../../commands";
import type { Clip, NoteEvent } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
} from "../../domain/fixtures";
import { createSeededIdFactory, type EventId } from "../../domain/ids";
import {
  buildTransform,
  canTransform,
  DEFAULT_TRANSFORM_OPTIONS,
  formatSemitones,
  nudgeSemitones,
  parseSemitones,
  resolveTransformScope,
  TRANSFORM_GRID_TICKS,
  TRANSFORM_KINDS,
  transformedEventCount,
} from "./transformModel";

const project = createPianoRollFixtureProject();
const clip = project.clips[0];
const events = noteEventsOf(clip) ?? [];
const ids = () => events.map((event) => event.id);

function emptyClip(): Clip {
  return { ...clip, content: { kind: "notes", events: [] } };
}

describe("resolveTransformScope", () => {
  it("widens an empty selection to the whole clip", () => {
    const scope = resolveTransformScope(clip, []);
    expect(scope.eventIds).toBeNull();
    expect(scope.isWholeClip).toBe(true);
    expect(scope.count).toBe(events.length);
  });

  it("keeps an explicit selection", () => {
    const scope = resolveTransformScope(clip, [ids()[0], ids()[2]]);
    expect(scope.eventIds).toEqual([ids()[0], ids()[2]]);
    expect(scope.isWholeClip).toBe(false);
    expect(scope.count).toBe(2);
  });

  it("drops selected ids the clip no longer holds", () => {
    // A selection can outlive its notes (an undo, a remote edit). Passing a
    // stale id through would make the command reject the whole
    // transformation, so the scope filters it out first.
    const stale = "evt_gone" as EventId;
    const scope = resolveTransformScope(clip, [ids()[1], stale]);
    expect(scope.eventIds).toEqual([ids()[1]]);
    expect(scope.count).toBe(1);
  });

  it("falls back to the active row, not the clip, when the editor gives one (#643)", () => {
    const row = { name: "CH", eventIds: [ids()[1], ids()[3]] };
    const scope = resolveTransformScope(clip, [], row);
    expect(scope.eventIds).toEqual([ids()[1], ids()[3]]);
    expect(scope.count).toBe(2);
    expect(scope.isWholeClip).toBe(false);
    expect(scope.rowName).toBe("CH");
  });

  it("keeps a selection across rows over the row fallback (#643)", () => {
    const row = { name: "CH", eventIds: [ids()[1]] };
    const scope = resolveTransformScope(clip, [ids()[0], ids()[2]], row);
    expect(scope.eventIds).toEqual([ids()[0], ids()[2]]);
    expect(scope.rowName).toBeUndefined();
  });

  it("falls back to the whole clip when every selected id is stale", () => {
    const scope = resolveTransformScope(clip, ["evt_gone" as EventId]);
    expect(scope.eventIds).toBeNull();
    expect(scope.count).toBe(events.length);
  });

  it("reports an empty clip as having nothing to transform", () => {
    const scope = resolveTransformScope(emptyClip(), []);
    expect(scope.count).toBe(0);
    expect(canTransform(scope)).toBe(false);
  });
});

describe("buildTransform", () => {
  const context = {
    project,
    clip,
    scope: resolveTransformScope(clip, []),
    ids: createSeededIdFactory("transform-model"),
    options: DEFAULT_TRANSFORM_OPTIONS,
  };

  it("builds a registered command for every kind", () => {
    for (const kind of TRANSFORM_KINDS) {
      const built = buildTransform(kind, {
        ...context,
        ids: createSeededIdFactory(`transform-${kind}`),
      });
      // Double is a transaction of clip, notes and placement commands (#647).
      for (const command of [built].flat()) {
        expect(command.type).toMatch(/^(notes|clip|placement)\./);
      }
    }
  });

  it("quantizes and varies against the editors' 16th grid", () => {
    const quantize = buildTransform("quantize", context) as {
      payload: { gridTicks: number; strength: number };
    };
    expect(quantize.payload.gridTicks).toBe(TRANSFORM_GRID_TICKS);
    expect(quantize.payload.strength).toBe(1);

    type VaryPayload = { gridTicks: number; seed: string; target: string };
    const vary = buildTransform("vary", context) as { payload: VaryPayload };
    expect(vary.payload.gridTicks).toBe(TRANSFORM_GRID_TICKS);
    expect(vary.payload.target).toBe("timing");
    // A fresh seed per press (#653), minted by the caller's id factory.
    const again = buildTransform("vary", context) as { payload: VaryPayload };
    expect(again.payload.seed).not.toBe(vary.payload.seed);
    const velocity = buildTransform("varyVelocity", context) as { payload: VaryPayload };
    expect(velocity.payload.target).toBe("velocity");
  });

  it("doubles the whole clip, minting one new id per note, whatever is selected", () => {
    const [grow, copy] = buildTransform("duplicate", {
      ...context,
      scope: resolveTransformScope(clip, [events[0].id]),
      ids: createSeededIdFactory("dup"),
    }) as readonly {
      type: string;
      payload: {
        changes?: { lengthTicks: number };
        newIds: string[];
        offsetTicks: number;
      };
    }[];
    expect(grow.type).toBe("clip.update");
    expect(grow.payload.changes?.lengthTicks).toBe(clip.lengthTicks * 2);
    expect(copy.payload.newIds).toHaveLength(events.length);
    expect(copy.payload.offsetTicks).toBe(clip.lengthTicks);
  });

  it("clears the whole clip regardless of the selection", () => {
    const cleared = buildTransform("clear", {
      ...context,
      scope: resolveTransformScope(clip, [ids()[0]]),
    }) as { payload: Record<string, unknown> };
    expect(cleared.payload).toEqual({ clipId: clip.id });
  });
});

describe("transformedEventCount", () => {
  it("counts the selection for a scoped transformation", () => {
    const scope = resolveTransformScope(clip, [ids()[0], ids()[1]]);
    expect(transformedEventCount("transpose", scope, clip)).toBe(2);
  });

  it("counts the whole clip for clear, whatever was selected", () => {
    const scope = resolveTransformScope(clip, [ids()[0]]);
    expect(transformedEventCount("clear", scope, clip)).toBe(events.length);
  });
});

describe("mixed event types", () => {
  // A drum-machine clip's notes fire pads, not pitches. Transpose skips those
  // triggers rather than rejecting the clip, so a selection mixing both kinds
  // still transposes the pitched notes and leaves the pads alone.
  const drumProject = createDrumMachineFixtureProject();
  const drumClip = drumProject.clips.find(
    (candidate) =>
      (noteEventsOf(candidate) ?? []).some((event) => event.trigger.kind === "pad") ??
      false,
  );

  it("scopes a pad-triggered clip like any other note clip", () => {
    expect(drumClip).toBeDefined();
    const padEvents = noteEventsOf(drumClip as Clip) ?? [];
    const scope = resolveTransformScope(drumClip as Clip, []);
    expect(scope.count).toBe(padEvents.length);
    expect(canTransform(scope)).toBe(true);
  });

  it("builds a transpose over pad triggers without inspecting them", () => {
    // The model is trigger-agnostic — deciding what a pad trigger does under
    // transposition is the command's job, and it is covered there.
    const padEvents: readonly NoteEvent[] = noteEventsOf(drumClip as Clip) ?? [];
    const command = buildTransform("transpose", {
      project: drumProject,
      clip: drumClip as Clip,
      scope: resolveTransformScope(drumClip as Clip, [padEvents[0].id]),
      ids: createSeededIdFactory("drum-transform"),
      options: DEFAULT_TRANSFORM_OPTIONS,
    }) as { payload: { eventIds: string[] } };
    expect(command.payload.eventIds).toEqual([padEvents[0].id]);
  });
});

describe("Double and the value fields (ARR-010)", () => {
  it("builds Quantize to scale for the scope", () => {
    const command = buildTransform("quantizeToScale", {
      project,
      clip,
      scope: resolveTransformScope(clip, [ids()[1]]),
      ids: createSeededIdFactory("to-scale"),
      options: DEFAULT_TRANSFORM_OPTIONS,
    }) as { type: string; payload: { eventIds: string[] } };
    expect(command.type).toBe("notes.quantizeToScale");
    expect(command.payload.eventIds).toEqual([ids()[1]]);
  });

  it("shows and reads semitones, clamped to the command's range", () => {
    expect(formatSemitones(12)).toBe("+12 st");
    expect(formatSemitones(-5)).toBe("−5 st");
    expect(parseSemitones("+12 st")).toBe(12);
    expect(parseSemitones("−7")).toBe(-7);
    expect(parseSemitones("-7 st")).toBe(-7);
    expect(parseSemitones("300")).toBe(127);
    expect(parseSemitones("up")).toBeNull();
  });

  it("nudges the semitones by one, within its range", () => {
    expect(nudgeSemitones(12, 1)).toBe(13);
    expect(nudgeSemitones(-127, -1)).toBe(-127);
  });
});
