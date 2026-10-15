import { describe, expect, it } from "vitest";
import { PROPOSAL_ISSUE_CODES } from "../../assistant/proposalIssues";
import { type RejectionIssue, rejectionReason } from "./rejectionReason";

function issue(overrides: Partial<RejectionIssue> & Pick<RejectionIssue, "code">) {
  return { callName: null, path: null, message: null, ...overrides };
}

describe("rejectionReason (GRV-98)", () => {
  it("names a missing sound, whether the kernel or the payload schema found it", () => {
    const sound = "The assistant tried to use a sound that isn't in your library.";
    expect(
      rejectionReason([
        issue({
          code: "invalid_project",
          callName: "track_create",
          path: "song.tracks.1.instrument.assetId",
          message: "Track trk_1 references missing asset ast_x",
        }),
      ]),
    ).toBe(sound);
    expect(
      rejectionReason([
        issue({
          code: "invalid_payload",
          callName: "track_create",
          message: 'track.instrument.assetId: Expected a "ast_" prefixed id',
        }),
      ]),
    ).toBe(sound);
    expect(
      rejectionReason([issue({ code: "rejected", callName: "drum_setPadAsset" })]),
    ).toBe(sound);
  });

  it("names the change from the failing call's tool", () => {
    expect(
      rejectionReason([issue({ code: "out_of_range", callName: "parameter_set" })]),
    ).toBe("The assistant tried to push a setting past its range.");
    expect(rejectionReason([issue({ code: "rejected", callName: "note_add" })])).toBe(
      "The assistant tried to add a note that doesn't fit your song.",
    );
    expect(
      rejectionReason([issue({ code: "rejected", callName: "device_remove" })]),
    ).toBe("The assistant tried to change an effect that isn't in your song.");
    expect(
      rejectionReason([issue({ code: "invalid_project", callName: "placement_move" })]),
    ).toBe(
      "The assistant's change to a clip on the timeline doesn't fit with the rest of your song.",
    );
    expect(
      rejectionReason([issue({ code: "invalid_payload", callName: "send_add" })]),
    ).toBe("The assistant described a send in a way Groove couldn't read.");
  });

  it("reads the first issue that is not about the song moving on", () => {
    expect(
      rejectionReason([
        issue({ code: "stale_revision" }),
        issue({ code: "unknown_tool", callName: "project_delete" }),
        issue({ code: "out_of_range", callName: "parameter_set" }),
      ]),
    ).toBe("The assistant tried a kind of change Groove can't make.");
  });

  it("has nothing to add for no issues or only a stale one", () => {
    expect(rejectionReason([])).toBeNull();
    expect(rejectionReason([issue({ code: "stale_revision" })])).toBeNull();
  });

  it("says something for every other code, never the kernel's message", () => {
    for (const code of PROPOSAL_ISSUE_CODES) {
      if (code === "stale_revision") continue;
      const reason = rejectionReason([
        issue({ code, callName: "track_update", message: "Track trk_Secret is gone" }),
      ]);
      expect(reason, code).toMatch(/^The assistant/);
      expect(reason).not.toMatch(/trk_|Secret/);
    }
  });
});
