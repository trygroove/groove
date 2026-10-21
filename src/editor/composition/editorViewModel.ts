import type { Asset, Clip, Instrument, Project, Track } from "../../domain/entities";
import type { PlacementId, TrackId } from "../../domain/ids";
import {
  BEATS_PER_BAR,
  barsBeatsSixteenthsToTicks,
  formatBarsBeatsSixteenths,
  TICKS_PER_QUARTER,
  ticksToBarsBeatsSixteenths,
} from "../../domain/time";
import type { SelectionState } from "../../selection";

/** How long a note auditioned from the instrument or the note editors sounds. */
export const AUDITION_DURATION_TICKS = TICKS_PER_QUARTER;

/**
 * Pure, framework-free derivations behind `EditorView`.
 *
 * `EditorView` is a composition root: it owns the session, the audio wiring,
 * and the layout, and every one of these is a plain function of the open
 * `Project` (plus, where noted, one piece of session or transport state). They
 * live here rather than as inline `createMemo` bodies so each can be unit
 * tested without rendering the editor; the component keeps a one-line memo
 * wrapper around each so reactivity is unchanged.
 *
 * Nothing here mutates a project — the operations that do (`applyTempo`,
 * `auditionInstrument`, `deleteSelection`) need the session's `dispatch` and
 * the audio graph, so they stay in the component.
 */

/** One tempo-labelled loop clip paired with the asset it resolves to. */
export interface LoopClipEntry {
  readonly clip: Clip;
  readonly asset: Asset | null;
}

/**
 * The packs this editing session has added on top of the ones the project
 * already depends on.
 *
 * `metadata.packDependencies` is *derived* from the assets a project uses
 * (`derivePackDependencies`), so it answers "which packs does this project
 * need to open?" — not "which packs has the user put on their shelf?". The
 * second is a new piece of project state and a new command, which is a domain
 * contract change and its own task (see the LOOP-013 follow-up); until that
 * lands, an added pack lives for the session, which is enough for the browser
 * to show it and for the user to work out of it.
 */
export function addedPackIds(
  project: Project | null,
  sessionPackIds: readonly string[],
): readonly string[] {
  // `In this project` (LIB-010): the derived dependencies plus the shelf.
  const fromProject = [
    ...(project?.metadata.packDependencies ?? []),
    ...(project?.metadata.addedPacks ?? []),
  ].map((dependency) => dependency.packId);
  return [...new Set([...fromProject, ...sessionPackIds])];
}

/**
 * The transport position as a musician reads it. Shows a 1-based bar:beat,
 * dropping the sixteenth fraction.
 */
export function playheadLabel(positionTicks: number): string {
  const bbs = formatBarsBeatsSixteenths(positionTicks);
  const [bars, beats] = bbs.split(":");
  return `${Number(bars) + 1}.${Number(beats) + 1}`;
}

/** The playhead's editable segments: a 1-based bar and a 1-based beat. */
export interface PlayheadSegments {
  readonly bar: number;
  readonly beat: number;
}

/** The transport position split into the playhead input's segments. */
export function playheadSegments(positionTicks: number): PlayheadSegments {
  const position = ticksToBarsBeatsSixteenths(positionTicks);
  return { bar: position.bars + 1, beat: position.beats + 1 };
}

/**
 * The segments a typed bar and beat settle on: whole numbers, the bar at least
 * 1 and the beat within the 4/4 bar. Null when either segment is not a number,
 * so an emptied field restores the current position rather than seeking to 0.
 */
export function normalizePlayheadSegments(
  bar: number,
  beat: number,
): PlayheadSegments | null {
  if (!Number.isFinite(bar) || !Number.isFinite(beat)) return null;
  return {
    bar: Math.max(1, Math.round(bar)),
    beat: Math.min(BEATS_PER_BAR, Math.max(1, Math.round(beat))),
  };
}

/** The tick a playhead position points at, the inverse of {@link playheadSegments}. */
export function playheadSegmentsToTicks(segments: PlayheadSegments): number {
  return barsBeatsSixteenthsToTicks({
    bars: segments.bar - 1,
    beats: segments.beat - 1,
  });
}

/**
 * The focused track in the editor's `SelectionState`, or null when focus is
 * something other than a track (or nothing at all).
 *
 * Track selection is UI-only state held in the shared PRD 9.2 selection model,
 * never in the project: `reconcileSelection` drops a track the project no
 * longer has, and {@link editedTrack} falls back to the first track from there.
 */
export function focusedTrackId(selection: SelectionState): TrackId | null {
  return selection.focus?.kind === "track" ? selection.focus.id : null;
}

/**
 * The track the editor is pointed at: the one selected in the mixer or the
 * arrangement, falling back to the project's first track when nothing is
 * selected yet — or when the selection names a track the project no longer has
 * (#228).
 *
 * The fallback is what makes every derivation below total: the editor always
 * edits *some* track while the project has one, so opening a project needs no
 * selection gesture first.
 */
export function editedTrack(
  project: Project | null,
  selectedTrackId: TrackId | null,
): Track | null {
  const tracks = project?.song.tracks ?? [];
  return (
    tracks.find((candidate) => candidate.id === selectedTrackId) ?? tracks[0] ?? null
  );
}

