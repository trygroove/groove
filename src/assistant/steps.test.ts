import { describe, expect, it } from "vitest";
import { ASK_PRODUCER_TOOL_NAME } from "./ask";
import { createNoteExpander } from "./compactNotes";
import { REMEMBER_TOOL_NAME } from "./memory";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import {
  ADDED_RESULT,
  addedResult,
  answerStep,
  CHANGE_STEPS_SPENT,
  continuesAfter,
  expandCalls,
  goesOnToReaim,
  goesOnToRefuse,
  isProposalPart,
  MAX_CHANGE_STEPS,
  misaimedIn,
  refusedIn,
} from "./steps";
import {
  CREATE_EXAMPLES,
  EXPLAIN_TOOL_NAME,
  NEED_MORE_TOOLS_NAME,
  OFFERED_CLIP_EXAMPLE,
} from "./tools";

const STEM = "BassNote000000000";

const change = { id: "toolu_1", name: "track_create", input: CREATE_EXAMPLES.track };
const other = (name: string, id = "toolu_2") => ({ id, name, input: {} });

describe("continuesAfter", () => {
  it("goes on after change calls that neither explain nor ask", () => {
    expect(continuesAfter("tool_use", [change])).toBe(true);
  });

  it("stops at an explanation, a question, a reply with no tool, or no change", () => {
    expect(continuesAfter("tool_use", [change, other(EXPLAIN_TOOL_NAME)])).toBe(false);
    expect(continuesAfter("tool_use", [change, other(ASK_PRODUCER_TOOL_NAME)])).toBe(
      false,
    );
    expect(continuesAfter("end_turn", [])).toBe(false);
    expect(continuesAfter("tool_use", [other(RECOMMEND_SOUNDS_TOOL)])).toBe(false);
    expect(continuesAfter("tool_use", [other(REMEMBER_TOOL_NAME)])).toBe(false);
  });
});

describe("isProposalPart (GRV-144)", () => {
  it("is a change call that fits its tool, with no refusal", () => {
    expect(isProposalPart(change)).toBe(true);
    expect(isProposalPart({ ...change, refusal: "Not a note" })).toBe(false);
    expect(isProposalPart({ ...change, input: { name: 3 } })).toBe(false);
  });

  it("is never a call that changes nothing", () => {
    for (const name of [
      EXPLAIN_TOOL_NAME,
      ASK_PRODUCER_TOOL_NAME,
      RECOMMEND_SOUNDS_TOOL,
      REMEMBER_TOOL_NAME,
      NEED_MORE_TOOLS_NAME,
    ]) {
      expect(isProposalPart(other(name))).toBe(false);
    }
  });
});

describe("answerStep", () => {
  it("adds a call that fits its tool, refuses one that does not, and notes the rest", () => {
    const wrapped = {
      id: "toolu_3",
      name: "track_create",
      input: { track: change.input },
    };
    const remember = other(REMEMBER_TOOL_NAME, "toolu_4");
    const { kept, results } = answerStep(
      [change, wrapped, remember],
      new Map(),
      createNoteExpander(STEM),
    );
    expect(kept).toEqual([change, remember]);
    expect(results).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: ADDED_RESULT },
      expect.objectContaining({ tool_use_id: "toolu_3", is_error: true }),
      { type: "tool_result", tool_use_id: "toolu_4", content: "Noted." },
    ]);
    expect(results[1]?.content).toMatch(
      /^Refused, not added to the proposal: .*Send this call again, corrected\.$/,
    );
  });
});

describe("compact notes (GRV-131)", () => {
  const compactClip = { id: "toolu_5", name: "clip_create", input: OFFERED_CLIP_EXAMPLE };

  it("adds a clip whose notes are arrays, written out as the note events they stand for", () => {
    const { kept, results } = answerStep(
      [compactClip],
      new Map(),
      createNoteExpander(STEM),
    );
    expect(results[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_5",
      content: `${ADDED_RESULT} Its note's ID is evt_BassNote000000000n001.`,
    });
    // The stem the example's own note ID is made from, so it expands to it.
    expect(kept).toEqual([{ ...compactClip, input: CREATE_EXAMPLES.clip }]);
  });

  it("tells the model its new notes' IDs, and numbers only the calls it adds", () => {
    const refused = {
      id: "toolu_8",
      name: "note_add",
      input: { clipId: "not-a-clip", notes: [[0, 36, 192, 0.8]] },
    };
    const added = {
      id: "toolu_9",
      name: "note_add",
      input: {
        clipId: CREATE_EXAMPLES.clip.id,
        notes: [
          [0, 36, 192, 0.8],
          [192, 38, 192, 0.8],
          [384, 40, 192, 0.8],
        ],
      },
    };
    const { results } = answerStep([refused, added], new Map(), createNoteExpander(STEM));
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[1]?.content).toBe(
      `${ADDED_RESULT} Its 3 notes' IDs, in the order you gave them, count up from evt_BassNote000000000n001 to evt_BassNote000000000n003.`,
    );
    expect(addedResult([])).toBe(ADDED_RESULT);
  });

  it("refuses a note that is not one, saying where and what a note is", () => {
    const bad = {
      id: "toolu_6",
      name: "note_add",
      input: {
        clipId: CREATE_EXAMPLES.clip.id,
        notes: [
          [0, 36, 192, 0.8],
          [0, 200, 1, 1],
        ],
      },
    };
    const { kept, results } = answerStep([bad], new Map(), createNoteExpander(STEM));
    expect(kept).toEqual([]);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0]?.content).toContain("notes.1.1:");
    expect(results[0]?.content).toContain(
      "[startTicks, pitch or padId, durationTicks, velocity]",
    );
  });

  it("writes out the last step's calls too, and hands on one it cannot as it came, with why", () => {
    const bad = {
      ...compactClip,
      id: "toolu_7",
      input: { ...OFFERED_CLIP_EXAMPLE, content: { kind: "notes", events: [[-1]] } },
    };
    const notes = createNoteExpander(STEM);
    expect(expandCalls([compactClip, bad, other(EXPLAIN_TOOL_NAME)], notes)).toEqual([
      { ...compactClip, input: CREATE_EXAMPLES.clip },
      {
        ...bad,
        refusal: expect.stringMatching(
          /^content\.events\.0\.0: .*a note is \[startTicks/,
        ),
      },
      other(EXPLAIN_TOOL_NAME),
    ]);
  });
});

