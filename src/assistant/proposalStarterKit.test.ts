import { beforeEach, describe, expect, it } from "vitest";
import {
  addAsset,
  type CommandHistory,
  createCommandHistory,
  executeTransaction,
} from "../commands";
import {
  type CommandTestProject,
  createCommandTestProject,
  createTestFactoryContext,
} from "../commands/testProjects";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createNoteEvent,
  createSamplerInstrument,
  createTrack,
  type DrumPad,
  type Project,
  TICKS_PER_BAR,
  TICKS_PER_SIXTEENTH,
  type TrackId,
} from "../domain";
import { createFactoryAsset, factoryLibraryEntry } from "../library/factoryLibrary";
import { historyProposalTarget } from "./historyProposalTarget";
import { validateProposal } from "./proposal";
import { createProposalExecutor, type ProposalExecutor } from "./proposalExecutor";

/**
 * A drum machine the assistant makes arrives with the starter kit (GRV-192),
 * as one made from the UI does: before this, its pads came with no sound and
 * the beat it wrote played nothing.
 */

const KIT_SOUNDS = ["starterKick", "starterSnare", "starterHat", "starterClap"];
const KIT_REFS = KIT_SOUNDS.map((sound) => factoryLibraryEntry(sound).storageRef);

let fx: CommandTestProject;
let history: CommandHistory;
let executor: ProposalExecutor;

beforeEach(() => {
  fx = createCommandTestProject();
  history = createCommandHistory(fx.project);
  executor = createProposalExecutor({
    target: historyProposalTarget(history),
    analytics: { log() {} },
  });
});

/** What a model sends for "a drum machine with a basic beat": three pads, no sounds. */
function beatProposal(project: Project, names = ["Kick", "Snare", "Closed Hat"]) {
  const context = createTestFactoryContext("grv192");
  const pads = names.map((name) => createDrumPad(context, { name }));
  const track = createTrack(context, {
    name: "Beat",
    order: project.song.tracks.length,
    instrument: createDrumMachineInstrument(pads),
  });
  const clipId = context.ids("clip");
  const events = pads.map((pad, index) =>
    createNoteEvent(context, {
      startTicks: index * 4 * TICKS_PER_SIXTEENTH,
      durationTicks: TICKS_PER_SIXTEENTH,
      padId: pad.id,
      velocity: 0.8,
    }),
  );
  return {
    trackId: track.id,
    pads,
    input: {
      baseRevision: project.metadata.revision,
      calls: [
        { name: "track_create", input: track },
        {
          name: "clip_create",
          input: {
            id: clipId,
            trackId: track.id,
            name: "Beat",
            color: track.color,
            lengthTicks: TICKS_PER_BAR,
            content: { kind: "notes", events },
          },
        },
      ],
    },
  };
}

function padsOf(project: Project, trackId: TrackId): readonly DrumPad[] {
  const track = project.song.tracks.find((candidate) => candidate.id === trackId);
  return track?.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
}

function storageRefOf(project: Project, assetId: string | null): string | undefined {
  return project.song.assets.find((asset) => asset.id === assetId)?.storageRef;
}

function apply(input: unknown): void {
  const proposed = executor.propose(input);
  if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));
  expect(proposed.handle.apply().ok).toBe(true);
}

