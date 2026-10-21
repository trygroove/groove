import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import type { ClipId } from "../../domain/ids";
import { CodedError } from "../../monitoring";
import type { PersistenceIssue } from "../../persistence/documents";
import { loadFailure } from "../../persistence/projectRepository";
import { reportProjectLoad, summarizeLoadIssues } from "./projectLoadReport";

function dangling(index: number): PersistenceIssue {
  return {
    code: "dangling_reference",
    path: ["song", "placements", index, "clipId"],
    message: `Placement plc_${index} references missing clip clp_${index}`,
  };
}

describe("reportProjectLoad (#965)", () => {
  it("reports a load failure once, coded by its reason, with the issues summarised", () => {
    const report = vi.fn(() => true);
    const issues = Array.from({ length: 11 }, (_, index) => dangling(index));

    reportProjectLoad(
      loadFailure<Project>(
        "invalid_document",
        "Stored project prj_x could not be read",
        issues,
      ),
      report,
    );

    expect(report).toHaveBeenCalledTimes(1);
    const [error, options] = report.mock.calls[0] as unknown as [CodedError, object];
    expect(error).toBeInstanceOf(CodedError);
    expect(error.code).toBe("invalid_document");
    expect(error.message).toBe(
      "Project load failed: dangling_reference x11 at song.placements.#.clipId",
    );
    expect(options).toEqual({ area: "persistence", fatal: false });
  });

  it("never puts an issue's own text, or an ID from its path, into the report", () => {
    const report = vi.fn(() => true);
    const project = createSliceFixtureProject();

    reportProjectLoad(
      loadFailure<Project>("invalid_document", "unused", [
        {
          code: "missing_document",
          path: ["arrangement", project.song.tracks[0].id],
          message: `Track ${project.song.tracks[0].name} chunk is missing`,
        },
      ]),
      report,
    );

    const [error] = report.mock.calls[0] as unknown as [CodedError];
    expect(error.message).toBe(
      "Project load failed: missing_document x1 at arrangement.*",
    );
    expect(error.message).not.toContain(project.song.tracks[0].id);
    expect(error.message).not.toContain(project.song.tracks[0].name);
  });

  it("does not report a project that does not exist", () => {
    const report = vi.fn(() => true);

    reportProjectLoad(
      loadFailure<Project>("not_found", "Project prj_x does not exist"),
      report,
    );

    expect(report).not.toHaveBeenCalled();
  });

  it("reports an open that had to drop references, by count only", () => {
    const report = vi.fn(() => true);
    const clipId = `clp_${"o".repeat(21)}` as ClipId;

    reportProjectLoad(
      {
        ok: true,
        value: createSliceFixtureProject(),
        dropped: { placements: 3, clipIds: [clipId] },
      },
      report,
    );

    expect(report).toHaveBeenCalledTimes(1);
    const [error] = report.mock.calls[0] as unknown as [CodedError];
    expect(error.code).toBe("invalid_document");
    expect(error.message).toContain("3 placement(s)");
    expect(error.message).toContain("1 clip(s)");
    expect(error.message).not.toContain(clipId);
  });

  it("stays silent for a clean open", () => {
    const report = vi.fn(() => true);

    reportProjectLoad({ ok: true, value: createSliceFixtureProject() }, report);

    expect(report).not.toHaveBeenCalled();
  });
});

describe("summarizeLoadIssues", () => {
  it("groups by code and path shape, most frequent first, and caps the list", () => {
    const issues: PersistenceIssue[] = [
      { code: "invalid_shape", path: ["clips", 0, "id"], message: "" },
      ...Array.from({ length: 3 }, (_, index) => dangling(index)),
      ...["a", "b", "c", "d", "e"].map(
        (key): PersistenceIssue => ({ code: "invalid_shape", path: [key], message: "" }),
      ),
    ];

    expect(summarizeLoadIssues(issues)).toBe(
      "dangling_reference x3 at song.placements.#.clipId; invalid_shape x1 at clips.#.id; invalid_shape x1 at a; invalid_shape x1 at b; invalid_shape x1 at c; and 2 more",
    );
  });

  it("says so when there were no issues to summarise", () => {
    expect(summarizeLoadIssues([])).toBe("no issues reported");
  });
});
