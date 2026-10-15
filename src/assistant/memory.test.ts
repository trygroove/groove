import { describe, expect, it } from "vitest";
import { parseAskCall } from "./ask";
import {
  assistantMemoryContextSchema,
  isRememberCall,
  parseRememberCall,
  REMEMBER_TOOL_NAME,
  rememberTool,
  splitMemoryProposals,
} from "./memory";
import { EXPLAIN_TOOL_NAME } from "./tools";

const call = (input: unknown) => ({ id: "toolu_1", name: REMEMBER_TOOL_NAME, input });

describe("remember_producer (GRV-25)", () => {
  it("is offered as an object, as the API requires", () => {
    expect(rememberTool().inputSchema.type).toBe("object");
    expect(rememberTool().name).toBe(REMEMBER_TOOL_NAME);
  });

  it("reads a note", () => {
    expect(parseRememberCall(call({ kind: "note", text: " Making more trap " }))).toEqual(
      {
        kind: "note",
        text: "Making more trap",
      },
    );
  });

  it("reads a field, as a list where the field is one", () => {
    expect(
      parseRememberCall(
        call({ kind: "field", field: "gear", value: "OP-1, Move, op-1" }),
      ),
    ).toEqual({ kind: "field", field: "gear", value: ["OP-1", "Move"] });
    expect(
      parseRememberCall(call({ kind: "field", field: "goal", value: "sound_design" })),
    ).toEqual({ kind: "field", field: "goal", value: "sound_design" });
  });

  it("refuses what it cannot save", () => {
    expect(parseRememberCall(call({ kind: "note" }))).toBeNull();
    expect(
      parseRememberCall(call({ kind: "field", field: "goal", value: "fame" })),
    ).toBeNull();
    expect(
      parseRememberCall(call({ kind: "field", field: "mood", value: "happy" })),
    ).toBeNull();
    expect(parseRememberCall(call({ kind: "note", text: "x".repeat(281) }))).toBeNull();
  });

  it("takes memory proposals out of a proposal, leaving its changes", () => {
    const change = { id: "toolu_2", name: "parameter_set", input: {} };
    const split = splitMemoryProposals({
      baseRevision: 1,
      toolsetVersion: 7,
      calls: [call({ kind: "note", text: "x" }), change],
    });
    expect(split.memory.map((entry) => entry.id)).toEqual(["toolu_1"]);
    expect(split.proposal?.calls).toEqual([change]);
    expect(isRememberCall(change)).toBe(false);
    expect(
      splitMemoryProposals({ baseRevision: 1, toolsetVersion: 7, calls: [call({})] })
        .proposal,
    ).toBeNull();
  });

  it("leaves no proposal when all that is left is an explanation", () => {
    const explain = { id: "toolu_2", name: EXPLAIN_TOOL_NAME, input: {} };
    const change = { id: "toolu_3", name: "parameter_set", input: {} };
    const memoryOnly = splitMemoryProposals({
      baseRevision: 1,
      toolsetVersion: 7,
      calls: [call({ kind: "note", text: "x" }), explain],
    });
    expect(memoryOnly.memory.map((entry) => entry.id)).toEqual(["toolu_1"]);
    expect(memoryOnly.proposal).toBeNull();
    expect(
      splitMemoryProposals({
        baseRevision: 1,
        toolsetVersion: 7,
        calls: [call({ kind: "note", text: "x" }), explain, change],
      }).proposal?.calls,
    ).toEqual([explain, change]);
  });

  it("carries memory under a strict schema", () => {
    const memory = {
      taste: [],
      artists: "",
      experience: null,
      goal: null,
      learn: [],
      gear: [],
      notes: [],
      askLater: "gear",
    };
    expect(assistantMemoryContextSchema.safeParse(memory).success).toBe(true);
    expect(
      assistantMemoryContextSchema.safeParse({ ...memory, projectId: "prj_x" }).success,
    ).toBe(false);
  });

  it("lets ask_producer say it is asking a question skipped in onboarding", () => {
    const ask = parseAskCall({
      id: "toolu_3",
      name: "ask_producer",
      input: {
        question: "What's your goal?",
        options: [{ label: "A track" }, { label: "Curious" }],
        memoryQuestion: "goal",
      },
    });
    expect(ask?.memoryQuestion).toBe("goal");
    const unknown = parseAskCall({
      id: "toolu_4",
      name: "ask_producer",
      input: {
        question: "Q?",
        options: [{ label: "A" }, { label: "B" }],
        memoryQuestion: "favourite_colour",
      },
    });
    expect(unknown).not.toBeNull();
    expect(unknown?.memoryQuestion).toBeUndefined();
  });
});
