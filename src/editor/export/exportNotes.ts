import type { ErrorCode } from "../../analytics/errorCodes";
import { formatExportSize } from "./stemSelection";

/**
 * The words in the Export footer's one-line message slot (EXP-004). Pure, so
 * the dialog and its tests share one source for the copy.
 */

/** The in-browser budget for one ZIP, as the dialog says it. */
const LIMIT_TEXT = "2 GiB";

/** What the slot says when the song has no tracks, in either format. */
export const EMPTY_SONG_NOTE = "Add a track to export.";

export interface StemsNoteInput {
  /** How many tracks are on. */
  readonly tracks: number;
  /** How many ZIPs the selection comes as. */
  readonly zips: number;
  /** What all of them weigh together. */
  readonly bytes: number;
}

/** What the slot says before a stems export: why Export is off, or how the stems split. */
export function stemsNote({ tracks, zips, bytes }: StemsNoteInput): string {
  if (tracks === 0) return "Turn on at least one track to export stems.";
  if (zips > 1) {
    return (
      `${formatExportSize(bytes)} is over the ${LIMIT_TEXT} browser limit, so stems come as ` +
      `${zips} ZIPs in track order, each downloaded when ready.`
    );
  }
  return `Stems over ${LIMIT_TEXT} come as several ZIPs in track order. These fit in one.`;
}

/**
 * What the slot says before exporting a project with sounds it reports missing
 * (#78): the export goes ahead, and leaves out any of them that cannot load.
 * The editor's Missing sounds notice names them; this only says how many.
 */
export function missingSoundsNote(count: number): string {
  // Short enough for the one-line slot; the editor's notice names them.
  return `${count} missing ${count === 1 ? "sound" : "sounds"} may be left out.`;
}

/** `ZIP 1 is` or `ZIPs 1–2 are`: the first `done` ZIPs, told as downloaded. */
export function zipsAre(done: number): string {
  return done > 1 ? `ZIPs 1–${done} are` : "ZIP 1 is";
}

/** What Cancel leaves behind when some ZIPs had already been downloaded. */
export function stoppedNote(done: number, count: number): string {
  const which = done > 1 ? `ZIPs 1–${done}` : "ZIP 1";
  return `Stopped. ${which} of ${count} ${done > 1 ? "are" : "is"} in your downloads. Resume to print the rest.`;
}

export interface ZipFailureInput {
  /** The ZIP that failed, 1-based. */
  readonly zip: number;
  /** How many ZIPs were downloaded before it. */
  readonly done: number;
  readonly code: ErrorCode;
  /** What went wrong, for a failure with no wording of its own here. */
  readonly reason: string;
}

/** A failed ZIP in the framed alert: the bold lead, then what to do about it. */
export function zipFailure({ zip, done, code, reason }: ZipFailureInput): {
  readonly lead: string;
  readonly text: string;
} {
  const lead = `ZIP ${zip} failed:`;
  const kept = done > 0 ? ` ${zipsAre(done)} already in your downloads.` : "";
  if (code === "decode_failed" || code === "asset_missing") {
    const next = done > 0 ? "resume." : "try again.";
    return {
      lead,
      text: `a sound could not be loaded. Check your connection, then ${next}${kept}`,
    };
  }
  return { lead, text: `${reason}${kept}` };
}
