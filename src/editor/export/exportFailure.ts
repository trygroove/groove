// A failed export, as the dialog reports it (GRV-55).
//
// The render and the ZIP already say *why* they failed through a stable code
// (`OfflineRenderError`, `StemExportError`), and `exportStereoWav` /
// `exportStemsBatch` log `export_failed` for those. Two things happen only in
// the dialog: handing the finished file to the browser, which can be refused,
// and the one error report per failure, which needs the export's size and
// shape to be worth triaging. Both live here so the dialog's own code stays a
// call or two.

import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import { bucketOf } from "../../analytics/buckets";
import type { ErrorCode } from "../../analytics/errorCodes";
import { OfflineRenderError } from "../../audio/offlineSession";
import { StemExportError } from "../../export/stems/exportStems";
import { CodedError, reportError } from "../../monitoring/errorReporting";

/**
 * Hands a finished file to the browser. A browser that refuses it (downloads
 * blocked by policy, an object URL it will not create) throws, and that is a
 * `download_blocked` failure the producer can do something about.
 */
export function handOver(
  download: (file: Blob, fileName: string) => void,
  file: Blob,
  fileName: string,
): void {
  try {
    download(file, fileName);
  } catch (error) {
    throw new CodedError("download_blocked", "The browser refused the download", {
      cause: error,
    });
  }
}

/** Whether `error` carries its own code, and a message of ours. */
function isCoded(
  error: unknown,
): error is OfflineRenderError | StemExportError | CodedError {
  return (
    error instanceof OfflineRenderError ||
    error instanceof StemExportError ||
    error instanceof CodedError
  );
}

/** The stable code an export's failure carries; `internal` for anything uncoded. */
export function exportFailureCode(error: unknown): ErrorCode {
  return isCoded(error) ? error.code : "internal";
}

export interface ExportFailureReport {
  readonly error: unknown;
  readonly code: ErrorCode;
  readonly format: "stereo" | "stems";
  /** What the export was expected to weigh, in bytes. */
  readonly bytes: number;
  readonly trackCount: number;
  /** How many ZIPs a stems export is split into. */
  readonly zipCount: number;
  readonly analytics?: Analytics;
  readonly report?: typeof reportError;
}

/**
 * Reports one failed export: once to monitoring, with its size in buckets and
 * never a file, project or track name; and to analytics as `export_failed`
 * when the failure was the download's, since the render that came before it
 * reported itself completed. A cancelled export is not a failure.
 */
export function reportExportFailure(failure: ExportFailureReport): void {
  if (failure.code === "aborted") return;
  if (failure.code === "download_blocked") {
    (failure.analytics ?? defaultAnalytics).log("export_failed", {
      export_type: failure.format,
      error_code: failure.code,
      was_cancelled: false,
    });
  }
  // Only a coded error goes to monitoring as it is: its message is ours. An
  // uncoded one is reported by its code alone, since its text is not.
  const error = isCoded(failure.error)
    ? failure.error
    : new CodedError(failure.code, "The export failed");
  (failure.report ?? reportError)(error, {
    area: "export",
    fatal: false,
    code: failure.code,
    context: {
      export_type: failure.format,
      file_size_bucket: bucketOf("file_bytes", failure.bytes),
      track_count_bucket: bucketOf("track_count", failure.trackCount),
      zip_count: failure.format === "stems" ? Math.min(32, failure.zipCount) : undefined,
    },
  });
}
