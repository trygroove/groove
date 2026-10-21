import type { StemBatch } from "../../export/stems/stemBatches";
import type { DownloadCard, DownloadState } from "./DownloadsRow";
import { exportFileName } from "./exportFileName";
import type { ExportFormat } from "./FormatCards";
import { formatExportSize } from "./stemSelection";
import { stemsBatchFileName } from "./stemsExport";

/**
 * What the Downloads row lists (EXP-004): the stereo WAV, or the ZIP(s) the
 * current selection splits into, each with the state the export has reached.
 * Pure, so the row and its tests share one derivation.
 */

export interface DownloadCardsInput {
  readonly format: ExportFormat;
  readonly projectName: string;
  /** One date for every name, so a run across midnight stays together. */
  readonly date: Date;
  /** The planned ZIPs, for stems. */
  readonly batches: readonly StemBatch[];
  /** The stereo WAV's size, for stereo. */
  readonly stereoBytes: number;
  /** How far the export has got through its files, which are made in order. */
  readonly progress: DownloadProgress;
}

export interface DownloadProgress {
  /** Files already downloaded: the first `done` cards. */
  readonly done: number;
  /** The file being printed now, and how far along it is, 0..1. */
  readonly printing: { readonly index: number; readonly fraction: number } | null;
  /** The file that failed, if one did. */
  readonly failed: number | null;
}

function cardState(
  index: number,
  { done, printing, failed }: DownloadProgress,
): { state: DownloadState; fraction: number } {
  if (index < done) return { state: "done", fraction: 1 };
  if (printing?.index === index) return { state: "now", fraction: printing.fraction };
  return { state: failed === index ? "bad" : "waiting", fraction: 0 };
}

const files = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`;

export function downloadCards(input: DownloadCardsInput): DownloadCard[] {
  if (input.format === "stereo") {
    return [
      {
        name: exportFileName(input.projectName, input.date, "wav"),
        detail: `1 file · ${formatExportSize(input.stereoBytes)}`,
        ...cardState(0, input.progress),
      },
    ];
  }
  const count = input.batches.length;
  return input.batches.map((batch, index) => {
    const name = stemsBatchFileName(input.projectName, input.date, index, count);
    return {
      name: count > 1 ? `ZIP ${index + 1} of ${count}` : name,
      title: name,
      detail: `${files(batch.paths.length)} · ${formatExportSize(batch.expectedBytes)}`,
      ...cardState(index, input.progress),
    };
  });
}
