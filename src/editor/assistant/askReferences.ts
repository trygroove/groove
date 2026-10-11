/**
 * What a question's options mean in the editor (GRV-42): the part of the
 * song an option is about (`ref`), shown while it is hovered and selected
 * when it is picked, and the sound it lets the producer hear (`sound`).
 *
 * Pure functions of the project: the editor turns them into a highlight on
 * the arrangement, a selection, an audition or a session preview
 * (`EditorView`'s {@link AskEditorLink}).
 */
import type { AskReference, AskSound } from "../../assistant/ask";
import { validateProposal } from "../../assistant/proposal";
import { ASSISTANT_TOOLSET_VERSION } from "../../assistant/tools";
import type { RawCommandInput } from "../../commands";
import type { Clip, NoteTrigger, Project, Track } from "../../domain/entities";
import type { TrackId } from "../../domain/ids";
import { TICKS_PER_BAR } from "../../domain/time";
import {
  type ArrangementBand,
  type ArrangementSelection,
  clipsSelection,
  placementsTouchedBy,
} from "../../selection";

/** What a question's options can do in the editor. */
export interface AskEditorLink {
  /** Shows what an option is about while it is hovered; `null` puts it away. */
  highlight(ref: AskReference | null): void;
  /** Selects what a picked option is about. */
  select(ref: AskReference): void;
  /** Whether a sound can be heard in this project now. */
  canHear(sound: AskSound): boolean;
  /**
   * Starts hearing a sound, in place of any other. `gesture` says a key or a
   * click asked for it, so it may start sound; a hover alone may not until
   * the page has been interacted with.
   */
  hear(sound: AskSound, gesture?: boolean): void;
  /** Stops whatever {@link hear} started. */
  stopHearing(): void;
  /** What a reference names, as an option's chip says it, or null when it is gone. */
  describe(ref: AskReference): string | null;
}

/** A bar range as a chip says it: "Bar 5" or "Bars 13–16". */
export function barsLabel(ref: Extract<AskReference, { kind: "bars" }>): string {
  return ref.startBar === ref.endBar
    ? `Bar ${ref.startBar}`
    : `Bars ${ref.startBar}–${ref.endBar}`;
}

/** The one entry `matches` picks out, or undefined for none or several. */
function only<T>(items: readonly T[], matches: (item: T) => boolean): T | undefined {
  const found = items.filter(matches);
  return found.length === 1 ? found[0] : undefined;
}

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The track a question's `trackId` points at. The model is given each track's
 * ID, but a drum machine's pads come with IDs and names of their own, and an
 * option about "the kick" names the kick pad as often as the track it is on
 * (GRV-42 QA: a "Kick (BD)" option highlighted nothing). So a pad's ID
 * resolves to the track that has it, and a name that picks out exactly one
 * track (or one pad) resolves to that track. Anything else is no track.
 */
export function resolveTrack(project: Project, trackId: string): Track | undefined {
  const { tracks } = project.song;
  const padsOf = (track: Track) =>
    track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
  return (
    tracks.find((track) => track.id === trackId) ??
    tracks.find((track) => padsOf(track).some((pad) => pad.id === trackId)) ??
    only(tracks, (track) => sameName(track.name, trackId)) ??
    only(tracks, (track) => padsOf(track).some((pad) => sameName(pad.name, trackId)))
  );
}

/**
 * The clip a question's `clipId` points at: the clip, or the clip of a
 * placement whose ID was given instead (the model sees both), or the one clip
 * with that name.
 */
export function resolveClip(project: Project, clipId: string): Clip | undefined {
  const byId = project.clips.find((clip) => clip.id === clipId);
  if (byId) return byId;
  const placement = project.song.placements.find((candidate) => candidate.id === clipId);
  if (placement) return project.clips.find((clip) => clip.id === placement.clipId);
  return only(project.clips, (clip) => sameName(clip.name, clipId));
}

/** What a reference names in `project`, or null when the project has no such thing. */
export function referenceLabel(project: Project, ref: AskReference): string | null {
  switch (ref.kind) {
    case "track": {
      const track = resolveTrack(project, ref.trackId);
      return track ? `Track ${track.name}` : null;
    }
    case "clip": {
      const clip = resolveClip(project, ref.clipId);
      return clip ? `Clip ${clip.name}` : null;
    }
    case "bars":
      return barsLabel(ref);
  }
}

