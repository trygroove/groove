import { describe, expect, it } from "vitest";
import { ASK_PRODUCER_TOOL_NAME } from "./ask";
import { createNoteExpander } from "./compactNotes";
import { REMEMBER_TOOL_NAME } from "./memory";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import { ADDED_RESULT, answerStep, continuesAfter, expandCalls } from "./steps";
import { CREATE_EXAMPLES, EXPLAIN_TOOL_NAME, OFFERED_CLIP_EXAMPLE } from "./tools";

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
    const { kept, results } = answerStep([compactClip], createNoteExpander(STEM));
    expect(results[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_5",
      content: ADDED_RESULT,
    });
    // The stem the example's own note ID is made from, so it expands to it.
    expect(kept).toEqual([{ ...compactClip, input: CREATE_EXAMPLES.clip }]);
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
    const { kept, results } = answerStep([bad], createNoteExpander(STEM));
    expect(kept).toEqual([]);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0]?.content).toContain("notes.1.1:");
    expect(results[0]?.content).toContain(
      "[startTicks, pitch or padId, durationTicks, velocity]",
    );
  });

  it("writes out the last step's calls too, and hands on one it cannot as it came", () => {
    const bad = {
      ...compactClip,
      id: "toolu_7",
      input: { ...OFFERED_CLIP_EXAMPLE, content: { kind: "notes", events: [[-1]] } },
    };
    const notes = createNoteExpander(STEM);
    expect(expandCalls([compactClip, bad, other(EXPLAIN_TOOL_NAME)], notes)).toEqual([
      { ...compactClip, input: CREATE_EXAMPLES.clip },
      bad,
      other(EXPLAIN_TOOL_NAME),
    ]);
  });
});
