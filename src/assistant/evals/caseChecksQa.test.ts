import { describe, expect, it } from "vitest";
import {
  addClip,
  addTrack,
  changeInstrument,
  executeTransaction,
  setParameter,
} from "../../commands";
import type { RawCommandInput } from "../../commands/types";
import type { Project } from "../../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createFactoryContext,
  createNoteClip,
  createNoteEvent,
  createSynthInstrument,
  createTrack,
} from "../../domain/factories";
import { createSeededIdFactory } from "../../domain/ids";
import { TICKS_PER_BAR } from "../../domain/time";
import { checkOutcome, runCaseCheck } from "./caseChecks";
import {
  checkAddsTracks,
  checkEndsAt,
  checkNoEmptyClips,
  checkNoNoOps,
  type ExpectedValue,
} from "./caseChecksQa";
import { createBdOnlyProject, createBdSketchProject } from "./fixtures";

const context = createFactoryContext({ ids: createSeededIdFactory("qa-checks") });

function apply(project: Project, commands: readonly RawCommandInput[]): Project {
  const result = executeTransaction(project, commands);
  if (!result.ok)
    throw new Error(`fixture command refused: ${result.issues[0]?.message}`);
  return result.project;
}

const volumeTo = (project: Project, value: number): RawCommandInput =>
  setParameter(
    { scope: "track", trackId: project.song.tracks[0].id, parameterId: "track.volume" },
    value,
  );

describe("check 8 for a case that accepts a proposal or a question about scope", () => {
  const proposal = { calls: [] };

  it("passes a proposal", () => {
    expect(checkOutcome("either", { proposal, ask: null }).status).toBe("pass");
  });

  it("passes a question that offers to widen the scope", () => {
    const ask = { question: "Want me to widen the scope to the whole song?" };
    expect(checkOutcome("either", { proposal: null, ask }).status).toBe("pass");
  });

  it("reads the options of the question too", () => {
    const ask = {
      question: "Where should these go?",
      options: [{ label: "Add new tracks", description: "Outside BD" }],
    };
    expect(checkOutcome("either", { proposal: null, ask }).status).toBe("pass");
  });

  it("fails a question about something else, and a reply that does neither", () => {
    const ask = { question: "Which key should it be in?" };
    expect(checkOutcome("either", { proposal: null, ask }).status).toBe("fail");
    expect(checkOutcome("either", { proposal: null, ask: null }).status).toBe("fail");
  });
});

describe("check 14: adds tracks", () => {
  const before = createBdOnlyProject();

  it("passes when a track is added and fails when none is", () => {
    const track = createTrack(context, {
      name: "Bass",
      order: 1,
      instrument: createSynthInstrument(),
    });
    expect(checkAddsTracks(before, apply(before, [addTrack(track)])).status).toBe("pass");
    expect(checkAddsTracks(before, before).status).toBe("fail");
  });
});

describe("check 15: a parameter ends at the exact value", () => {
  const expected: ExpectedValue = {
    track: "BD",
    parameter: "volume",
    value: -4,
    tolerance: 0.05,
  };
  const before = createBdOnlyProject(-3);

  it("passes the value, and a value within the tolerance", () => {
    expect(checkEndsAt(apply(before, [volumeTo(before, -4)]), expected).status).toBe(
      "pass",
    );
    expect(checkEndsAt(apply(before, [volumeTo(before, -4.04)]), expected).status).toBe(
      "pass",
    );
  });

  it("fails a nudge from the wrong base, an unchanged value and a missing case value", () => {
    // The stale -5 dB base: -5 + -1 would be -6, and 3 up from it -2.
    const wrong = checkEndsAt(apply(before, [volumeTo(before, -6)]), expected);
    expect(wrong.status).toBe("fail");
    expect(wrong.detail).toContain("-6.0 dB");
    expect(checkEndsAt(before, expected).status).toBe("fail");
    expect(checkEndsAt(before, undefined).status).toBe("fail");
  });

  it("fails when the track is gone", () => {
    expect(checkEndsAt(before, { ...expected, track: "Nope" }).status).toBe("fail");
  });
});