describe("an assistant-proposed drum machine track (GRV-192)", () => {
  it("has every pad bound to a factory asset the project carries", () => {
    const { trackId, input } = beatProposal(fx.project);
    apply(input);
    const project = history.project;
    const pads = padsOf(project, trackId);
    expect(pads.length).toBeGreaterThan(0);
    for (const pad of pads) {
      expect(KIT_REFS).toContain(storageRefOf(project, pad.assetId));
    }
    expect(project.song.assets.map((asset) => asset.storageRef)).toEqual(
      expect.arrayContaining(KIT_REFS),
    );
  });

  it("lands its notes on the kit's kick, snare and hat", () => {
    const { trackId, pads, input } = beatProposal(fx.project);
    apply(input);
    const project = history.project;
    const after = new Map(padsOf(project, trackId).map((pad) => [pad.id, pad]));
    const [kick, snare, hat] = pads.map((pad) =>
      storageRefOf(project, after.get(pad.id)?.assetId ?? null),
    );
    expect([kick, snare, hat]).toEqual(KIT_REFS.slice(0, 3));
    const clip = project.clips.find((candidate) => candidate.trackId === trackId);
    if (clip?.content.kind !== "notes") throw new Error("no beat clip");
    for (const event of clip.content.events) {
      if (event.trigger.kind !== "pad") throw new Error("not a pad hit");
      expect(after.get(event.trigger.padId)?.assetId).not.toBeNull();
    }
  });

  it("starts with the whole kit, kit order first, as the UI's does", () => {
    const { trackId, pads, input } = beatProposal(fx.project, ["Snare", "Hat"]);
    apply(input);
    const after = padsOf(history.project, trackId);
    expect(after.map((pad) => pad.name)).toEqual(["BD", "Snare", "Hat", "CP"]);
    expect(after[1].id).toBe(pads[0].id);
    expect(after[2].id).toBe(pads[1].id);
  });

  it("gives a pad the kit does not open with the sound its name says", () => {
    const names = ["Kick", "Clap", "Rim", "Open Hat", "Tom", "Crash", "Conga"];
    const { trackId, pads, input } = beatProposal(fx.project, names);
    apply(input);
    const project = history.project;
    const after = new Map(padsOf(project, trackId).map((pad) => [pad.id, pad]));
    const sounds = pads.map((pad) =>
      storageRefOf(project, after.get(pad.id)?.assetId ?? null),
    );
    expect(sounds).toEqual(
      [
        "starterKick",
        "starterClap",
        "starterRim",
        "starterOpenHat",
        "starterTom",
        "starterCymbal",
        "starterPercussion",
      ].map((sound) => factoryLibraryEntry(sound).storageRef),
    );
    // An open hat is not the kit's closed hat, so the kit's HH is still added.
    expect(padsOf(project, trackId).map((pad) => pad.name)).toContain("HH");
  });

  it("leaves a pad whose name says no voice without a sound, never another's", () => {
    const { trackId, pads, input } = beatProposal(fx.project, ["Kick", "Zap"]);
    apply(input);
    const zap = padsOf(history.project, trackId).find((pad) => pad.id === pads[1].id);
    expect(zap?.assetId).toBeNull();
  });

  it("keeps a sound the proposal names for a pad", () => {
    const { trackId, pads, input } = beatProposal(fx.project);
    const track = input.calls[0].input as { instrument: { pads: DrumPad[] } };
    track.instrument.pads[0] = { ...track.instrument.pads[0], assetId: fx.assetIds.pad };
    apply(input);
    const after = padsOf(history.project, trackId);
    expect(after.find((pad) => pad.id === pads[0].id)?.assetId).toBe(fx.assetIds.pad);
    expect(after.filter((pad) => pad.name === "BD")).toHaveLength(0);
  });

  it("reuses kit sounds the project already holds", () => {
    const context = createTestFactoryContext("held");
    const held = createFactoryAsset(context, "starterKick");
    const seeded = executeTransaction(fx.project, [addAsset(held)]);
    if (!seeded.ok) throw new Error("could not seed the kick");
    history = createCommandHistory(seeded.project);
    executor = createProposalExecutor({
      target: historyProposalTarget(history),
      analytics: { log() {} },
    });
    const { trackId, pads, input } = beatProposal(seeded.project);
    apply(input);
    const project = history.project;
    const kickRef = factoryLibraryEntry("starterKick").storageRef;
    expect(project.song.assets.filter((asset) => asset.storageRef === kickRef)).toEqual([
      held,
    ]);
    expect(padsOf(project, trackId).find((pad) => pad.id === pads[0].id)?.assetId).toBe(
      held.id,
    );
  });

  it("adds the kit in the proposal's one transaction, and undoes it whole", () => {
    const before = fx.project.song.assets;
    const { input } = beatProposal(fx.project);
    const proposed = executor.propose(input);
    if (!proposed.ok) throw new Error("refused");
    expect(proposed.handle.apply().ok).toBe(true);
    expect(history.entries).toHaveLength(1);
    expect(proposed.handle.undo().ok).toBe(true);
    expect(history.project.song.assets).toEqual(before);
  });

  it("validates to the same commands every time, so the preview is what Apply gives", () => {
    const { input } = beatProposal(fx.project);
    const first = validateProposal(fx.project, input);
    const second = validateProposal(fx.project, input);
    if (!first.ok || !second.ok) throw new Error("refused");
    expect(second.proposal.commands).toEqual(first.proposal.commands);
  });

  it("loads the kit when an instrument change makes a track a drum machine", () => {
    const context = createTestFactoryContext("change");
    const pads = ["Kick", "Snare"].map((name) => createDrumPad(context, { name }));
    apply({
      baseRevision: fx.project.metadata.revision,
      calls: [
        {
          name: "instrument_change",
          input: { trackId: fx.trackAId, instrument: createDrumMachineInstrument(pads) },
        },
      ],
    });
    const project = history.project;
    const after = padsOf(project, fx.trackAId);
    expect(after.map((pad) => pad.name)).toEqual(["Kick", "Snare", "HH", "CP"]);
    for (const pad of after) {
      expect(KIT_REFS).toContain(storageRefOf(project, pad.assetId));
    }
  });

  it("leaves a sampler a proposal installs alone", () => {
    const proposal = validateProposal(fx.project, {
      baseRevision: fx.project.metadata.revision,
      calls: [
        {
          name: "instrument_change",
          input: { trackId: fx.trackAId, instrument: createSamplerInstrument(null) },
        },
      ],
    });
    if (!proposal.ok) throw new Error("refused");
    expect(proposal.proposal.commands.map((command) => command.type)).toEqual([
      "instrument.change",
    ]);
  });
});