/** Where a track's highlight ends: past the last clip, with room to spare. */
function songEnd(project: Project): number {
  const lastEnd = Math.max(
    0,
    ...project.song.placements.map((p) => p.startTicks + p.durationTicks),
  );
  return lastEnd + 4 * TICKS_PER_BAR;
}

/** The bars a bar range covers, in ticks, with an exclusive end. */
function barsSpan(ref: Extract<AskReference, { kind: "bars" }>) {
  return {
    startTicks: (ref.startBar - 1) * TICKS_PER_BAR,
    endTicks: ref.endBar * TICKS_PER_BAR,
  };
}

/**
 * The arrangement bands that show a reference: a track's whole row, every
 * placement of a clip, or a bar range across every track. None for something
 * the project does not have.
 */
export function referenceBands(project: Project, ref: AskReference): ArrangementBand[] {
  const trackIds = project.song.tracks.map((track) => track.id);
  switch (ref.kind) {
    case "track": {
      const track = resolveTrack(project, ref.trackId);
      return track
        ? [{ trackIds: [track.id], startTicks: 0, endTicks: songEnd(project) }]
        : [];
    }
    case "clip": {
      const clipId = resolveClip(project, ref.clipId)?.id;
      return project.song.placements
        .filter((placement) => placement.clipId === clipId)
        .map((placement) => ({
          trackIds: [placement.trackId],
          startTicks: placement.startTicks,
          endTicks: placement.startTicks + placement.durationTicks,
        }));
    }
    case "bars":
      return trackIds.length > 0 ? [{ trackIds, ...barsSpan(ref) }] : [];
  }
}

/** What picking an option selects: a track to point the editor at, and clips. */
export interface ReferenceSelection {
  readonly trackId: TrackId | null;
  readonly arrangement: ArrangementSelection | null;
}

/**
 * What picking a reference selects. A track is pointed at; a clip selects
 * every placement of it and points at its track; a bar range selects the
 * clips it touches, as a drag band over those bars would, since the
 * arrangement has no range selection.
 */
export function referenceSelection(
  project: Project,
  ref: AskReference,
): ReferenceSelection {
  switch (ref.kind) {
    case "track":
      return {
        trackId: resolveTrack(project, ref.trackId)?.id ?? null,
        arrangement: null,
      };
    case "clip": {
      const clip = resolveClip(project, ref.clipId);
      const placements = project.song.placements.filter(
        (placement) => placement.clipId === clip?.id,
      );
      return {
        trackId: clip?.trackId ?? null,
        arrangement: clipsSelection(placements.map((placement) => placement.id)),
      };
    }
    case "bars": {
      const band: ArrangementBand = {
        trackIds: project.song.tracks.map((track) => track.id),
        ...barsSpan(ref),
      };
      return {
        trackId: null,
        arrangement: clipsSelection(placementsTouchedBy(band, project)),
      };
    }
  }
}

/** The note a track's audition plays: middle C, or a drum machine's first pad. */
export function auditionTrigger(track: Track): NoteTrigger | null {
  const instrument = track.instrument;
  if (!instrument) return null;
  if (instrument.kind === "drumMachine") {
    const pad = instrument.pads[0];
    return pad ? { kind: "pad", padId: pad.id } : null;
  }
  return { kind: "pitch", pitch: 60 };
}

/**
 * The commands an option's preview would show, validated against `project`
 * exactly as a proposal is (GRV-4), or null when they could not apply. Nothing
 * here applies them.
 */
export function previewCommands(
  project: Project,
  sound: Extract<AskSound, { kind: "preview" }>,
): readonly RawCommandInput[] | null {
  const validation = validateProposal(project, {
    baseRevision: project.metadata.revision,
    toolsetVersion: ASSISTANT_TOOLSET_VERSION,
    calls: sound.calls,
  });
  return validation.ok ? validation.proposal.commands : null;
}

/** Whether `sound` can be heard in `project`. */
export function canHearIn(project: Project, sound: AskSound): boolean {
  if (sound.kind === "preview") return previewCommands(project, sound) !== null;
  const track = resolveTrack(project, sound.trackId);
  return track !== undefined && auditionTrigger(track) !== null;
}
