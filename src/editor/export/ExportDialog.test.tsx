import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineRenderError } from "../../audio/offlineRenderer";
import { CAPABILITY_MESSAGES } from "../../browser/capabilityMessages";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { stringifyProject } from "../../domain/serialize";
import { stubCanvasContext } from "../../testing/canvas";
import { clickAndFlush } from "../../testing/events";
import ExportDialog, { failureMessage } from "./ExportDialog";
import type { exportStereoWav, StereoExport, StereoExportOptions } from "./stereoExport";

afterEach(cleanup);
stubCanvasContext();

const FILE: StereoExport = {
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
  fileName: "Song 2026-09-29.wav",
  sampleRate: 48_000,
  frames: 1,
};

/** An export the test finishes by hand, capturing the options it was given. */
function pendingExport() {
  let resolve!: (file: StereoExport) => void;
  let reject!: (error: unknown) => void;
  let options: StereoExportOptions | undefined;
  const exportWav = vi.fn((_project, given?: StereoExportOptions) => {
    options = given;
    return new Promise<StereoExport>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  }) as unknown as typeof exportStereoWav;
  return {
    exportWav,
    options: () => options,
    resolve: (file: StereoExport) => resolve(file),
    reject: (error: unknown) => reject(error),
  };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flush();
};

function renderDialog(exportWav: typeof exportStereoWav, onClose = vi.fn()) {
  const project = createSliceFixtureProject();
  const download = vi.fn();
  render(() => (
    <ExportDialog
      project={() => project}
      exportWav={exportWav}
      download={download}
      onClose={onClose}
    />
  ));
  return { project, download, onClose };
}

describe("ExportDialog", () => {
  it("ignores the second click of a double click on Export instead of cancelling", async () => {
    const pending = pendingExport();
    const { download } = renderDialog(pending.exportWav);
    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    // The second click of the pair lands on Cancel, which took Export's place.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }), { detail: 2 });
    flush();
    expect(pending.options()?.signal?.aborted).toBe(false);
    pending.resolve(FILE);
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("opens with Stereo WAV chosen and Stems (ZIP) offered but not chosen", () => {
    renderDialog(pendingExport().exportWav);
    expect(screen.getByRole("dialog", { name: "Export" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Stereo WAV" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Stems (ZIP)" })).not.toBeChecked();
  });

  it("shows progress with Cancel while rendering, then downloads the file and says it is done", async () => {
    const pending = pendingExport();
    const { project, download } = renderDialog(pending.exportWav);
    const before = stringifyProject(project);

    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    pending.options()?.onProgress?.(0.4);
    flush();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0.4");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(download).not.toHaveBeenCalled();

    pending.resolve(FILE);
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(FILE.blob, FILE.fileName);
    expect(screen.getByRole("status")).toHaveTextContent(/complete/i);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(stringifyProject(project)).toBe(before);
  });

  it("cancels the render, downloads nothing, and returns to the choice", async () => {
    const pending = pendingExport();
    const { download } = renderDialog(pending.exportWav);

    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    clickAndFlush(screen.getByRole("button", { name: "Cancel" }));
    expect(pending.options()?.signal?.aborted).toBe(true);

    pending.reject(new OfflineRenderError("aborted", "cancelled"));
    await settle();
    expect(download).not.toHaveBeenCalled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    // The alert stays mounted for a screen reader; it just holds nothing.
    expect(screen.getByRole("alert").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });

  it("says what to do when a render fails, and presents no file", async () => {
    const pending = pendingExport();
    const { download } = renderDialog(pending.exportWav);

    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    pending.reject(new OfflineRenderError("decode_failed", "bad asset"));
    await settle();
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(failureMessage("decode_failed"));
    expect(screen.queryByText(/complete/i)).toBeNull();
  });

  it("cancels a render in flight when the dialog is closed", () => {
    const pending = pendingExport();
    const { onClose } = renderDialog(pending.exportWav);

    clickAndFlush(screen.getByRole("button", { name: "Export" }));
    clickAndFlush(screen.getByRole("button", { name: "Close export" }));
    expect(pending.options()?.signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("failureMessage", () => {
  it("gives each failure an actionable message", () => {
    expect(failureMessage("not_supported")).toMatch(/browser/);
    expect(failureMessage("quota_exceeded")).toMatch(/too long/);
    expect(failureMessage("internal")).toMatch(/Try again/);
  });

  it("gives the same browser advice as the compatibility notice when export is unsupported", () => {
    const message = failureMessage("not_supported");
    expect(message).toContain(CAPABILITY_MESSAGES.offline_audio.detail);
    expect(message).toContain(CAPABILITY_MESSAGES.offline_audio.action);
    expect(message).toContain("Chrome, Edge or Firefox");
    expect(message).not.toMatch(/Safari/);
  });
});
