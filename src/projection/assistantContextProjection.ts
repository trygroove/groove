import type { Instrument, Project, Track } from "../domain/entities";
import type { SelectionScope, SelectionState } from "../selection/types";
import { fingerprintOf } from "./fingerprint";
import { type AssistantSelectedNotes, selectedNotes } from "./selectedNotes";

/**
 * The assistant's project context (PRD section 9.8).
 *
 * "Project analysis produces a compact, serializable context rather than
 * sending the full persistence document by default." This is that compact
 * context: track/section summaries and counts, never a full note-by-note
 * dump of the project, a Firestore document, or provider-specific objects.
 * The one place notes appear is `selectedNotes`: the raw events of the
 * current selection and nothing outside it (ADR 0007, `selectedNotes.ts`),
 * which is what lets the assistant edit the notes a producer is working on.
 * The current
 * selection is folded in as a short human-readable description (never as the
 * `SelectionScope` values verbatim), because a conversation turn or a
 * selection change is, per the same PRD section, something the assistant
 * reads about the user's intent, not a project mutation of its own.
 */

export interface AssistantTrackSummary {
  readonly id: string;
  readonly name: string;
  readonly type: Track["type"];
  readonly instrumentKind: Instrument["kind"] | null;
  readonly deviceCount: number;
  /** The track's fader, in decibels (`TRACK_VOLUME`). */
  readonly volume: number;
  /** The track's pan, -1 (left) to 1 (right). */
  readonly pan: number;
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly clipCount: number;
  readonly placementCount: number;
  /**
   * A drum machine's pads, in order, by ID and name, so the assistant can
   * name the pad a sound is for (GRV-23). Empty for any other instrument.
   */
  readonly pads: readonly AssistantPadSummary[];
  /**
   * Where the track's clips sit on the timeline, in start order, so a new
   * placement can go beside them rather than on top of them (GRV-6).
   */
  readonly placements: readonly AssistantPlacementSummary[];
}

export interface AssistantPlacementSummary {
  readonly id: string;
  readonly clipId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly looped: boolean;
}

export interface AssistantPadSummary {
  readonly id: string;
  readonly name: string;
}

export interface AssistantSectionSummary {
  readonly id: string;
  readonly name: string;
  readonly startTicks: number;
  readonly durationTicks: number;
}

export interface AssistantSelectionSummary {
  /** A short human-readable description, e.g. "2 tracks and 1 placement selected". */
  readonly description: string;
  readonly countByKind: Readonly<Partial<Record<SelectionScope["kind"], number>>>;
}

export interface AssistantContext {
  readonly projectId: string;
  readonly projectName: string;
  readonly tempo: number;
  /** The song's swing in percent, 50 straight to 75 (`SONG_SWING`). */
  readonly swing: number;
  readonly timeSignature: Readonly<{ numerator: number; denominator: number }>;
  readonly totalTicks: number;
  readonly tracks: readonly AssistantTrackSummary[];
  readonly sections: readonly AssistantSectionSummary[];
  readonly selection: AssistantSelectionSummary | null;
  /** The selection's raw note events; `null` when nothing selected holds notes. */
  readonly selectedNotes: AssistantSelectedNotes | null;
  readonly fingerprint: string;
}

function summarizeTrack(track: Track, project: Project): AssistantTrackSummary {
  const placements = project.song.placements.filter(
    (placement) => placement.trackId === track.id,
  );
  return {
    id: track.id,
    name: track.name,
    type: track.type,
    instrumentKind: track.instrument?.kind ?? null,
    deviceCount: track.devices.length,
    volume: track.mixer.volume,
    pan: track.mixer.pan,
    muted: track.mixer.muted,
    soloed: track.mixer.soloed,
    clipCount: project.clips.filter((clip) => clip.trackId === track.id).length,
    placementCount: placements.length,
    pads:
      track.instrument?.kind === "drumMachine"
        ? track.instrument.pads.map((pad) => ({ id: pad.id, name: pad.name }))
        : [],
    placements: placements
      .map((placement) => ({
        id: placement.id,
        clipId: placement.clipId,
        startTicks: placement.startTicks,
        durationTicks: placement.durationTicks,
        looped: placement.looped,
      }))
      .sort((a, b) => a.startTicks - b.startTicks),
  };
}

const SCOPE_KIND_LABELS: Record<SelectionScope["kind"], { one: string; many: string }> = {
  project: { one: "project", many: "projects" },
  track: { one: "track", many: "tracks" },
  clip: { one: "clip", many: "clips" },
  placement: { one: "placement", many: "placements" },
  event: { one: "note", many: "notes" },
  section: { one: "section", many: "sections" },
  device: { one: "device", many: "devices" },
  automationPoint: { one: "automation point", many: "automation points" },
  barRange: { one: "bar range", many: "bar ranges" },
};

/** A compact, human-readable summary of a selection: never the raw scopes. */
export function summarizeSelection(
  selection: SelectionState,
): AssistantSelectionSummary | null {
  if (selection.scopes.length === 0) {
    return null;
  }
  const countByKind: Partial<Record<SelectionScope["kind"], number>> = {};
  for (const scope of selection.scopes) {
    countByKind[scope.kind] = (countByKind[scope.kind] ?? 0) + 1;
  }
  const parts = (Object.entries(countByKind) as [SelectionScope["kind"], number][])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, count]) => {
      const label = SCOPE_KIND_LABELS[kind];
      return `${count} ${count === 1 ? label.one : label.many}`;
    });
  const description = `${parts.join(", ")} selected`;
  return { description, countByKind };
}

/**
 * Builds the assistant's project context. Pass the current `SelectionState`
 * to fold in a compact description of what the user has selected.
 */
export function buildAssistantContext(
  project: Project,
  selection?: SelectionState,
): AssistantContext {
  const orderedTracks = [...project.song.tracks].sort((a, b) => a.order - b.order);
  const tracks = orderedTracks.map((track) => summarizeTrack(track, project));
  const sections = [...project.song.sections]
    .sort((a, b) => a.startTicks - b.startTicks)
    .map((section) => ({
      id: section.id,
      name: section.name,
      startTicks: section.startTicks,
      durationTicks: section.durationTicks,
    }));
  const totalTicks = Math.max(
    0,
    ...project.song.placements.map((p) => p.startTicks + p.durationTicks),
    ...project.song.sections.map((s) => s.startTicks + s.durationTicks),
  );
  const selectionSummary = selection ? summarizeSelection(selection) : null;
  const notes = selectedNotes(project, selection);

  const shape = {
    projectName: project.metadata.name,
    tempo: project.song.tempo,
    swing: project.song.swing,
    timeSignature: project.song.timeSignature,
    totalTicks,
    tracks,
    sections,
    selection: selectionSummary,
    selectedNotes: notes,
  };

  return {
    projectId: project.metadata.id,
    projectName: project.metadata.name,
    tempo: project.song.tempo,
    swing: project.song.swing,
    timeSignature: project.song.timeSignature,
    totalTicks,
    tracks,
    sections,
    selection: selectionSummary,
    selectedNotes: notes,
    fingerprint: fingerprintOf(shape),
  };
}
