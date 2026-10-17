import { describe, expect, it } from "vitest";
import { ASK_PRODUCER_TOOL_NAME } from "./ask";
import { REMEMBER_TOOL_NAME } from "./memory";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import { ADDED_RESULT, answerStep, continuesAfter, goesOnToReaim } from "./steps";
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
    const { kept, results } = answerStep([change, wrapped, remember], new Map());
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
    const answered = answerStep([good, bad], known);
    expect(answered.kept).toEqual([good]);
    expect(answered.misaimed).toBe(1);
    expect(answered.results[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "Noted.",
    });
    expect(answered.results[1]).toMatchObject({ tool_use_id: "toolu_2", is_error: true });
    expect(goesOnToReaim("tool_use", [good, bad], answered)).toBe(true);
    expect(goesOnToReaim("tool_use", [good], answerStep([good], known))).toBe(false);
  });

  it("knows the track a track_create earlier in the step made", () => {
    const aimed = recommend("toolu_2", { trackId: CREATE_EXAMPLES.track.id });
    const answered = answerStep([change, aimed], known);
    expect(answered.misaimed).toBe(0);
    expect(answered.kept).toEqual([change, aimed]);
    expect(answered.targets.has(CREATE_EXAMPLES.track.id)).toBe(true);
  });

  it("does not go on to re-aim a step that asked a question", () => {
    const bad = recommend("toolu_1", { trackId: "trk_Gone" });
    const ask = other(ASK_PRODUCER_TOOL_NAME);
    expect(goesOnToReaim("tool_use", [bad, ask], answerStep([bad, ask], known))).toBe(
      false,
    );
  });
});