describe("check 16: no clip left without notes", () => {
  const before = createBdSketchProject();
  const track = before.song.tracks[1];

  it("passes a new clip with notes", () => {
    const clip = createNoteClip(context, {
      trackId: track.id,
      name: "Lurch",
      lengthTicks: TICKS_PER_BAR,
      events: [createNoteEvent(context, { pitch: 40, startTicks: 0, durationTicks: 48 })],
    });
    expect(checkNoEmptyClips(before, apply(before, [addClip(clip)])).status).toBe("pass");
  });

  it("fails a new clip with no notes, and an existing clip emptied", () => {
    const empty = createNoteClip(context, {
      trackId: track.id,
      name: "Lurch",
      lengthTicks: TICKS_PER_BAR,
      events: [],
    });
    const added = checkNoEmptyClips(before, apply(before, [addClip(empty)]));
    expect(added.status).toBe("fail");
    expect(added.detail).toContain("Lurch");

    const existing = before.clips[1];
    const emptied: Project = {
      ...before,
      clips: before.clips.map((clip) =>
        clip.id === existing.id
          ? { ...clip, content: { kind: "notes", events: [] } }
          : clip,
      ),
    };
    expect(checkNoEmptyClips(before, emptied).status).toBe("fail");
  });

  it("leaves a clip the proposal did not touch alone", () => {
    expect(checkNoEmptyClips(before, before).status).toBe("pass");
  });
});

describe("check 17: no command sets a value to what it already is", () => {
  const before = createBdOnlyProject(-3);
  const bd = before.song.tracks[0];

  it("passes commands that each change something", () => {
    const commands = [volumeTo(before, -4)];
    expect(checkNoNoOps(before, commands).status).toBe("pass");
  });

  it("fails a volume set to the volume it has", () => {
    const result = checkNoNoOps(before, [volumeTo(before, -3)]);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("BD volume: -3.0 dB → -3.0 dB");
  });

  it("fails an instrument replaced by the same kind of instrument", () => {
    if (bd.instrument?.kind !== "drumMachine") throw new Error("unexpected fixture");
    const same = createDrumMachineInstrument(bd.instrument.pads);
    const result = checkNoNoOps(before, [changeInstrument(bd.id, same)]);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Drum machine → Drum machine");
  });

  it("passes the same kind of instrument with different pads", () => {
    if (bd.instrument?.kind !== "drumMachine") throw new Error("unexpected fixture");
    const [pad] = bd.instrument.pads;
    const extra = createDrumPad(context, { name: "Two", assetId: pad.assetId });
    const wider = createDrumMachineInstrument([pad, extra]);
    const result = checkNoNoOps(before, [changeInstrument(bd.id, wider)]);
    expect(result.detail).not.toContain("did not apply");
    expect(result.status).toBe("pass");
  });

  it("passes an instrument replaced by another kind", () => {
    // The kit's clip plays pads a synth does not own, so test the bare track.
    const bare: Project = {
      ...before,
      clips: [],
      song: { ...before.song, placements: [] },
    };
    const result = checkNoNoOps(bare, [changeInstrument(bd.id, createSynthInstrument())]);
    expect(result.detail).not.toContain("did not apply");
    expect(result.status).toBe("pass");
  });

  it("judges each command against what the ones before it left", () => {
    const result = checkNoNoOps(before, [volumeTo(before, -4), volumeTo(before, -4)]);
    expect(result.status).toBe("fail");
  });
});

describe("runCaseCheck dispatches GRV-107's checks", () => {
  it("hands the commands and the expected value through", () => {
    const before = createBdOnlyProject(-3);
    const command = volumeTo(before, -4);
    const after = apply(before, [command]);
    const expectedValue: ExpectedValue = {
      track: "BD",
      parameter: "volume",
      value: -4,
      tolerance: 0.05,
    };
    expect(runCaseCheck("endsAt", before, after, "", { expectedValue }).status).toBe(
      "pass",
    );
    expect(
      runCaseCheck("noNoOps", before, after, "", { commands: [command] }).status,
    ).toBe("pass");
    expect(runCaseCheck("addsTracks", before, after, "").status).toBe("fail");
    expect(runCaseCheck("noEmptyClips", before, after, "").status).toBe("pass");
  });
});