describe("answerStep: where a recommendation is aimed (GRV-129)", () => {
  const recommend = (id: string, target: { trackId?: string; padId?: string }) => ({
    id,
    name: RECOMMEND_SOUNDS_TOOL,
    input: { packId: "pak_x", soundIds: ["a"], reason: "Fits.", ...target },
  });
  const known = new Map([
    ["trk_Kit00000000000000000001", new Set(["pad_Kick0000000000000000001"])],
  ]);

  it("notes one aimed at a track and pad the project has, and refuses one aimed at neither", () => {
    const good = recommend("toolu_1", {
      trackId: "trk_Kit00000000000000000001",
      padId: "pad_Kick0000000000000000001",
    });
    const bad = recommend("toolu_2", { trackId: "trk_Gone" });
    const answered = answerStep([good, bad], known, createNoteExpander(STEM));
    expect(answered.kept).toEqual([good]);
    expect(answered.misaimed).toBe(1);
    expect(answered.results[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "Noted.",
    });
    expect(answered.results[1]).toMatchObject({ tool_use_id: "toolu_2", is_error: true });
    expect(goesOnToReaim("tool_use", [good, bad], answered)).toBe(true);
    expect(misaimedIn([good, bad], known)).toBe(1);
    expect(
      goesOnToReaim(
        "tool_use",
        [good],
        answerStep([good], known, createNoteExpander(STEM)),
      ),
    ).toBe(false);
  });

  it("knows the track a track_create earlier in the step made", () => {
    const aimed = recommend("toolu_2", { trackId: CREATE_EXAMPLES.track.id });
    const answered = answerStep([change, aimed], known, createNoteExpander(STEM));
    expect(answered.misaimed).toBe(0);
    expect(answered.kept).toEqual([change, aimed]);
    expect(answered.targets.has(CREATE_EXAMPLES.track.id)).toBe(true);
    expect(misaimedIn([change, aimed], known)).toBe(0);
  });

  it("does not go on to re-aim a step that asked a question", () => {
    const bad = recommend("toolu_1", { trackId: "trk_Gone" });
    const ask = other(ASK_PRODUCER_TOOL_NAME);
    expect(
      goesOnToReaim(
        "tool_use",
        [bad, ask],
        answerStep([bad, ask], known, createNoteExpander(STEM)),
      ),
    ).toBe(false);
  });
});

describe("a proposal in one response (GRV-142)", () => {
  const wrapped = { id: "toolu_3", name: "track_create", input: { track: change.input } };
  const notesAt = (notes: unknown[]) => ({
    id: "toolu_4",
    name: "note_add",
    input: { clipId: OFFERED_CLIP_EXAMPLE.id, notes },
  });

  it("counts the change calls an answer would refuse, numbering no notes", () => {
    const notes = createNoteExpander(STEM);
    expect(refusedIn([change, other(EXPLAIN_TOOL_NAME)], notes)).toBe(0);
    expect(refusedIn([change, wrapped, notesAt([[0, "not a note"]])], notes)).toBe(2);
    expect(refusedIn([notesAt([[0, 40, 96, 0.8]])], notes)).toBe(0);
    // The turn's own counter is untouched: its first note still gets n001.
    const answered = answerStep([notesAt([[0, 40, 96, 0.8]])], new Map(), notes);
    expect(answered.results[0]?.content).toContain(`evt_${STEM}n001`);
  });

  it("refuses every change call once the turn's steps of changes are spent, and notes the rest", () => {
    const notes = createNoteExpander(STEM);
    const explain = other(EXPLAIN_TOOL_NAME, "toolu_5");
    const answered = answerStep(
      [change, notesAt([[0, 40, 96, 0.8]]), explain],
      new Map(),
      notes,
      {
        refuseChanges: CHANGE_STEPS_SPENT,
      },
    );
    expect(answered.kept).toEqual([explain]);
    expect(answered.results).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: CHANGE_STEPS_SPENT,
        is_error: true,
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_4",
        content: CHANGE_STEPS_SPENT,
        is_error: true,
      },
      { type: "tool_result", tool_use_id: "toolu_5", content: "Noted." },
    ]);
    expect(CHANGE_STEPS_SPENT).toContain(`at most ${MAX_CHANGE_STEPS} responses`);
    // No note was numbered for the refused call.
    const next = answerStep([notesAt([[0, 40, 96, 0.8]])], new Map(), notes);
    expect(next.results[0]?.content).toContain(`evt_${STEM}n001`);
  });

  it("goes on after a step it would have ended on, only when something was refused and nothing asked", () => {
    expect(goesOnToRefuse("tool_use", [change], 1)).toBe(true);
    expect(goesOnToRefuse("tool_use", [change], 0)).toBe(false);
    expect(goesOnToRefuse("tool_use", [change, other(ASK_PRODUCER_TOOL_NAME)], 1)).toBe(
      false,
    );
    expect(goesOnToRefuse("end_turn", [], 1)).toBe(false);
  });
});
