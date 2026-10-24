import {
  CONTROL_PARTS,
  type ControlAddress,
  controlAddress,
  MASTER_ENTITY,
  SONG_ENTITY,
} from "../../commands/controlAddress";
import type { Project, Track } from "../../domain/entities";
import type { PadId, PlacementId, TrackId } from "../../domain/ids";
import type { EditorViewName } from "./editorViews";

/**
 * Where a control lives in the editor (`UI-004`, #850): which view shows it,
 * which track has to be selected for it to be on screen, and — for a clip's
 * notes — which placement's clip the sequence view (`2`) edits.
 *
 * A pure function of the project and the address, so what a reveal will do is
 * testable without rendering anything. `EditorView` applies the home and then
 * focuses the registered element.
 */
export interface ControlHome {
  /** The view to show, or `null` when every view shows it (the header's tempo). */
  readonly view: EditorViewName | null;
  /** The track to select, or `null` to leave the selection alone. */
  readonly trackId: TrackId | null;
  /** The drum pad to select on that track. */
  readonly padId: PadId | null;
  /**
   * The placement whose clip the sequence view edits; `undefined` leaves the
   * clip `2` edits as it is.
   */
  readonly placementId: PlacementId | undefined;
  /**
   * What to focus when nothing shows the address itself in this layout: the
   * nearest owner, the track's header. `null` when there is no owner track.
   */
  readonly fallback: ControlAddress | null;
}

/** Track-owned keys that live in the mixer strip. */
const MIXER_KEYS = new Set(["volume", "pan"]);
/** Track-owned keys every view shows, on the track's header, rail entry or strip. */
const EVERY_VIEW_TRACK_KEYS = new Set<string>([
  CONTROL_PARTS.header,
  CONTROL_PARTS.muted,
  CONTROL_PARTS.soloed,
]);
/** Song keys the editor header shows in every view. */
const HEADER_SONG_KEYS = new Set([
  "tempo",
  "swing",
  CONTROL_PARTS.name,
  CONTROL_PARTS.play,
  CONTROL_PARTS.export,
]);

export function controlHome(project: Project, address: ControlAddress): ControlHome {
  const { entity, param } = address;
  const stay = (view: EditorViewName | null, track: Track | null = null): ControlHome =>
    home(view, track, null, undefined);

  if (entity === SONG_ENTITY) {
    // The dock's tiles are on every view (GRV-190).
    if (HEADER_SONG_KEYS.has(param) || param.startsWith("view.")) return stay(null);
    return stay("arrangement");
  }
  if (entity === MASTER_ENTITY) return stay("mixer");

  const track = project.song.tracks.find((candidate) => candidate.id === entity);
  if (track) return trackHome(track, param);

  if (project.song.returns.some((bus) => bus.id === entity)) return stay("mixer");

  const deviceTrack = project.song.tracks.find((candidate) =>
    candidate.devices.some((device) => device.id === entity),
  );
  if (deviceTrack) return stay("instrument", deviceTrack);
  // A master or return device: their chains are in the mixer.
  if (
    project.song.master.devices.some((device) => device.id === entity) ||
    project.song.returns.some((bus) => bus.devices.some((device) => device.id === entity))
  ) {
    return stay("mixer");
  }

  for (const candidate of project.song.tracks) {
    if (candidate.instrument?.kind !== "drumMachine") continue;
    const pad = candidate.instrument.pads.find((entry) => entry.id === entity);
    if (pad) return home("instrument", candidate, pad.id, undefined);
  }

  const clip = project.clips.find((candidate) => candidate.id === entity);
  if (clip) {
    const owner = project.song.tracks.find((candidate) => candidate.id === clip.trackId);
    const placement = project.song.placements.find(
      (candidate) => candidate.clipId === clip.id,
    );
    // The notes (and the length beside them) are edited in the sequence view,
    // which edits a placement's clip. An unplaced clip has nothing for `2` to
    // open, so it lands on its track in the arrangement instead.
    const editsInSequence =
      param === CONTROL_PARTS.notes || param === CONTROL_PARTS.length;
    return editsInSequence && placement
      ? home("sequence", owner ?? null, null, placement.id)
      : stay("arrangement", owner ?? null);
  }

  const placement = project.song.placements.find((candidate) => candidate.id === entity);
  if (placement) {
    const owner = project.song.tracks.find(
      (candidate) => candidate.id === placement.trackId,
    );
    return stay("arrangement", owner ?? null);
  }

  // Nothing in the project owns it (a deleted entity's address): the
  // arrangement, rather than nothing at all.
  return stay("arrangement");
}

function trackHome(track: Track, param: string): ControlHome {
  if (MIXER_KEYS.has(param) || param.startsWith("sendLevel.")) {
    return home("mixer", track, null, undefined);
  }
  if (EVERY_VIEW_TRACK_KEYS.has(param)) return home(null, track, null, undefined);
  if (param === CONTROL_PARTS.arrangement) {
    return home("arrangement", track, null, undefined);
  }
  // Its instrument, sample, pads, devices, and every instrument parameter.
  return home("instrument", track, null, undefined);
}

function home(
  view: EditorViewName | null,
  track: Track | null,
  padId: PadId | null,
  placementId: PlacementId | undefined,
): ControlHome {
  return {
    view,
    trackId: track?.id ?? null,
    padId,
    placementId,
    fallback: track ? controlAddress(track.id, CONTROL_PARTS.header) : null,
  };
}

/**
 * What a reveal focuses inside a registered part: the part itself when it
 * takes focus, else its slider, else the first thing in it that does. A
 * `FillSlider` leads with its value field, but the slider is the control.
 */
const FOCUS_ORDER = [
  'input[type="range"]:not(:disabled)',
  'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
];

export function focusTargetOf(element: HTMLElement): HTMLElement {
  if (element.matches(FOCUS_ORDER[1])) return element;
  for (const selector of FOCUS_ORDER) {
    const found = element.querySelector<HTMLElement>(selector);
    if (found) return found;
  }
  return element;
}

/** Scrolls a registered part into view and focuses it. */
export function revealElement(element: HTMLElement): void {
  // jsdom implements neither scrolling nor `scrollIntoView`.
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  const target = focusTargetOf(element);
  // A part with nothing focusable inside (a canvas-drawn region) still takes
  // focus, so the keyboard lands where the eye is sent.
  if (target === element && !element.hasAttribute("tabindex")) element.tabIndex = -1;
  target.focus({ preventScroll: true });
}
