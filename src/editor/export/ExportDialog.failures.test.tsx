import { cleanup, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { bucketOf } from "../../analytics/buckets";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { OfflineRenderError } from "../../audio/offlineRenderer";
import { createReferenceProject, createSliceFixtureProject } from "../../domain/fixtures";
import { StemExportError } from "../../export/stems/exportStems";
import { stubCanvasContext } from "../../testing/canvas";
import { expectNoContent, recordErrorReports } from "../../testing/errorReports";
import { clickAndFlush } from "../../testing/events";
import { fakeStemsBatch } from "../../testing/stemsBatchFake";
import { memoryStorage } from "../../testing/storage";
import ExportDialog, { failureMessage } from "./ExportDialog";
import { estimateStereoBytes } from "./exportFacts";
import type { exportStereoWav, StereoExport } from "./stereoExport";

/**
 * A failed export as the producer and monitoring see it (GRV-55): a plain
 * message and a way to try again, and one scrubbed error report with the
 * export's shape in buckets.
 */

afterEach(cleanup);
stubCanvasContext();

const FILE: StereoExport = {
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
  fileName: "Midnight Drive 2026-10-19.wav",
  sampleRate: 48_000,
  frames: 1,
};

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  flush();
};

function setUp(options: {
  exportWav: typeof exportStereoWav;
  download?: (file: Blob, name: string) => void;
}) {
  const project = createSliceFixtureProject();
  const recorded = recordErrorReports();
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  const download = vi.fn(options.download ?? (() => {}));
  render(() => (
    <ExportDialog
      project={() => project}
      exportWav={options.exportWav}
      download={download}
      analytics={analytics}
      reportError={recorded.report}
      onClose={() => {}}
    />
  ));
  const content = [
    project.metadata.name,
    FILE.fileName,
    ...project.song.tracks.map((track) => track.name),
    ...project.song.assets.map((asset) => asset.name),
  ];
  return { project, recorded, transport, download, content };
}

const exportButton = () => screen.getByRole("button", { name: "Export" });

