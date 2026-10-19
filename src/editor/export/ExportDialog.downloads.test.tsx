import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineRenderError } from "../../audio/offlineRenderer";
import type { Project } from "../../domain/entities";
import { createReferenceProject, createSliceFixtureProject } from "../../domain/fixtures";
import { stubCanvasContext } from "../../testing/canvas";
import { clickAndFlush } from "../../testing/events";
import { downloadCards } from "./downloadCards";
import ExportDialog from "./ExportDialog";
import { exportFileName } from "./exportFileName";
import { stemsBatchFileName } from "./stemsExport";
import type { StereoExportOptions } from "./stereoExport";

/** The Downloads row: one card per file, with the state the export has reached (EXP-004). */

afterEach(cleanup);
stubCanvasContext();

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flush();
};

function renderDialog(project: Project = createSliceFixtureProject()) {
  let options: StereoExportOptions | undefined;
  let reject!: (error: unknown) => void;
  const exportWav = vi.fn((_p: Project, given?: StereoExportOptions) => {
    options = given;
    return new Promise((_resolve, rej) => {
      reject = rej;
    });
  });
  render(() => (
    <ExportDialog
      project={() => project}
      exportWav={exportWav as never}
      download={vi.fn()}
      onClose={vi.fn()}
    />
  ));
  return {
    project,
    progress: (fraction: number) => {
      options?.onProgress?.(fraction);
      flush();
    },
    fail: async () => {
      reject(new OfflineRenderError("decode_failed", "bad asset"));
      await settle();
    },
  };
}

const row = () => screen.getByRole("region", { name: "Downloads" });
const cards = () => [...row().querySelectorAll<HTMLElement>(".download")];

describe("ExportDialog: the Downloads row", () => {
  it("is always there, and lists the stereo WAV by its file name with its size", () => {
    const { project } = renderDialog();
    expect(within(row()).getByText("Downloads")).toBeVisible();
    expect(cards()).toHaveLength(1);
    const name = exportFileName(project.metadata.name, new Date(), "wav");
    expect(within(cards()[0]).getByText(name)).toBeVisible();
    expect(cards()[0]).toHaveTextContent(/1 file · \d+ MiB/);
    expect(cards()[0]).toHaveTextContent("Waiting");
  });

  it("lists the ZIP for the stems selection, with its file count", () => {
    const { project } = renderDialog();
    clickAndFlush(screen.getByRole("radio", { name: "Stems (ZIP)" }));
    const name = stemsBatchFileName(project.metadata.name, new Date(), 0, 1);
    expect(cards()).toHaveLength(1);
    expect(within(cards()[0]).getByText(name)).toBeVisible();
    // The track's stem and the reference mix.
    expect(cards()[0]).toHaveTextContent(/[23] files · \d+ MiB/);
  });

  it("lists nothing to export when every stem is turned off", () => {
    renderDialog();
    clickAndFlush(screen.getByRole("radio", { name: "Stems (ZIP)" }));
    clickAndFlush(screen.getAllByRole("option")[0]);
    expect(cards()).toHaveLength(0);
    expect(row()).toHaveTextContent("Nothing to export");
    expect(row()).not.toHaveTextContent(/\.zip|1 file/);
    const footer = document.querySelector(".export-footer") as HTMLElement;
    expect(footer).toHaveTextContent("Nothing to export");
    expect(footer).not.toHaveTextContent(/\d+ MiB|1 ZIP/);
  });

  it("follows the export: printing, then downloaded, or failed", async () => {
    const view = renderDialog();
    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    view.progress(0.4);
    expect(cards()[0]).toHaveTextContent("Printing 40%");
    expect(cards()[0].querySelector("i")).toHaveStyle({ width: "40%" });
    await view.fail();
    expect(cards()[0]).toHaveTextContent("Failed");
    expect(cards()[0]).toHaveClass("bad");
  });

  it("splits an over-budget selection into numbered ZIPs, each named on hover", () => {
    renderDialog(createReferenceProject());
    clickAndFlush(screen.getByRole("radio", { name: "Stems (ZIP)" }));
    expect(cards().length).toBeGreaterThan(1);
    const first = cards()[0].querySelector("b");
    expect(first).toHaveTextContent(`ZIP 1 of ${cards().length}`);
    expect(first?.getAttribute("title")).toMatch(/ stems 1 of \d+\.zip$/);
  });
});

describe("downloadCards", () => {
  const base = {
    format: "stereo" as const,
    projectName: "Song",
    date: new Date(2026, 8, 30),
    batches: [],
    stereoBytes: 300 * 1024 ** 2,
  };
  const idle = { done: 0, printing: null, failed: null };
  const zipPlan = (index: number) => ({
    index,
    paths: ["a.wav", "b.wav"],
    hasMix: index === 0,
    trackIds: [],
    rowIds: [],
    bytes: 10 * 1024 ** 2,
    expectedBytes: 4 * 1024 ** 2,
    fits: true,
  });
  const zips = (
    progress: typeof idle | Parameters<typeof downloadCards>[0]["progress"],
  ) =>
    downloadCards({
      ...base,
      format: "stems",
      batches: [zipPlan(0), zipPlan(1), zipPlan(2)],
      progress,
    }).map((zip) => [zip.state, zip.fraction]);

  it("fills a finished file's line", () => {
    expect(downloadCards({ ...base, progress: { ...idle, done: 1 } })[0]).toMatchObject({
      name: "Song 2026-09-30.wav",
      detail: "1 file · 300 MiB",
      state: "done",
      fraction: 1,
    });
  });

  // #836: a card shows what the ZIP is expected to weigh, not the budget's bound.
  it("sizes a ZIP at its expected weight", () => {
    const [card] = downloadCards({
      ...base,
      format: "stems",
      batches: [zipPlan(0)],
      progress: idle,
    });
    expect(card.detail).toBe("2 files · 4 MiB");
  });

  it("walks the ZIPs in order: downloaded, printing, then waiting", () => {
    expect(
      zips({ done: 1, printing: { index: 1, fraction: 0.5 }, failed: null }),
    ).toEqual([
      ["done", 1],
      ["now", 0.5],
      ["waiting", 0],
    ]);
  });

  it("marks the ZIP that failed and leaves the finished ones downloaded", () => {
    expect(zips({ done: 1, printing: null, failed: 1 })).toEqual([
      ["done", 1],
      ["bad", 0],
      ["waiting", 0],
    ]);
  });
});
