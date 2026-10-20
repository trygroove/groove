import { render } from "@solidjs/web";
import { OfflineRenderError } from "~/audio/offlineRenderer";
import type { Project } from "~/domain/entities";
import { createReferenceProject } from "~/domain/fixtures";
import ExportDialog from "~/editor/export/ExportDialog";
import type { StemsBatchRequest } from "~/editor/export/stemsExport";
import { StemExportError } from "~/export/stems/exportStems";
import ShortcutRoot from "~/shortcuts/ShortcutRoot";

/**
 * The browser half of the Export dialog's layout specs (EXP-004): mounts the
 * real dialog over the real app styles with an export the test drives by hand,
 * so a ten-minute, fifty-track project can be "rendering", "failed" or
 * "complete" without rendering a second of audio. The dev server serves this
 * module by path and the spec imports it into the page.
 */

export type ProjectKind = "few" | "fits" | "over";

interface Pending {
  readonly onProgress?: (fraction: number) => void;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const blob = () => new Blob([new Uint8Array([1])]);

function projectFor(kind: ProjectKind, title?: string): Project {
  const base =
    kind === "few"
      ? createReferenceProject({ trackCount: 7, minutes: 0.5, placementCount: 28 })
      : kind === "fits"
        ? createReferenceProject({ trackCount: 18, minutes: 4, placementCount: 400 })
        : createReferenceProject();
  const name = title ?? (kind === "over" ? "Long Way Home" : "Night Bus");
  return { ...base, metadata: { ...base.metadata, name } };
}

let pending: Pending | null = null;
let dispose: (() => void) | null = null;
const downloads: string[] = [];

function start(
  onProgress: ((fraction: number) => void) | undefined,
  signal: AbortSignal | undefined,
  fileName: string,
): Promise<{ blob: Blob; fileName: string }> {
  return new Promise((resolve, reject) => {
    pending = { onProgress, resolve: () => resolve({ blob: blob(), fileName }), reject };
    // As the real export does: an abort ends it as cancelled.
    signal?.addEventListener("abort", () =>
      reject(new StemExportError("aborted", "cancelled")),
    );
  });
}

export function mountExportDialog(kind: ProjectKind, title?: string): void {
  unmountExportDialog();
  downloads.length = 0;
  const project = projectFor(kind, title);
  const host = document.createElement("div");
  document.body.append(host);
  const remove = render(
    () => (
      // A scope needs the app's controller above it (GRV-186).
      <ShortcutRoot>
        <ExportDialog
          project={() => project}
          exportWav={
            ((
              _project: Project,
              options: { onProgress?: (f: number) => void; signal?: AbortSignal },
            ) => start(options.onProgress, options.signal, "mix.wav")) as never
          }
          exportStemsBatch={
            ((_project: Project, request: StemsBatchRequest) =>
              start(
                request.onProgress,
                request.signal,
                `zip ${request.batch.index + 1}`,
              )) as never
          }
          download={(_blob, fileName) => void downloads.push(fileName)}
          onClose={unmountExportDialog}
        />
      </ShortcutRoot>
    ),
    host,
  );
  dispose = () => {
    remove();
    host.remove();
  };
}

export function unmountExportDialog(): void {
  dispose?.();
  dispose = null;
  pending = null;
}

/** Reports `fraction` of the file being printed. */
export function progress(fraction: number): void {
  pending?.onProgress?.(fraction);
}

/** Finishes the file being printed. */
export function finish(): void {
  pending?.resolve();
}

/** Fails the file being printed as an unloadable sound. */
export function fail(): void {
  pending?.reject(new OfflineRenderError("decode_failed", "bad asset"));
}

export function downloaded(): readonly string[] {
  return downloads;
}
