/**
 * A proposal that writes notes past its clip's end lengthens the clip
 * (GRV-116). Rewriting the starter kick as "a busy 4-bar groove" wrote four
 * bars of notes into its one-bar clip, and the whole proposal came back as
 * one that could not be applied.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addClip,
  addNotes,
  type CommandHistory,
  createCommandHistory,
  type RawCommandInput,
  removeNotes,
  updateClip,
  updatePlacement,
} from "../commands";
import {
  type CommandTestProject,
  createCommandTestProject,
  createTestFactoryContext,
} from "../commands/testProjects";
import {
  bars,
  createNoteClip,
  createNoteEvent,
  MAX_CLIP_LENGTH_TICKS,
  TICKS_PER_BAR,
  TICKS_PER_SIXTEENTH,
  toTicks,
} from "../domain";
import { historyProposalTarget } from "./historyProposalTarget";
import { validateProposal } from "./proposal";
import { createProposalExecutor } from "./proposalExecutor";
import { toolCallsFor } from "./tools";

const context = createTestFactoryContext("grv116-clip-fit");

let fx: CommandTestProject;
let history: CommandHistory;

beforeEach(() => {
  fx = createCommandTestProject();
  history = createCommandHistory(fx.project);
});

function proposalOf(commands: readonly RawCommandInput[]) {
  return {
    baseRevision: fx.project.metadata.revision,
    calls: commands.flatMap((command) => toolCallsFor(command)),
  };
}

/** A note every sixteenth for `count` bars, from the clip's start. */
function busyNotes(count: number) {
  return Array.from({ length: (count * TICKS_PER_BAR) / TICKS_PER_SIXTEENTH }, (_, at) =>
    createNoteEvent(context, {
      startTicks: at * TICKS_PER_SIXTEENTH,
      durationTicks: TICKS_PER_SIXTEENTH,
      pitch: 36,
    }),
  );
}

function clipLength(clipId: string): number | undefined {
  return history.project.clips.find((clip) => clip.id === clipId)?.lengthTicks;
}

describe("a proposal that writes notes past its clip's end", () => {
  /** The QA's shape: clear the one-bar clip, write four bars, play them. */
  function resketch(): RawCommandInput[] {
    const clip = fx.project.clips.find((candidate) => candidate.id === fx.clipAId);
    const placement = fx.project.song.placements.find(
      (candidate) => candidate.clipId === fx.clipAId,
    );
    if (clip?.content.kind !== "notes" || !placement) throw new Error("fixture");
    return [
      removeNotes(
        fx.clipAId,
        clip.content.events.map((event) => event.id),
      ),
      addNotes(fx.clipAId, busyNotes(4)),
      updatePlacement(placement.id, { durationTicks: bars(4), looped: true }),
    ];
  }

  it("lengthens the clip to hold them, so the proposal applies", () => {
    const validation = validateProposal(fx.project, proposalOf(resketch()));

    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const lengthen = validation.proposal.commands.find(
      (command) => command.type === "clip.update",
    );
    expect(lengthen?.payload).toEqual({
      clipId: fx.clipAId,
      changes: { lengthTicks: 4 * TICKS_PER_BAR },
    });
    expect(validation.proposal.impact.lines.map((line) => line.summary)).toContain(
      `Resize clip "Bassline" to ${4 * TICKS_PER_BAR} ticks`,
    );
  });

  it("applies as one entry that undo takes back, clip length included", () => {
    const executor = createProposalExecutor({
      target: historyProposalTarget(history),
      analytics: { log() {} },
    });
    const proposed = executor.propose(proposalOf(resketch()));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    expect(proposed.handle.apply().ok).toBe(true);
    expect(clipLength(fx.clipAId)).toBe(4 * TICKS_PER_BAR);
    history.undo();
    expect(clipLength(fx.clipAId)).toBe(TICKS_PER_BAR);
    expect(history.project.clips).toEqual(fx.project.clips);
  });

  it("rounds up to the next listed clip length", () => {
    const late = createNoteEvent(context, {
      startTicks: TICKS_PER_BAR + TICKS_PER_SIXTEENTH,
      durationTicks: TICKS_PER_SIXTEENTH,
      pitch: 40,
    });
    const validation = validateProposal(
      fx.project,
      proposalOf([addNotes(fx.clipAId, [late])]),
    );

    expect(validation.ok && validation.proposal.commands.at(-1)?.payload).toEqual({
      clipId: fx.clipAId,
      changes: { lengthTicks: 2 * TICKS_PER_BAR },
    });
  });

  it("lengthens a clip the proposal makes in its own payload", () => {
    const clip = createNoteClip(context, {
      trackId: fx.trackAId,
      name: "Long",
      lengthTicks: TICKS_PER_BAR,
      events: busyNotes(3),
    });
    const validation = validateProposal(fx.project, proposalOf([addClip(clip)]));

    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.proposal.commands).toHaveLength(1);
    expect(validation.proposal.commands[0].payload).toMatchObject({
      clip: { id: clip.id, lengthTicks: 4 * TICKS_PER_BAR },
    });
  });

  it("adds nothing when the proposal already lengthens the clip", () => {
    const commands = [
      updateClip(fx.clipAId, { lengthTicks: toTicks(4 * TICKS_PER_BAR) }),
      ...resketch(),
    ];
    const validation = validateProposal(fx.project, proposalOf(commands));

    expect(validation.ok && validation.proposal.commands.map((c) => c.type)).toEqual(
      commands.map((command) => command.type),
    );
  });

  it("still refuses notes past the longest clip there is", () => {
    const tooLate = createNoteEvent(context, {
      startTicks: MAX_CLIP_LENGTH_TICKS,
      durationTicks: TICKS_PER_SIXTEENTH,
      pitch: 40,
    });
    const validation = validateProposal(
      fx.project,
      proposalOf([addNotes(fx.clipAId, [tooLate])]),
    );

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues[0]).toMatchObject({ code: "invalid_project", callIndex: 0 });
  });
});
