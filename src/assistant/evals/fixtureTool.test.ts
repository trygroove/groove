import { describe, expect, it } from "vitest";
import { EvalUsageError } from "./cli";
import {
  defaultFixtureName,
  describeTurn,
  formatScrubReport,
  parseFixtureArgs,
} from "./fixtureTool";

describe("parseFixtureArgs", () => {
  it("reads a project, a name and the drop flag", () => {
    expect(
      parseFixtureArgs(["prj_abc", "--name", "big-arrangement", "--drop-unresolvable"]),
    ).toEqual({
      projectId: "prj_abc",
      turnId: null,
      name: "big-arrangement",
      dropUnresolvable: true,
    });
  });

  it("reads a turn instead of a project", () => {
    expect(parseFixtureArgs(["--turn", "turn_123456"])).toMatchObject({
      projectId: null,
      turnId: "turn_123456",
    });
  });

  it.each([
    [[]],
    [["prj_abc", "--turn", "turn_123456"]],
    [["prj_abc", "prj_def"]],
    [["prj_abc", "--name"]],
    [["prj_abc", "--name", "Not A Name"]],
    [["prj_abc", "--name", "house-loop"]],
    [["prj_abc", "--force"]],
  ])("refuses %j", (argv) => {
    expect(() => parseFixtureArgs(argv)).toThrow(EvalUsageError);
  });
});

describe("defaultFixtureName", () => {
  it("is the first free scrubbed-N", () => {
    expect(defaultFixtureName(["house-loop"])).toBe("scrubbed-1");
    expect(defaultFixtureName(["scrubbed-1", "scrubbed-3"])).toBe("scrubbed-2");
  });
});

describe("describeTurn", () => {
  const record = {
    turnId: "turn_123456",
    stopReason: "end_turn" as const,
    projectRevision: 12,
    proposal: { baseRevision: 12, toolsetVersion: 3, calls: [] },
    outcomes: [
      {
        outcome: "rejected" as const,
        at: 1,
        issues: [
          {
            code: "invalid_payload" as const,
            callId: null,
            callName: null,
            path: null,
            message: null,
          },
          {
            code: "invalid_payload" as const,
            callId: null,
            callName: null,
            path: null,
            message: null,
          },
        ],
      },
    ],
  };

  it("says how the turn stopped and what became of it", () => {
    const lines = describeTurn(record, 12);
    expect(lines).toContain("Turn turn_123456: stopped with end_turn.");
    expect(lines).toContain("Outcome: rejected (invalid_payload).");
    expect(lines.join("\n")).not.toContain("moved on");
  });

  it("warns when the project has moved since the turn", () => {
    expect(describeTurn(record, 15).join("\n")).toContain(
      "revision 12 then, 15 now): the fixture is its current state, not the one the model saw",
    );
  });

  it("says when nothing became of it", () => {
    expect(describeTurn({ ...record, proposal: null, outcomes: [] }, 12)).toEqual(
      expect.arrayContaining(["It made no proposal.", "Outcome: none recorded."]),
    );
  });
});

describe("formatScrubReport", () => {
  const fixture = {
    name: "scrubbed-1",
    path: "src/assistant/evals/fixtures/scrubbed-1.json",
  };

  it("names the tracks a refusal is about and the way past it", () => {
    const text = formatScrubReport(
      { ok: false, reason: "unresolvable", tracks: [{ name: "Vocals", assets: 2 }] },
      fixture,
    );
    expect(text).toContain("  Vocals: 2 sounds");
    expect(text).toContain("--drop-unresolvable");
  });

  it("prints the summary and the renames", () => {
    const text = formatScrubReport(
      {
        ok: true,
        project: {} as never,
        renames: [{ kind: "track", from: "Drums", to: "Drum machine 1" }],
        droppedTracks: [],
        droppedAssets: 0,
        cleared: ["genre"],
        summary: { tracks: 1, clips: 2, notes: 16, devices: 3 },
      },
      fixture,
    );
    expect(text).toContain("1 tracks, 2 clips, 16 notes, 3 devices");
    expect(text).toContain('track "Drums" -> "Drum machine 1"');
    expect(text).toContain("Cleared: genre.");
    expect(text).toContain("bun run assistant:try -- new scrubbed-1");
  });
});
