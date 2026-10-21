import type { StemBatch } from "../../export/stems/stemBatches";
import type { ExportFacts } from "./exportFacts";
import { exportFileName } from "./exportFileName";
import type { ExportFormat } from "./FormatCards";
import type { SleeveStripe } from "./sleeveCanvas";
import { formatExportSize } from "./stemSelection";
import { stemsBatchFileName } from "./stemsExport";
import type { TrackLaneView } from "./trackLanes";

/**
 * What the finished screen of an export says (EXP-004): its file or ZIPs, the
 * four readouts, and the stripes the sleeve draws. A pure read of the export
 * the producer just made, so the screen and its tests share one derivation.
 */

export interface FinishedExport {
  readonly name: string;
  /** `120 BPM`, for the sleeve's caption. */
  readonly tempo: string;
  readonly length: string;
  readonly format: ExportFormat;
  /** The one file's name; for several ZIPs, the first's. */
  readonly fileName: string;
  /** Every ZIP with its size, when there are several. */
  readonly zips: readonly { readonly name: string; readonly size: string }[];
  /** Stems made, or the tracks in the mix. */
  readonly count: number;
  readonly size: string;
  readonly bars: number;
  readonly stripes: readonly SleeveStripe[];
}

export interface FinishedExportInput {
  readonly format: ExportFormat;
  readonly facts: ExportFacts;
  readonly date: Date;
  readonly rows: readonly TrackLaneView[];
  readonly batches: readonly StemBatch[];
  /** The size of each file the export wrote, in order: the WAV, or every ZIP. */
  readonly fileBytes: readonly number[];
  readonly bars: number;
}

export function finishedExport(input: FinishedExportInput): FinishedExport {
  const { format, facts, date, batches } = input;
  const stereo = format === "stereo";
  const included = input.rows.filter((row) => row.included);
  const tracks = included.filter((row) => !row.fixed);
  const several = !stereo && batches.length > 1;
  const names = batches.map((_, i) =>
    stemsBatchFileName(facts.name, date, i, batches.length),
  );
  const bytes = input.fileBytes.reduce((sum, size) => sum + size, 0);
  return {
    name: facts.name,
    tempo: facts.tempo,
    length: facts.length,
    format,
    fileName: stereo ? exportFileName(facts.name, date, "wav") : (names[0] ?? ""),
    zips: several
      ? batches.map((_, i) => ({
          name: names[i],
          size: formatExportSize(input.fileBytes[i]),
        }))
      : [],
    count: stereo ? tracks.length : included.length,
    size: formatExportSize(bytes),
    bars: input.bars,
    stripes: tracks.flatMap((row) =>
      row.color ? [{ color: row.color, lanes: row.lanes }] : [],
    ),
  };
}
