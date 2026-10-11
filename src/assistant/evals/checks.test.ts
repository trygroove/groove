import { describe, expect, it } from "vitest";
import {
  addAsset,
  addClip,
  addDevice,
  addNotes,
  addTrack,
  type CommandHistory,
  type CommandInput,
  changeInstrument,
  createCommandHistory,
  type RawCommandInput,
  setParameter,
} from "../../commands";
import type { TransactionOptions, TransactionResult } from "../../commands/execute";
import { createDevice } from "../../domain/devices";
import type { Project, Track } from "../../domain/entities";
import {
  createAsset,
  createFactoryContext,
  createNoteClip,
  createNoteEvent,
  createPlacement,
  createSamplerInstrument,
  createSynthInstrument,
  createTrack,
  type DomainFactoryContext,
} from "../../domain/factories";
import { createSeededIdFactory } from "../../domain/ids";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";
import { factoryLibraryEntry, factoryPack } from "../../library/factoryLibrary";
import { historyProposalTarget } from "../historyProposalTarget";
import { ASSISTANT_TOOLSET_VERSION, toolNameFor } from "../tools";
import { type EvalScope, resolveScope } from "./cases";
import {
  checkAtomicUndo,
  checkBundled,
  checkGrounded,
  checkInScope,
  checkNotFlattened,
  checkValid,
  proposalFingerprint,
  type UndoBench,
} from "./checks";
import { createHouseLoopProject } from "./fixtures";

const project = createHouseLoopProject();

function track(name: string): Track {
  const found = project.song.tracks.find((candidate) => candidate.name === name);
  if (!found) throw new Error(name);
  return found;
}

function context(seed: string): DomainFactoryContext {
  return createFactoryContext({ ids: createSeededIdFactory(seed) });
}

function proposalOf(commands: readonly CommandInput<unknown>[], base = project) {
  return {
    baseRevision: base.metadata.revision,
    toolsetVersion: ASSISTANT_TOOLSET_VERSION,
    calls: commands.map((command) => ({
      name: toolNameFor(command.type),
      input: command.payload,
    })),
  };
}

const bassDown = setParameter(
  { scope: "track", trackId: track("Bass").id, parameterId: "track.volume" },
  -6,
);

/** Applies a proposal that check 1 passes, for the checks that judge the result. */
function applied(commands: readonly CommandInput<unknown>[]) {
  const outcome = checkValid(project, proposalOf(commands));
  if (!outcome.applied) throw new Error(outcome.result.detail);
  return outcome.applied;
}

function synthTrackWithLoop(seed: string, notes: readonly number[]) {
  const ctx = context(seed);
  const added = createTrack(ctx, {
    name: "Pad",
    order: project.song.tracks.length,
    instrument: createSynthInstrument(),
  });
  const clip = createNoteClip(ctx, {
    trackId: added.id,
    name: "Pad",
    lengthTicks: TICKS_PER_BAR,
    events: notes.map((pitch) =>
      createNoteEvent(ctx, { pitch, startTicks: 0, durationTicks: TICKS_PER_BAR }),
    ),
  });
  const placement = createPlacement(ctx, {
    clipId: clip.id,
    trackId: added.id,
    startTicks: 0,
    durationTicks: TICKS_PER_BAR,
  });
  return addTrack(added, { clips: [clip], placements: [placement] });
}

