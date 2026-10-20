import { describe, expect, it } from "vitest";
import { COMMAND_TYPES } from "../commands/registry";
import { editsLeaveProposalValid, PROPOSAL_COMMAND_IMPACT } from "./proposalStaleness";

describe("proposal staleness audit (GRV-132)", () => {
  it("decides every registered command, and nothing that is not registered", () => {
    expect(Object.keys(PROPOSAL_COMMAND_IMPACT).sort()).toEqual(
      [...COMMAND_TYPES].sort(),
    );
  });

  it("lets edits to state a proposal is not built on through", () => {
    expect(
      editsLeaveProposalValid(["loop.setEnabled", "loop.setRange"], ["track.setFlag"]),
    ).toBe(true);
    expect(editsLeaveProposalValid(["project.rename"], ["notes.transpose"])).toBe(true);
    expect(editsLeaveProposalValid([], ["notes.transpose"])).toBe(true);
  });

  it("is stale after any edit a proposal could be built on", () => {
    expect(
      editsLeaveProposalValid(["loop.setEnabled", "note.add"], ["track.setFlag"]),
    ).toBe(false);
    expect(editsLeaveProposalValid(["key.set"], ["notes.quantizeToScale"])).toBe(false);
  });

  it("is stale after an edit to the state the proposal itself changes", () => {
    expect(editsLeaveProposalValid(["loop.setEnabled"], ["loop.setRange"])).toBe(false);
    expect(editsLeaveProposalValid(["project.rename"], ["project.rename"])).toBe(false);
  });

  it("is stale when the edits since are not all known", () => {
    expect(editsLeaveProposalValid(null, ["track.setFlag"])).toBe(false);
  });
});
