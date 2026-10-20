import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { StemExportError } from "../../export/stems/exportStems";
import { stubCanvasContext } from "../../testing/canvas";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { type BatchCall, fakeStemsBatch } from "../../testing/stemsBatchFake";
import ExportDialog, { failureMessage } from "./ExportDialog";
import type {
  exportStemsBatch as exportStemsBatchType,
  StemsExportFile,
} from "./stemsExport";

/** The Stems (ZIP) half of the Export dialog (EXP-003, CF-022). */

afterEach(cleanup);
stubCanvasContext();

const FILE: StemsExportFile = {
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/zip" }),
  fileName: "Song 2026-09-29 stems.zip",
};

function renderDialog(exportStemsBatch: typeof exportStemsBatchType) {
  const project = createSliceFixtureProject();
  const download = vi.fn();
  const exportWav = vi.fn();
  render(() => (
    <ExportDialog
      project={() => project}
      exportStemsBatch={exportStemsBatch}
      exportWav={exportWav as never}
      download={download}
      onClose={vi.fn()}
    />
  ));
  return { download, exportWav };
}

const fakeProgress = (call: BatchCall, fraction: number) =>
  fireAndFlush(() => call.request.onProgress?.(fraction));
const radio = (name: string) => screen.getByRole("radio", { name });
const choose = (name: string) => clickAndFlush(radio(name));

describe("ExportDialog: Stems (ZIP)", () => {
  it("offers Stems (ZIP) at 24-bit, with no bit-depth choice", () => {
    renderDialog(fakeStemsBatch().exportStemsBatch);
    choose("Stems (ZIP)");
    expect(radio("Stems (ZIP)")).toBeChecked();
    expect(radio("Stereo WAV")).not.toBeChecked();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByText(/One WAV per track, lined up at bar 1/)).toBeVisible();
    expect(screen.getByText(/^24-bit \u00b7 \d+(\.\d)? kHz$/)).toBeVisible();
  });

  it("renders stems, downloads one ZIP and says it is done", async () => {
    const fake = fakeStemsBatch();
    const { download, exportWav } = renderDialog(fake.exportStemsBatch);
    choose("Stems (ZIP)");
    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    expect(fake.calls).toHaveLength(1);
    fakeProgress(fake.calls[0], 0.3);
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0.3");

    await fake.calls[0].resolve(FILE);
    expect(exportWav).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(FILE.blob, FILE.fileName);
    expect(screen.getByRole("status")).toHaveTextContent("Export complete");
    expect(screen.getByText(/stems\.zip is in your downloads/)).toBeVisible();
  });

  it("cancels, downloads nothing, and returns to the choice", async () => {
    const fake = fakeStemsBatch();
    const { download } = renderDialog(fake.exportStemsBatch);
    choose("Stems (ZIP)");
    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    clickAndFlush(screen.getByRole("button", { name: "Cancel" }));
    expect(fake.calls[0].request.signal?.aborted).toBe(true);
    await fake.calls[0].reject(new StemExportError("aborted", "cancelled"));
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });

  it("says what to do when the stems are too large", async () => {
    const fake = fakeStemsBatch();
    const { download } = renderDialog(fake.exportStemsBatch);
    choose("Stems (ZIP)");
    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    await fake.calls[0].reject(new StemExportError("quota_exceeded", "too large"));
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      failureMessage("quota_exceeded", "stems"),
    );
    expect(failureMessage("quota_exceeded", "stems")).toMatch(/2 GiB/);
  });
});

describe("ExportDialog: opened on stems by a lesson (GRV-44)", () => {
  it("opens with Stems chosen and every track in it, and says when Export is pressed", () => {
    const project = createSliceFixtureProject();
    const fake = fakeStemsBatch();
    const onExportStart = vi.fn();
    render(() => (
      <ExportDialog
        project={() => project}
        exportStemsBatch={fake.exportStemsBatch}
        exportWav={vi.fn() as never}
        download={vi.fn()}
        initialFormat="stems"
        onExportStart={onExportStart}
        onClose={vi.fn()}
      />
    ));
    expect(radio("Stems (ZIP)")).toBeChecked();
    expect(onExportStart).not.toHaveBeenCalled();
    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    expect(onExportStart).toHaveBeenCalledTimes(1);
    expect(onExportStart).toHaveBeenCalledWith("stems");
    // Every track goes into the stems, as an export the producer opens does.
    expect(fake.calls[0]?.request.trackIds).toEqual(
      project.song.tracks.map((track) => track.id),
    );
  });
});
