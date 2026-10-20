import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import type { ErrorCode } from "../../analytics/errorCodes";
import { CAPABILITY_MESSAGES } from "../../browser/capabilityMessages";
import Dialog from "../../components/Dialog";
import type { Project } from "../../domain/entities";
import { missingSoundCount } from "../../export/missingSounds";
import { StemExportError } from "../../export/stems/exportStems";
import type { reportError } from "../../monitoring/errorReporting";
import { systemClock } from "../../shared/clock";
import { useShortcuts } from "../../shortcuts";
import DownloadsRow from "./DownloadsRow";
import { downloadCards } from "./downloadCards";
import { downloadFile } from "./downloadFile";
import ExportDone from "./ExportDone";
import ExportFooter, { EXPORT_NOTE_ID } from "./ExportFooter";
import ExportTitleRow from "./ExportTitleRow";
import { estimateStereoBytes, exportFacts } from "./exportFacts";
import { exportFailureCode, handOver, reportExportFailure } from "./exportFailure";
import { missingSoundsNote, stemsNote, stoppedNote, zipFailure } from "./exportNotes";
import FormatCards, { type ExportFormat } from "./FormatCards";
import { finishedExport } from "./finishedExport";
import { formatBytes } from "./stemSelection";
import { exportStemsBatch, planStemsFiles } from "./stemsExport";
import { exportStereoWav, type StereoExportOptions } from "./stereoExport";
import TrackLanes from "./TrackLanes";
import { useTrackList } from "./useTrackList";
import "./ExportDialog.css";

export interface ExportDialogProps {
  /** The project as it is when Export is pressed; the render reads only that. */
  readonly project: () => Project;
  /**
   * The sounds the editor reports missing (#78). The export goes ahead without
   * any of them that cannot load, rather than failing, and says so first.
   */
  readonly missingAssetIds?: () => ReadonlySet<string>;
  readonly analytics?: Analytics;
  /** Test seams: the export itself, and how its file reaches the browser. */
  readonly exportWav?: typeof exportStereoWav;
  readonly exportStemsBatch?: typeof exportStemsBatch;
  readonly download?: typeof downloadFile;
  /** Where a failed export is reported (GRV-55); the app-wide boundary by default. */
  readonly reportError?: typeof reportError;
  onClose(): void;
}

type Phase =
  | { readonly kind: "choose" }
  | {
      readonly kind: "rendering";
      /** The ZIP being printed (0 for a stereo WAV) and how far along it is. */
      readonly batch: number;
      readonly fraction: number;
    }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly code: ErrorCode; readonly batch: number };

type Format = ExportFormat;

/** What a failed export tells the producer to do about it. */
export function failureMessage(code: ErrorCode, format: Format = "stereo"): string {
  if (code === "quota_exceeded" && format === "stems") {
    return "These stems came out over the 2 GiB export limit. Deselect a track and try again.";
  }
  switch (code) {
    case "decode_failed":
    case "asset_missing":
      return "A sound in this project could not be loaded. Check your connection and try again.";
    case "not_supported": {
      // The same words the editor's compatibility notice uses, so the two
      // never point the producer at different browsers.
      const { detail, action } = CAPABILITY_MESSAGES.offline_audio;
      return `${detail} ${action}`;
    }
    case "quota_exceeded":
      return "The song is too long to export as one WAV file. Shorten the arrangement and try again.";
    // GRV-55: the render, the ZIP and the download each fail in their own way.
    case "out_of_memory":
      return format === "stems"
        ? "Your browser ran out of memory. Close other tabs, or select fewer tracks, and try again."
        : "Your browser ran out of memory. Close other tabs and try again, or export stems instead.";
    case "render_failed":
      return "The render stopped partway. Try again; if it fails again, reload the page. Your edits are kept.";
    case "zip_batch_failed":
      return "The ZIP couldn't be put together. Try again.";
    case "download_blocked":
      return "Your browser blocked the download. Allow downloads for this site, then try again.";
    default:
      return "Something went wrong while rendering. Try again.";
  }
}

