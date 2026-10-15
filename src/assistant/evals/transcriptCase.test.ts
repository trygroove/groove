import { describe, expect, it } from "vitest";
import { transcriptRecordFor } from "../transcripts";
import { evalCaseFromTranscript, TRANSCRIPT_FIXTURE_PROJECTS } from "./cases";
import { selectEvalCases } from "./cli";
import {
  exportTranscriptCase,
  parseTranscriptCase,
  transcriptCaseFileName,
} from "./transcriptCase";

const RECORD = {
  ...transcriptRecordFor({
    uid: "producer-uid",
    session: {
      conversationId: "conversation-1",
      turnId: "turn-0001",
      projectId: "prj_one",
      internal: false,
    },
    internalAccount: false,
    projectRevision: 3,
    userMessage: "I want to add an atmospheric or noisy layer",
    reply: "Here is a noise pad.",
    stopReason: "tool_use",
    proposal: {
      baseRevision: 3,
      toolsetVersion: 6,
      calls: [{ id: "toolu_1", name: "track_create", input: { track: {} } }],
    },
    model: "claude-sonnet-5",
    promptVersion: "7",
    receivedAt: 1_000,
  }),
  outcomes: [
    {
      outcome: "rejected" as const,
      at: 1_001,
      issues: [
        {
          code: "invalid_payload" as const,
          callId: "toolu_1",
          callName: "track_create",
          path: null,
          message: "track.instrument.assetId: Expected an id",
        },
      ],
    },
  ],
};

describe("a kept turn as an eval case (GRV-98)", () => {
  it("round-trips through the file the viewer downloads", () => {
    const exported = exportTranscriptCase(RECORD);
    const file = JSON.parse(JSON.stringify(exported));
    const parsed = parseTranscriptCase(file);
    expect(parsed).toEqual({ ok: true, value: exported });
    expect(exported).toMatchObject({
      request: "I want to add an atmospheric or noisy layer",
      fixture: "house-loop",
      recorded: { toolsetVersion: 6, calls: RECORD.proposal?.calls },
    });
    // Never the account or the project.
    expect(JSON.stringify(exported)).not.toMatch(/producer-uid|prj_one/);
    expect(transcriptCaseFileName("turn-0001")).toBe("transcript-turn-0001.json");
  });

  it("runs the message against the fixture the file names, free to add tracks", () => {
    const evalCase = evalCaseFromTranscript(exportTranscriptCase(RECORD, "kit-sketch"));
    expect(evalCase).toMatchObject({
      id: "transcript-turn-0001",
      request: "I want to add an atmospheric or noisy layer",
      selection: null,
      scope: { tracks: "all", createTracks: true },
    });
    expect(evalCase.fixture).toBe(TRANSCRIPT_FIXTURE_PROJECTS["kit-sketch"]);
    expect(evalCase.fixture().song.tracks.length).toBeGreaterThan(0);
    // Its id is not one of the shipped cases'.
    expect(() => selectEvalCases([evalCase.id])).toThrow();
  });

  it("says what is wrong with a file that is not one", () => {
    const result = parseTranscriptCase({ kind: "something-else" });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toMatch(/kind/);
    expect(
      parseTranscriptCase({ ...exportTranscriptCase(RECORD), fixture: "techno" }).ok,
    ).toBe(false);
  });
});
