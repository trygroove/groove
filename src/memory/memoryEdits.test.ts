import { describe, expect, it } from "vitest";
import {
  emptyProfile,
  MAX_MEMORY_NOTES,
  type ProducerProfile,
} from "../persistence/profileDocuments";
import {
  applyProposal,
  describeProposal,
  markAsked,
  memoryContext,
  undoProposal,
} from "./memoryEdits";

const PROFILE: ProducerProfile = {
  ...emptyProfile(1),
  onboarding: "completed",
  memory: { ...emptyProfile(1).memory, gear: ["Ableton Move"] },
  laterQuestions: ["goal", "gear"],
};

describe("memory edits (GRV-25)", () => {
  it("carries memory, notes and the first question to ask later", () => {
    const context = memoryContext({
      ...PROFILE,
      notes: [{ id: "n1", text: "Trap lately", createdAt: 5 }],
    });
    expect(context).toMatchObject({
      gear: ["Ableton Move"],
      notes: [{ id: "n1", text: "Trap lately" }],
      askLater: "goal",
    });
  });

  it("adds a note and takes exactly that note back out on undo", () => {
    const { profile, undo } = applyProposal(
      PROFILE,
      { kind: "note", text: "Trap lately" },
      { id: "n1", createdAt: 9 },
    );
    expect(profile.notes).toEqual([{ id: "n1", text: "Trap lately", createdAt: 9 }]);
    expect(undoProposal(profile, undo).notes).toEqual([]);
  });

  it("keeps notes to the cap, and an undo brings the oldest back", () => {
    const full = {
      ...PROFILE,
      notes: Array.from({ length: MAX_MEMORY_NOTES }, (_, index) => ({
        id: `n${index}`,
        text: `Note ${index}`,
        createdAt: index,
      })),
    };
    const { profile, undo } = applyProposal(
      full,
      { kind: "note", text: "Newest" },
      { id: "new", createdAt: 99 },
    );
    expect(profile.notes).toHaveLength(MAX_MEMORY_NOTES);
    expect(profile.notes[0]?.id).toBe("n1");
    expect(undoProposal(profile, undo).notes).toEqual(full.notes);
  });

  it("sets a field, answers its question for good, and undoes to the old value", () => {
    const { profile, undo } = applyProposal(
      PROFILE,
      { kind: "field", field: "gear", value: ["OP-1"] },
      { id: "unused", createdAt: 1 },
    );
    expect(profile.memory.gear).toEqual(["OP-1"]);
    expect(profile.laterQuestions).toEqual(["goal"]);
    expect(undoProposal(profile, undo).memory.gear).toEqual(["Ableton Move"]);
  });

  it("asks a question later only once", () => {
    expect(markAsked(PROFILE, "goal").laterQuestions).toEqual(["gear"]);
  });

  it("says what a proposal would remember", () => {
    expect(describeProposal({ kind: "note", text: "Trap lately" })).toBe('"Trap lately"');
    expect(
      describeProposal({ kind: "field", field: "experience", value: "releases" }),
    ).toBe("Experience: I release music");
  });
});