describe("a failed export (GRV-55)", () => {
  it("says the render stopped, reports it once, scrubbed, and exports on the next try", async () => {
    let attempts = 0;
    const exportWav = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new OfflineRenderError("render_failed", "The offline render failed");
      }
      return FILE;
    }) as unknown as typeof exportStereoWav;
    const { recorded, download, content } = setUp({ exportWav });

    clickAndFlush(exportButton());
    await settle();

    expect(screen.getByRole("alert")).toHaveTextContent(failureMessage("render_failed"));
    expect(download).not.toHaveBeenCalled();
    expect(recorded.reports).toHaveLength(1);
    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({
      area: "export",
      error_code: "render_failed",
      fatal: false,
      export_type: "stereo",
      file_size_bucket: "under_10mb",
      track_count_bucket: "1_2",
    });
    expect(payload.tags).not.toHaveProperty("zip_count");
    expectNoContent(payload, content);

    clickAndFlush(exportButton());
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(/complete/i);
    expect(recorded.reports).toHaveLength(1);
  });

  it("says the browser blocked the download, logs export_failed, and reports it once", async () => {
    const exportWav = vi.fn(async () => FILE) as unknown as typeof exportStereoWav;
    const { recorded, transport, content } = setUp({
      exportWav,
      download: () => {
        throw new DOMException("Download of Midnight Drive refused", "SecurityError");
      },
    });

    clickAndFlush(exportButton());
    await settle();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your browser blocked the download. Allow downloads for this site, then try again.",
    );
    const failed = transport.named("export_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.params).toMatchObject({
      export_type: "stereo",
      error_code: "download_blocked",
      was_cancelled: false,
    });
    expect(recorded.reports).toHaveLength(1);
    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({ error_code: "download_blocked" });
    expectNoContent(payload, content);
  });

  it("says a render ran out of memory and reports it once, scrubbed, with the export's shape", async () => {
    const exportWav = vi.fn(async () => {
      throw new OfflineRenderError("out_of_memory", "The render ran out of memory", {
        cause: new RangeError("Array buffer allocation failed for Midnight Drive"),
      });
    }) as unknown as typeof exportStereoWav;
    const { project, recorded, transport, content } = setUp({ exportWav });

    clickAndFlush(exportButton());
    await settle();

    expect(screen.getByRole("alert")).toHaveTextContent(failureMessage("out_of_memory"));
    expect(recorded.reports).toHaveLength(1);
    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({
      area: "export",
      error_code: "out_of_memory",
      fatal: false,
      export_type: "stereo",
      file_size_bucket: bucketOf("file_bytes", estimateStereoBytes(project)),
      track_count_bucket: bucketOf("track_count", project.song.tracks.length),
    });
    expect(payload.tags).not.toHaveProperty("zip_count");
    expectNoContent(payload, [...content, "Array buffer allocation failed"]);
    // The render logs its own export_failed; the dialog adds none.
    expect(transport.named("export_failed")).toHaveLength(0);
  });

  it("says a ZIP of a stems export failed and reports that batch once, scrubbed", async () => {
    const project = createReferenceProject();
    const recorded = recordErrorReports();
    const fake = fakeStemsBatch(project.metadata.name);
    const download = vi.fn();
    render(() => (
      <ExportDialog
        project={() => project}
        exportStemsBatch={fake.exportStemsBatch}
        download={download}
        reportError={recorded.report}
        onClose={() => {}}
      />
    ));
    clickAndFlush(screen.getByRole("radio", { name: "Stems (ZIP)" }));
    clickAndFlush(exportButton());
    await settle();
    const count = fake.calls[0].request.count;
    expect(count).toBeGreaterThan(1);

    await fake.calls[0].resolve();
    expect(download).toHaveBeenCalledTimes(1);
    const failing = fake.calls[1].request;
    await fake.calls[1].reject(
      new StemExportError("zip_batch_failed", "A ZIP could not be built", {
        cause: new Error(`deflate failed on ${project.song.tracks[0].name}.wav`),
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      failureMessage("zip_batch_failed", "stems"),
    );
    expect(recorded.reports).toHaveLength(1);
    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({
      area: "export",
      error_code: "zip_batch_failed",
      fatal: false,
      export_type: "stems",
      file_size_bucket: bucketOf("file_bytes", failing.batch.expectedBytes),
      track_count_bucket: bucketOf("track_count", failing.trackIds?.length ?? 0),
      zip_count: count,
    });
    expectNoContent(payload, [
      project.metadata.name,
      ...project.song.tracks.map((track) => track.name),
      ...project.song.assets.map((asset) => asset.name),
      ...project.clips.map((clip) => clip.name),
      String(download.mock.calls[0][1]),
      "deflate failed",
    ]);
  });

  it("reports nothing when the producer cancels", async () => {
    const exportWav = vi.fn(async () => {
      throw new OfflineRenderError("aborted", "Cancelled");
    }) as unknown as typeof exportStereoWav;
    const { recorded } = setUp({ exportWav });

    clickAndFlush(exportButton());
    await settle();

    expect(recorded.reports).toHaveLength(0);
  });

  it("reports an uncoded failure by its code alone, never its text", async () => {
    const exportWav = vi.fn(async () => {
      throw new Error("Midnight Drive exploded");
    }) as unknown as typeof exportStereoWav;
    const { recorded, content } = setUp({ exportWav });

    clickAndFlush(exportButton());
    await settle();

    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({ error_code: "internal" });
    expectNoContent(payload, [...content, "exploded"]);
  });
});

describe("failureMessage for GRV-55's failures", () => {
  it("tells the producer what to do for each", () => {
    expect(failureMessage("out_of_memory")).toMatch(
      /ran out of memory.*Close other tabs/,
    );
    expect(failureMessage("out_of_memory", "stems")).toMatch(/select fewer tracks/);
    expect(failureMessage("render_failed")).toMatch(/Try again.*Your edits are kept/);
    expect(failureMessage("zip_batch_failed")).toMatch(/ZIP couldn't be put together/);
    expect(failureMessage("download_blocked")).toMatch(/Allow downloads for this site/);
  });
});