describe("check 1: valid", () => {
  it("passes a proposal that parses and applies through the executor", () => {
    const outcome = checkValid(project, proposalOf([bassDown]));
    expect(outcome.result.status).toBe("pass");
    expect(
      outcome.applied?.after.song.tracks.find((t) => t.name === "Bass")?.mixer.volume,
    ).toBe(-6);
  });

  it("fails a reply that proposed nothing", () => {
    expect(checkValid(project, null).result).toEqual({
      status: "fail",
      detail: "no proposal: The reply proposed no change",
      kind: "no proposal",
    });
    expect(checkValid(project, null, "It asked instead").result.detail).toBe(
      "no proposal: It asked instead",
    );
  });

  // GRV-6's first live run: every proposal that created something failed here,
  // because the model counted out its new IDs by hand and got the length wrong.
  it("fails a new ID one character short as a schema failure", () => {
    const device = { ...createDevice(context("short").ids("device"), "compressor", 0) };
    const command = addDevice(
      { chain: "master" },
      { ...device, id: device.id.slice(0, -1) as typeof device.id },
    );
    const outcome = checkValid(project, proposalOf([command]));
    expect(outcome.result.kind).toBe("schema");
    expect(outcome.result.detail).toMatch(/^schema: invalid_payload .*device\.id/);
  });

  it("fails a call to a tool that does not exist", () => {
    const outcome = checkValid(project, {
      baseRevision: 0,
      calls: [{ name: "audio_generate", input: {} }],
    });
    expect(outcome.result.status).toBe("fail");
    expect(outcome.result.kind).toBe("schema");
    expect(outcome.result.detail).toContain("unknown_tool");
    expect(outcome.applied).toBeNull();
  });

  it("fails a value outside its parameter's range", () => {
    const loud = setParameter(
      { scope: "track", trackId: track("Bass").id, parameterId: "track.volume" },
      12,
    );
    const outcome = checkValid(project, proposalOf([loud]));
    expect(outcome.result.kind).toBe("range");
    expect(outcome.result.detail).toContain("out_of_range");
  });

  it("fails a command the kernel rejects (a clip that does not exist)", () => {
    const ctx = context("missing");
    const stray = addNotes(ctx.ids("clip"), [
      createNoteEvent(ctx, {
        pitch: 60,
        startTicks: 0,
        durationTicks: TICKS_PER_SIXTEENTH,
      }),
    ]);
    const outcome = checkValid(project, proposalOf([stray]));
    expect(outcome.result.status).toBe("fail");
    expect(outcome.result.kind).toBe("executor");
    expect(outcome.result.detail).toContain("rejected");
  });
});

describe("check 2: editable, bundled sources only", () => {
  it("passes new note events on a synth and the factory kit", () => {
    const sketch = applied([synthTrackWithLoop("pad", [57, 60, 64])]);
    expect(checkBundled(sketch.proposal.commands, sketch.after).status).toBe("pass");
  });

  it("fails a command that is not one of the assistant's own", () => {
    const sketch = applied([bassDown]);
    const sneaked: RawCommandInput[] = [
      ...sketch.proposal.commands,
      { type: "asset.add", version: 1, payload: {} },
    ];
    const result = checkBundled(sneaked, sketch.after);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("asset.add");
  });

  it("fails a project that plays a sound from outside the factory library", () => {
    // Built straight through the kernel (asset.add is not an assistant tool),
    // standing in for audio that was generated or uploaded.
    const ctx = context("upload");
    const upload = createAsset(ctx, {
      pack: factoryPack(factoryLibraryEntry("starterKick")),
      name: "Generated texture",
      storageRef: "uploads/generated-texture.wav",
    });
    const history = createCommandHistory(project);
    const result = history.execute([
      addAsset(upload),
      changeInstrument(track("Lead").id, createSamplerInstrument(upload.id)),
    ]);
    if (!result.ok) throw new Error(result.issues[0]?.message);
    const verdict = checkBundled([], history.project);
    expect(verdict.status).toBe("fail");
    expect(verdict.detail).toContain(upload.id);
  });
});

