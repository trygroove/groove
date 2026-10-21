import { describe, expect, it } from "vitest";
import type { NoteEvent } from "../../domain/entities";
import type { EventId, PadId } from "../../domain/ids";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import type { StepLane } from "./stepEditorModel";
import { lassoHits } from "./stepPointer";

const lane = (pad: string): StepLane => ({
  key: pad,
  name: pad,
  trigger: { kind: "pad", padId: pad as PadId },
});

const note = (id: string, pad: string, step: number): NoteEvent =>
  ({
    id: id as EventId,
    trigger: { kind: "pad", padId: pad as PadId },
    startTicks: step * TICKS_PER_SIXTEENTH,
    durationTicks: TICKS_PER_SIXTEENTH,
    velocity: 0.8,
    probability: null,
  }) as NoteEvent;

const LANES = [lane("pad_bd"), lane("pad_cp")];
const NOTES = [note("e1", "pad_bd", 0), note("e2", "pad_bd", 4), note("e3", "pad_cp", 4)];

describe("lassoHits", () => {
  it("selects the cells a rectangle touches, row by row", () => {
    // Steps 3-5 (0-based), both rows, at 40 px steps and 30 px rows.
    const rect = { left: 140, top: 15, right: 220, bottom: 45 };
    expect(lassoHits(NOTES, LANES, rect, 40)).toEqual(["e2", "e3"]);
  });

  it("keeps to the rows it crosses", () => {
    const rect = { left: 0, top: 5, right: 400, bottom: 20 };
    expect(lassoHits(NOTES, LANES, rect, 40)).toEqual(["e1", "e2"]);
  });

  it("follows the step width a zoom gives", () => {
    // At 80 px steps, step 4 starts at 320.
    const rect = { left: 300, top: 40, right: 330, bottom: 50 };
    expect(lassoHits(NOTES, LANES, rect, 80)).toEqual(["e3"]);
  });

  it("ignores a note on a pad with no lane", () => {
    const stray = note("e4", "pad_gone", 0);
    const rect = { left: 0, top: 0, right: 40, bottom: 60 };
    expect(lassoHits([...NOTES, stray], LANES, rect, 40)).toEqual(["e1"]);
  });
});
