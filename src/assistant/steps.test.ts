import { describe, expect, it } from "vitest";
import { ASK_PRODUCER_TOOL_NAME } from "./ask";
import { REMEMBER_TOOL_NAME } from "./memory";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import { ADDED_RESULT, answerStep, continuesAfter } from "./steps";
import { CREATE_EXAMPLES, EXPLAIN_TOOL_NAME } from "./tools";

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
    const { kept, results } = answerStep([change, wrapped, remember]);
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
