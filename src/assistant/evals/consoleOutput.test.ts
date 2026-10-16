import { describe, expect, it } from "vitest";
import {
  callsSummary,
  clearsWithoutWriting,
  failureDigestLines,
  inputShape,
  recordLines,
} from "./consoleOutput";
import type { EvalRecord, EvalReport } from "./run";

function record(overrides: Partial<EvalRecord>): EvalRecord {
  return {
    caseId: "sketch-house",
    run: 1,
    error: null,
    proposal: null,
    ask: null,
    checks: {},
    ...overrides,
  } as EvalRecord;
}

function proposal(calls: Array<{ name: string; input?: unknown }>) {
  return {
    baseRevision: 0,
    toolsetVersion: 6,
    calls: calls.map((call, index) => ({ id: `toolu_${index}`, input: {}, ...call })),
  } as unknown as EvalRecord["proposal"];
}

const WRAPPED = record({
  caseId: "pad-genre-known",
  proposal: proposal([
    { name: "track_create", input: { track: { track: {}, clips: [], placements: [] } } },
    { name: "explain_change" },
  ]),
  checks: {
    valid: {
      status: "fail",
      kind: "schema",
      detail: "schema: invalid_payload (call 0): track.id: Invalid input",
    },
  },
});

const HOLLOW = record({
  caseId: "sketch-broken",
  proposal: proposal([{ name: "notes_clear" }, { name: "clip_update" }]),
  checks: {
    valid: { status: "pass", detail: "Applied" },
    coverage: { status: "fail", detail: "0 of 5 covered" },
  },
});

describe("the eval's console output", () => {
  it("names each tool once, with a count for repeats", () => {
    const repeated = record({
      proposal: proposal([
        { name: "track_create" },
        { name: "track_create" },
        { name: "explain_change" },
      ]),
    });
    expect(callsSummary(repeated)).toBe("track_create x2, explain_change");
    expect(callsSummary(record({}))).toBe("no calls");
  });

  it("describes what shape a call's input came in", () => {
    expect(inputShape({ track: { track: {}, clips: [] } })).toBe(
      "{track: {track, clips}}",
    );
    expect(inputShape('{"track":{}}')).toBe("a JSON string, not an object");
  });

  it("prints every failed check's reason, and the shape of a call check 1 refused", () => {
    const lines = recordLines(WRAPPED);
    expect(lines[0]).toContain(
      "FAIL pad-genre-known run 1 [track_create, explain_change]",
    );
    expect(lines[1]).toContain(
      "1. Valid: schema: invalid_payload (call 0, track_create)",
    );
    expect(lines[2]).toContain("track_create got {track: {track, clips, placements}}");
    expect(recordLines(HOLLOW)[1]).toContain(
      "7. Covers the requested parts: 0 of 5 covered",
    );
  });

  it("calls out a proposal that clears notes and writes none back", () => {
    expect(clearsWithoutWriting(HOLLOW)).toBe(true);
    expect(clearsWithoutWriting(WRAPPED)).toBe(false);
    expect(recordLines(HOLLOW)[0]).toContain("clears notes, writes none");
  });

  it("groups failures by check and by reason across runs", () => {
    const report = {
      records: [WRAPPED, { ...WRAPPED, run: 2 }, HOLLOW],
    } as unknown as EvalReport;
    const digest = failureDigestLines(report).join("\n");
    expect(digest).toContain(
      "2x schema: track_create got {track: {track, clips, placements}}",
    );
    expect(digest).toContain("in pad-genre-known x2");
    expect(digest).toContain("Applied, but clears notes and writes none back");
  });

  it("prints no digest when nothing failed", () => {
    expect(failureDigestLines({ records: [] } as unknown as EvalReport)).toEqual([]);
  });
});
