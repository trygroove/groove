import { describe, expect, it } from "vitest";
import { testRecord } from "../../testing/evalRecords";
import type { EvalRecord } from "./run";
import type { EvalSessionTurn } from "./session";
import { hasBundles, toolBundleLines, toolBundleSummary } from "./toolBundleReport";

function record(
  caseId: string,
  toolBundle: EvalRecord["toolBundle"],
  cache: { read: number; write: number },
): EvalRecord {
  return {
    ...testRecord({
      caseId,
      usage: { cacheReadInputTokens: cache.read, cacheCreationInputTokens: cache.write },
    }),
    toolBundle,
  };
}

const control = {
  records: [
    record("mix-case", null, { read: 30_000, write: 0 }),
    record("mix-case", null, { read: 30_000, write: 0 }),
    record("notes-case", null, { read: 30_000, write: 0 }),
  ],
};

const variant = {
  records: [
    record("mix-case", { bundle: "mix", fallback: null }, { read: 0, write: 18_000 }),
    record("mix-case", { bundle: "mix", fallback: null }, { read: 18_000, write: 0 }),
    record(
      "notes-case",
      { bundle: "notes", fallback: "need_more_tools" },
      { read: 20_000, write: 2_000 },
    ),
  ],
};

describe("the tool bundle report (GRV-143)", () => {
  it("counts the bundle chosen and the fallbacks per case, and cache tokens per turn", () => {
    const summary = toolBundleSummary(variant);
    expect(summary.overall).toEqual({
      turns: 3,
      bundles: { mix: 2, notes: 1 },
      fallbacks: { need_more_tools: 1, unoffered_tool: 0 },
      cacheReadPerTurn: 38_000 / 3,
      cacheWritePerTurn: 20_000 / 3,
    });
    expect(summary.cases["mix-case"]).toMatchObject({
      turns: 2,
      bundles: { mix: 2 },
      cacheReadPerTurn: 9_000,
      cacheWritePerTurn: 9_000,
    });
    expect(hasBundles(summary)).toBe(true);
    expect(hasBundles(toolBundleSummary(control))).toBe(false);
  });

  it("counts a session's turns one by one", () => {
    const turn = (bundle: "mix" | "arrange", turnNumber: number): EvalSessionTurn => ({
      ...record("session-case", { bundle, fallback: null }, { read: 1, write: 1 }),
      turn: turnNumber,
      request: "",
    });
    const session = {
      ...record("session-case", { bundle: "mix", fallback: null }, { read: 2, write: 2 }),
      session: {
        turns: [turn("mix", 1), turn("arrange", 2)],
        ended: "done",
        maxTurns: 5,
      },
    } as EvalRecord;
    expect(toolBundleSummary({ records: [session] }).cases["session-case"]).toMatchObject(
      { turns: 2, bundles: { mix: 1, arrange: 1 } },
    );
  });

  it("writes a section only for a variant that was offered bundles", () => {
    expect(toolBundleLines(control, control, "####")).toEqual([]);
    const text = toolBundleLines(control, variant, "####").join("\n");
    expect(text).toContain("#### Tool bundles");
    expect(text).toContain("Bundles chosen: mix ×2, notes ×1 over 3 turns.");
    expect(text).toContain("Fell back to every tool: 1 of 3 turns (33%)");
    expect(text).toContain("| `mix-case` | mix ×2 | 0 of 2 |");
    expect(text).toContain("| `notes-case` | notes ×1 | 1 of 1 |");
  });
});