describe("check 3: in scope", () => {
  const scope = (overrides: Partial<EvalScope>) =>
    resolveScope(project, {
      tracks: [],
      createTracks: false,
      song: false,
      master: false,
      returns: false,
      sections: false,
      ...overrides,
    });

  it("passes a change to a track the case names", () => {
    const { after } = applied([bassDown]);
    expect(checkInScope(project, after, scope({ tracks: ["Bass"] })).status).toBe("pass");
  });

  it("fails a change to a track the case does not name", () => {
    const { after } = applied([bassDown]);
    const result = checkInScope(project, after, scope({ tracks: ["Drums"] }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain('changes track "Bass"');
  });

  it("fails a new track when the case allows none, and passes it when it does", () => {
    const { after } = applied([synthTrackWithLoop("scope", [60])]);
    expect(checkInScope(project, after, scope({ tracks: "all" })).detail).toContain(
      "adds tracks (Pad)",
    );
    expect(checkInScope(project, after, scope({ createTracks: true })).status).toBe(
      "pass",
    );
  });

  it("fails a new clip on a track outside the scope", () => {
    const ctx = context("clip");
    const clip = createNoteClip(ctx, { trackId: track("Lead").id, name: "B" });
    const { after } = applied([addClip(clip)]);
    expect(checkInScope(project, after, scope({ tracks: ["Drums"] })).detail).toContain(
      'changes clips on "Lead"',
    );
  });

  it("fails the master and the tempo unless the case allows them", () => {
    const glue = addDevice(
      { chain: "master" },
      createDevice(context("dev").ids("device"), "compressor", 0),
    );
    const tempo = setParameter({ scope: "song", parameterId: "song.tempo" }, 140);
    const { after } = applied([glue, tempo]);
    const result = checkInScope(project, after, scope({}));
    expect(result.detail).toContain("changes the master");
    expect(result.detail).toContain("changes the song's settings");
    expect(checkInScope(project, after, scope({ master: true, song: true })).status).toBe(
      "pass",
    );
  });
});

describe("check 4: atomic undo", () => {
  it("passes: one entry, and one undo restores the song exactly", () => {
    const proposal = proposalOf([bassDown, synthTrackWithLoop("undo", [48, 55])]);
    expect(checkAtomicUndo(project, proposal).status).toBe("pass");
  });

  it("skips a proposal that does not apply", () => {
    expect(checkAtomicUndo(project, { baseRevision: 0, calls: [] }).status).toBe("skip");
  });

  /** A bench over a real history whose execute or undo misbehaves. */
  function brokenBench(
    start: Project,
    breakIt: {
      execute?: (
        history: CommandHistory,
        commands: readonly RawCommandInput[],
        options: TransactionOptions,
      ) => TransactionResult;
      undo?: (history: CommandHistory) => TransactionResult | null;
    },
  ): UndoBench & { strays: number } {
    const history = createCommandHistory(start);
    const target = historyProposalTarget(history);
    const bench = {
      strays: 0,
      entryCount: () => history.entries.length - bench.strays,
      target: {
        get project() {
          return history.project;
        },
        get gestureActive() {
          return history.gestureActive;
        },
        get latestCorrelationId() {
          return target.latestCorrelationId;
        },
        execute: (commands: readonly RawCommandInput[], options: TransactionOptions) =>
          breakIt.execute
            ? breakIt.execute(history, commands, options)
            : target.execute(commands, options),
        undo: () => (breakIt.undo ? breakIt.undo(history) : target.undo()),
      },
    };
    return bench;
  }

  it("fails when applying makes more than one history entry", () => {
    // Each command committed on its own, as a non-atomic apply would.
    const proposal = proposalOf([bassDown, synthTrackWithLoop("split", [60])]);
    const result = checkAtomicUndo(project, proposal, (start) =>
      brokenBench(start, {
        execute(history, commands, options) {
          let result = history.execute([commands[0]], options);
          for (const command of commands.slice(1)) {
            if (!result.ok) break;
            result = history.execute([command], { ...options, baseRevision: undefined });
          }
          return result;
        },
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("2 history entries");
  });

  it("fails when one undo does not restore the song", () => {
    // An undo that leaves a stray edit behind it.
    const result = checkAtomicUndo(project, proposalOf([bassDown]), (start) => {
      const bench = brokenBench(start, {
        undo(history) {
          const undone = history.undo();
          const stray = history.execute([
            setParameter({ scope: "song", parameterId: "song.swing" }, 60),
          ]);
          if (stray.ok) bench.strays += 1;
          return undone;
        },
      });
      return bench;
    });
    expect(result).toEqual({
      status: "fail",
      detail: "One undo did not restore the song exactly",
    });
  });
});

describe("check 5: grounded explanation", () => {
  const { after, proposal } = applied([bassDown]);
  const grounded = (text: string) =>
    checkGrounded(project, after, proposal.impact.controls, text);

  it("passes when every named control is one the proposal changes", () => {
    expect(grounded("I pulled the Bass volume down 6 dB so the kick leads.").status).toBe(
      "pass",
    );
    expect(grounded("Bass's volume comes down a touch.").status).toBe("pass");
  });

  it("passes a reply that names no control", () => {
    expect(grounded("Tucking the low end in behind the kick.")).toEqual({
      status: "pass",
      detail: "Names no control",
    });
  });

  it("fails when it names a control the proposal leaves alone", () => {
    const result = grounded("Bass volume down, and Lead volume up to sit on top.");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("lead volume");
    expect(result.detail).not.toContain("bass volume");
  });

  it("counts the song's tempo only when a value follows it", () => {
    expect(grounded("At this tempo the bass can sit lower.").status).toBe("pass");
    expect(grounded("I'd also take the tempo to 128.").status).toBe("fail");
  });

  it("grounds the controls of a device the proposal adds", () => {
    const compressor = {
      ...createDevice(context("glue").ids("device"), "compressor", 0),
      parameters: { threshold: -20, ratio: 2 },
    };
    const glued = applied([addDevice({ chain: "master" }, compressor)]);
    const text = "A Compressor on the master, Compressor threshold at -20 dB, ratio 2.";
    expect(
      checkGrounded(project, glued.after, glued.proposal.impact.controls, text).status,
    ).toBe("pass");
    // The limiter is on the master already and this proposal leaves it alone.
    const overclaim = `${text} I also eased the Limiter ceiling.`;
    expect(
      checkGrounded(project, glued.after, glued.proposal.impact.controls, overclaim)
        .detail,
    ).toContain("limiter ceiling");
  });
});

describe("check 6: extreme is not flattened", () => {
  it("fails an extreme proposal identical to a conventional one under fresh IDs", () => {
    const a = applied([synthTrackWithLoop("first", [57, 60, 64])]);
    const b = applied([synthTrackWithLoop("second", [57, 60, 64])]);
    const conventional = proposalFingerprint(project, a.proposal.commands);
    const extreme = proposalFingerprint(project, b.proposal.commands);
    expect(extreme).toBe(conventional);
    expect(checkNotFlattened(extreme, [conventional]).status).toBe("fail");
  });

  it("passes an extreme proposal that differs", () => {
    const a = applied([synthTrackWithLoop("first", [57, 60, 64])]);
    const b = applied([synthTrackWithLoop("second", [57, 58, 59, 61])]);
    const result = checkNotFlattened(proposalFingerprint(project, b.proposal.commands), [
      proposalFingerprint(project, a.proposal.commands),
      null,
    ]);
    expect(result).toEqual({
      status: "pass",
      detail: "Differs from all 1 conventional proposals",
    });
  });

  it("keeps existing IDs, so the same edit on another track differs", () => {
    const lead = setParameter(
      { scope: "track", trackId: track("Lead").id, parameterId: "track.volume" },
      -6,
    );
    expect(proposalFingerprint(project, applied([bassDown]).proposal.commands)).not.toBe(
      proposalFingerprint(project, applied([lead]).proposal.commands),
    );
  });

  it("normalises fresh IDs that end in '-' and automation IDs", () => {
    // Raw commands are enough: the fingerprint never applies them.
    const raw = (trackId: string, laneId: string): RawCommandInput[] => [
      { type: "track.rename", payload: { trackId, laneId, name: "Pad" } },
    ];
    const first = proposalFingerprint(
      project,
      raw(`trk_${"a".repeat(20)}-`, `aut_${"b".repeat(20)}_`),
    );
    const second = proposalFingerprint(
      project,
      raw(`trk_${"c".repeat(20)}-`, `aut_${"d".repeat(20)}-`),
    );
    expect(first).toBe(second);
    expect(first).toContain('"trk#1"');
    expect(first).toContain('"aut#2"');
  });

  it("does not match a 21-character slice of a longer run", () => {
    const fingerprint = proposalFingerprint(project, [
      { type: "track.rename", payload: { trackId: `trk_${"a".repeat(22)}` } },
    ]);
    expect(fingerprint).toContain(`trk_${"a".repeat(22)}`);
  });

  it("skips when either side has nothing that applied", () => {
    expect(checkNotFlattened(null, ["x"]).status).toBe("skip");
    expect(checkNotFlattened("x", [null, null]).status).toBe("skip");
  });
});