/**
 * The track `by` places from the edited one (-1 previous, +1 next), or null at
 * either end of the track list: selection stops at the ends rather than
 * wrapping, so holding the key against the last track leaves it selected.
 */
export function adjacentTrackId(
  project: Project | null,
  selectedTrackId: TrackId | null,
  by: -1 | 1,
): TrackId | null {
  const tracks = project?.song.tracks ?? [];
  const current = editedTrack(project, selectedTrackId);
  if (!current) return null;
  return tracks[tracks.indexOf(current) + by]?.id ?? null;
}

/**
 * The edited track when it is a drum machine, which gets the `LOOP-005` pad
 * panel instead of the sampler/synth panel. Following the selection rather
 * than searching the project for the first drum-machine track is the point of
 * #228: a project can hold several, and the one on screen is the one you
 * clicked.
 */
export function drumTrack(track: Track | null): Track | null {
  return track?.instrument?.kind === "drumMachine" ? track : null;
}

/** Every `sample`-kind asset the project carries. */
export function sampleAssets(project: Project | null): readonly Asset[] {
  return (project?.song.assets ?? []).filter((asset) => asset.kind === "sample");
}

/** The clip on the edited track, if it has one. */
export function editedClip(project: Project | null, track: Track | null): Clip | null {
  if (!project || !track) return null;
  return project.clips.find((c) => c.trackId === track.id) ?? null;
}

/** The edited track's instrument, and the audition note it plays. */
export function editedInstrument(track: Track | null): Instrument | null {
  return track?.instrument ?? null;
}

/**
 * Every tempo-labelled loop clip in the project, paired with its resolved
 * asset (or null when the asset is missing) — LOOP-006 renders one loop-info
 * panel per loop so a user can tell a tempo-following loop from a pitched
 * one-shot and read the alpha's stretch behaviour honestly.
 */
export function loopClips(project: Project | null): readonly LoopClipEntry[] {
  if (!project) return [];
  return project.clips.flatMap((c) => {
    if (c.content.kind !== "audioLoop") return [];
    const assetId = c.content.assetId;
    const asset = project.song.assets.find((a) => a.id === assetId) ?? null;
    return [{ clip: c, asset }];
  });
}

/** The name of the sample the edited track's sampler is loaded with. */
export function sampleName(project: Project | null, track: Track | null): string | null {
  const current = editedInstrument(track);
  if (current?.kind !== "sampler" || !current.assetId) return null;
  return project?.song.assets.find((asset) => asset.id === current.assetId)?.name ?? null;
}

/**
 * A synth or sampler track's note clip gets the CLP-03 piano roll instead of
 * the FND-009 step grid: both are tonal instruments (#496), and pitched notes
 * want two dimensions (pitch x time), which the 16-step grid cannot show. Only
 * a drum machine, whose lanes are pads rather than pitches, keeps the grid.
 *
 * Asked of a clip rather than of a track (`UI-001`): the sequence editor opens
 * the clip you double-clicked, which need not be the only one on its track.
 */
export function showPianoRoll(track: Track | null, clip: Clip | null): boolean {
  const kind = editedInstrument(track)?.kind;
  return (kind === "synth" || kind === "sampler") && clip?.content.kind === "notes";
}

/** A clip opened in the sequence editor, with the track it belongs to. */
export interface OpenedClip {
  readonly clip: Clip;
  readonly track: Track;
}

/**
 * The clip a placement points at (`UI-001`), or null when the placement is
 * gone — undone, deleted, or removed by a remote edit. Null is what closes the
 * sequence editor in that case, so it can never outlive what it is editing.
 */
export function openedClip(
  project: Project | null,
  placementId: PlacementId | null,
): OpenedClip | null {
  if (!project || !placementId) return null;
  const placement = project.song.placements.find(
    (candidate) => candidate.id === placementId,
  );
  if (!placement) return null;
  const clip = project.clips.find((candidate) => candidate.id === placement.clipId);
  const track = project.song.tracks.find(
    (candidate) => candidate.id === placement.trackId,
  );
  return clip && track ? { clip, track } : null;
}

/** The loop-info entry for a clip, when that clip is a tempo-labelled loop. */
export function loopEntryFor(
  project: Project | null,
  clip: Clip | null,
): LoopClipEntry | null {
  if (!clip) return null;
  return loopClips(project).find((entry) => entry.clip.id === clip.id) ?? null;
}

/**
/**
 * The track a sound dropped from the library, or inserted with the keyboard,
 * loads onto — the edited track, but only while it carries a sampler (#225).
 * Null when there is nothing to load into, so the surface can decline rather
 * than dispatch a transaction the command layer would refuse.
 */
export function samplerTrackId(track: Track | null): TrackId | null {
  return track?.instrument?.kind === "sampler" ? track.id : null;
}

/**
 * The track the instrument panel edits — whatever instrument it carries, or
 * none at all. The panel leads with the kind picker (#224), so gating this on
 * the kinds that have a sub-panel would leave a drum-machine track (whose own
 * panel `EditorView` mounts separately) with no way back off the drum machine.
 */
export function instrumentPanelTrackId(track: Track | null): TrackId | null {
  return track?.id ?? null;
}
