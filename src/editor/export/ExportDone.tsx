import type { JSX } from "@solidjs/web";
import { For, onSettled, Show } from "solid-js";
import "./ExportDone.css";
import ExportReadout from "./ExportReadout";
import type { FinishedExport } from "./finishedExport";
import Sleeve from "./Sleeve";

/**
 * The finished screen of the Release design (EXP-004): the dialog's contents give
 * way to the sleeve on the left and, on the right, that the export is complete,
 * where the files are, what they hold, and what to do next. "Back to the song"
 * is the primary action and takes focus. Nothing here edits the project.
 */

export interface ExportDoneProps {
  readonly finished: FinishedExport;
  /** The dialog's height when the export finished: the least this screen takes, so the dialog does not shrink. */
  readonly heightPx?: number;
  onBack(): void;
  /** Export the other format of the same song. */
  onAgain(): void;
}

/** Where the files are and what to do with them. */
function whereText(finished: FinishedExport): string {
  if (finished.format === "stereo") {
    return `${finished.fileName} is in your downloads. Send it to anyone. It plays everywhere.`;
  }
  const line = "Every stem starts at bar 1, so they line up.";
  if (finished.zips.length > 1) {
    return `${finished.zips.length} ZIPs are in your downloads. Unzip them into one folder and drop it into any DAW. ${line}`;
  }
  return `${finished.fileName} is in your downloads. Drop the folder into any DAW. ${line}`;
}

export default function ExportDone(props: ExportDoneProps): JSX.Element {
  let back!: HTMLButtonElement;
  onSettled(() => back.focus());
  const stereo = () => props.finished.format === "stereo";
  const several = () => props.finished.zips.length > 1;
  return (
    <div
      class="export-done"
      style={props.heightPx ? { "min-height": `${props.heightPx}px` } : undefined}
    >
      <Sleeve
        stripes={props.finished.stripes}
        bars={props.finished.bars}
        name={props.finished.name}
        meta={`${props.finished.tempo} · ${props.finished.length}`}
      />
      <div class="export-out">
        <output class="export-label" aria-live="polite">
          Export complete
        </output>
        <h3>{props.finished.name} is out.</h3>
        <p>{whereText(props.finished)}</p>
        <div class="export-stats">
          <ExportReadout label="Length">{props.finished.length}</ExportReadout>
          <ExportReadout label={stereo() ? "Tracks in the mix" : "Stems"}>
            {props.finished.count}
          </ExportReadout>
          <ExportReadout label="Size">{props.finished.size}</ExportReadout>
          <ExportReadout label={several() ? "ZIPs" : "Bars"}>
            {several() ? props.finished.zips.length : props.finished.bars}
          </ExportReadout>
        </div>
        <Show when={several()}>
          <ul class="export-zips" aria-label="ZIPs">
            <For each={props.finished.zips}>
              {(zip) => (
                <li>
                  <span aria-hidden="true">{"✓"}</span>
                  {zip.name}
                  <em>{zip.size}</em>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="export-done-actions">
          <button type="button" class="export-primary" ref={back} onClick={props.onBack}>
            Back to the song
          </button>
          <button type="button" class="export-secondary" onClick={props.onAgain}>
            {stereo() ? "Export stems too" : "Export a mix too"}
          </button>
        </div>
        <div class="export-next">
          <b>It's still your project.</b> Exporting changed nothing. Keep working on it,
          and export again whenever you like.
        </div>
      </div>
    </div>
  );
}