/**
 * The Export dialog (EXP-002, CF-021): choose a format, render, download.
 *
 * Stereo WAV renders the song as one file; Stems (ZIP) renders one aligned
 * 24-bit WAV per track and return plus a reference mix (EXP-003), for the
 * tracks the producer selects. Stems never block on size (EXP-004): a
 * selection over the budget is split, in track order, into ZIPs that each fit,
 * and each ZIP is rendered, downloaded and released before the next starts.
 * While a render runs the dialog shows its progress beside a Cancel button,
 * and closing the dialog cancels it too, so a render never outlives the
 * surface that started it. A file is downloaded only once it has rendered
 * whole: a cancelled or failed ZIP never reaches the browser's downloads, and
 * the ZIPs before it stay there.
 */
export default function ExportDialog(props: ExportDialogProps): JSX.Element {
  const [phase, setPhase] = createSignal<Phase>({ kind: "choose" });
  const [format, setFormat] = createSignal<Format>("stereo");
  const facts = createMemo(() => exportFacts(props.project()));
  const list = useTrackList({
    project: props.project,
    editable: () => format() === "stems" && phase().kind !== "rendering",
    stereo: () => format() === "stereo",
  });
  const rendering = () => {
    const current = phase();
    return current.kind === "rendering" ? current : null;
  };
  const stamp = new Date(systemClock.now());
  // With no track chosen there is nothing to export: the reference mix alone
  // is not a ZIP anyone can make, so the plan is empty rather than one file.
  const plan = createMemo(() =>
    list.trackIds().length === 0 ? [] : planStemsFiles(props.project(), list.trackIds()),
  );
  const stereoBytes = createMemo(() => estimateStereoBytes(props.project()));
  /** How many files this export makes: the ZIPs, or the one WAV. */
  const fileCount = () => (format() === "stems" ? plan().length : 1);
  /** The ZIPs already downloaded, in order, and where Export picks up again. */
  const [got, setGot] = createSignal(0);
  /** The size of each file already downloaded, for the finished screen. */
  const [written, setWritten] = createSignal<readonly number[]>([]);
  const [resumeFrom, setResumeFrom] = createSignal(0);
  /** What Cancel said, until the next export or edit. */
  const [stopped, setStopped] = createSignal("");
  const [doneHeight, setDoneHeight] = createSignal(0);
  const [scrollTo, setScrollTo] = createSignal<string | null>(null);
  const batchRows = createMemo(() =>
    format() === "stems" ? plan().map((batch) => batch.rowIds) : [],
  );
  const printing = () => {
    const current = rendering();
    return current && { batchIndex: current.batch, fraction: current.fraction };
  };
  const failedBatch = () => {
    const current = phase();
    return current.kind === "failed" ? current.batch : null;
  };
  const cards = createMemo(() => {
    const now = printing();
    return downloadCards({
      format: format(),
      projectName: props.project().metadata.name,
      date: stamp,
      batches: plan(),
      stereoBytes: stereoBytes(),
      progress: {
        done: got(),
        printing: now && { index: now.batchIndex, fraction: now.fraction },
        failed: failedBatch(),
      },
    });
  });
  const noTracks = () => format() === "stems" && list.trackIds().length === 0;
  let root!: HTMLDivElement;
  /** Keys reach the list only while it has focus, so a click hands it focus. */
  const focusList = () =>
    queueMicrotask(() => root.querySelector<HTMLElement>('[role="listbox"]')?.focus());
  // The row the keys are on stays in view as they move it.
  createEffect(
    () => list.focusId(),
    () => {
      const active = root
        .querySelector('[role="listbox"]')
        ?.getAttribute("aria-activedescendant");
      if (active) document.getElementById(active)?.scrollIntoView?.({ block: "nearest" });
    },
  );
  let controller: AbortController | undefined;
  let startedAt = 0;

  const cancel = () => controller?.abort();
  const close = () => {
    cancel();
    props.onClose();
  };
  onCleanup(cancel);

  /** Changing the format or the selection starts the export over. */
  const startOver = () => {
    setGot(0);
    setWritten([]);
    setResumeFrom(0);
    setStopped("");
    if (phase().kind === "failed") setPhase({ kind: "choose" });
  };
  // Only the selection is a dependency: a phase change must not start over.
  // The phase is read once, knowingly, under `untrack` (#844).
  createEffect(
    () => list.trackIds().join(","),
    () =>
      untrack(() => {
        if (phase().kind !== "rendering") startOver();
      }),
  );

  // Escape clears the list's picks first, and closes only when there were none.
  useShortcuts({
    handlers: () => ({
      ...list.handlers(),
      "view.close_surface": {
        run: () => {
          if (!list.run("clear_picks")) close();
        },
      },
    }),
    contexts: list.contexts,
  });

  async function start(): Promise<void> {
    const current = new AbortController();
    controller = current;
    const stems = format() === "stems";
    const batches = plan();
    const count = stems ? batches.length : 1;
    if (resumeFrom() === 0) {
      setGot(0);
      setWritten([]);
      startedAt = systemClock.now();
    }
    setStopped("");
    let index = resumeFrom();
    try {
      for (; index < count; index++) {
        setPhase({ kind: "rendering", batch: index, fraction: 0 });
        if (stems) setScrollTo(batches[index].rowIds[0] ?? null);
        const options: StereoExportOptions = {
          signal: current.signal,
          analytics: props.analytics,
          missingAssetIds: props.missingAssetIds?.(),
          onProgress: (fraction) => {
            if (!current.signal.aborted) {
              setPhase({ kind: "rendering", batch: index, fraction });
            }
          },
        };
        const file = stems
          ? await (props.exportStemsBatch ?? exportStemsBatch)(props.project(), {
              ...options,
              batch: batches[index],
              count,
              startedAt,
              date: stamp,
              trackIds: list.trackIds(),
            })
          : await (props.exportWav ?? exportStereoWav)(props.project(), options);
        // A ZIP that finished after Cancel is not downloaded; the next ZIP's
        // call sees the aborted signal and ends the export as cancelled.
        if (current.signal.aborted) continue;
        handOver(props.download ?? downloadFile, file.blob, file.fileName);
        setWritten((sizes) => [...sizes.slice(0, index), file.blob.size]);
        setGot(index + 1);
      }
      if (current.signal.aborted) throw new StemExportError("aborted", "cancelled");
      // The finished screen takes the dialog's place, at least at the dialog's size;
      // a taller screen (a one-track song) grows the dialog rather than clipping.
      setDoneHeight(root.closest(".dialog")?.getBoundingClientRect().height ?? 0);
      list.setFocused(false);
      setPhase({ kind: "done" });
    } catch (error) {
      if (controller !== current) return;
      const code = exportFailureCode(error);
      reportExportFailure({
        error,
        code,
        format: stems ? "stems" : "stereo",
        bytes: stems ? (batches[index]?.expectedBytes ?? 0) : stereoBytes(),
        trackCount: stems ? list.trackIds().length : props.project().song.tracks.length,
        zipCount: count,
        analytics: props.analytics,
        report: props.reportError,
      });
      setResumeFrom(got());
      if (code === "aborted" && got() > 0) setStopped(stoppedNote(got(), count));
      setPhase(
        code === "aborted" ? { kind: "choose" } : { kind: "failed", code, batch: index },
      );
    } finally {
      if (controller === current) controller = undefined;
    }
  }

  const failed = () => {
    const current = phase();
    return current.kind === "failed" ? current : null;
  };
  /** The other format of the same song, from the finished screen. */
  const exportOther = () => {
    list.pick("clear");
    setFormat(format() === "stereo" ? "stems" : "stereo");
    startOver();
    setPhase({ kind: "choose" });
  };
  const finished = createMemo(() =>
    finishedExport({
      format: format(),
      facts: facts(),
      date: stamp,
      rows: list.rows(),
      batches: plan(),
      fileBytes: written(),
      bars: list.bars(),
    }),
  );
  /** What the stems are expected to weigh, which the footer shows. */
  const stemsBytes = () => plan().reduce((sum, batch) => sum + batch.expectedBytes, 0);
  const sizeText = () => {
    if (format() === "stereo") return `${formatBytes(stereoBytes())} · 1 file`;
    if (plan().length === 0) return "Nothing to export";
    const files = plan().reduce((sum, batch) => sum + batch.paths.length, 0);
    return `${formatBytes(stemsBytes())} · ${files} ${files === 1 ? "file" : "files"}`;
  };
  /** What is printing, `ZIP 2 of 3 · bar 79 of 160`, and how far along the whole is. */
  const printingText = () => {
    const current = rendering();
    if (!current) return null;
    const count = fileCount();
    const bars = list.bars();
    const bar = Math.max(1, Math.ceil(current.fraction * bars));
    const zip =
      format() === "stems" && count > 1 ? `ZIP ${current.batch + 1} of ${count} · ` : "";
    return {
      text: `${zip}bar ${bar} of ${bars}`,
      fraction: (current.batch + current.fraction) / count,
    };
  };
  /** How many of the project's sounds are reported missing. */
  const missing = () => missingSoundCount(props.project(), props.missingAssetIds?.());
  /** The note under the footer: why Export is off, what is missing, how the stems split, or that it is done. */
  const noteText = () => {
    if (rendering()) {
      return got() > 0 ? `${got()} of ${fileCount()} in your downloads.` : "";
    }
    if (stopped()) return stopped();
    if (failed()) return "";
    // Why Export is off comes first; then the sounds the file may lack.
    const tracks = list.trackIds().length;
    if (missing() > 0 && (format() !== "stems" || tracks > 0)) {
      return missingSoundsNote(missing());
    }
    if (format() !== "stems") return "";
    return stemsNote({
      tracks,
      zips: plan().length,
      // The bound the split was made on, so "over the limit" is always true.
      bytes: plan().reduce((sum, batch) => sum + batch.bytes, 0),
    });
  };
  /** A failure of one ZIP of several names it; any other keeps the one-file wording. */
  const alertText = () => {
    const current = failed();
    if (!current) return { lead: "", text: "" };
    const reason = failureMessage(current.code, format());
    if (format() !== "stems" || fileCount() < 2) return { lead: "", text: reason };
    return zipFailure({
      zip: current.batch + 1,
      done: got(),
      code: current.code,
      reason,
    });
  };

  return (
    <Dialog label="Export" class="export-shell" flush onClose={close}>
      <Show
        when={phase().kind !== "done"}
        fallback={
          <ExportDone
            finished={finished()}
            heightPx={doneHeight()}
            onBack={close}
            onAgain={exportOther}
          />
        }
      >
        <ExportTitleRow facts={facts()} />
        <FormatCards
          value={format()}
          disabled={phase().kind === "rendering"}
          onChange={(next) => {
            list.pick("clear");
            setFormat(next);
            startOver();
          }}
        />
        <div ref={root}>
          <TrackLanes
            rows={list.rows()}
            bars={list.bars()}
            focusId={list.focusId()}
            readOnly={format() === "stereo"}
            disabled={phase().kind === "rendering"}
            maxHeightPx={250}
            batches={batchRows()}
            doneBatches={Array.from({ length: got() }, (_, i) => i)}
            idle={phase().kind === "choose"}
            printing={printing()}
            scrollToRowId={scrollTo()}
            onRowClick={(index, modifiers) => {
              list.click(index, modifiers);
              focusList();
            }}
            onPickAction={list.pick}
            onFocusChange={list.setFocused}
          />
        </div>
        <DownloadsRow cards={cards()} />
        <ExportFooter
          format={format()}
          size={sizeText()}
          zipCount={plan().length}
          printing={printingText()}
          note={noteText()}
          alert={alertText().text}
          alertLead={alertText().lead}
        >
          <Show
            when={rendering()}
            fallback={
              <>
                <button type="button" class="export-secondary" onClick={close}>
                  Close
                </button>
                <button
                  type="button"
                  class="export-primary"
                  aria-disabled={noTracks() ? "true" : undefined}
                  aria-describedby={noTracks() ? EXPORT_NOTE_ID : undefined}
                  onClick={() => {
                    // Off stays focusable, so its reason is read out; it does nothing.
                    if (!noTracks()) void start();
                  }}
                >
                  {resumeFrom() > 0 ? `Resume from ZIP ${resumeFrom() + 1}` : "Export"}
                </button>
              </>
            }
          >
            <button
              type="button"
              class="export-secondary"
              onClick={(event) => {
                // Cancel takes Export's place under the pointer, so a double click on
                // Export lands its second click here (`detail` 2). That is not a choice
                // to cancel; a deliberate click is a fresh one (`detail` 1).
                if (event.detail > 1) return;
                cancel();
              }}
            >
              Cancel
            </button>
          </Show>
        </ExportFooter>
      </Show>
    </Dialog>
  );
}
