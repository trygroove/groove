/**
 * The project context a turn sends (ADR 0007 decision 1), built from the two
 * assistant projections and cut down to the allowlist, field by field:
 *
 * - from `buildAssistantContext`: the project's name, tempo, swing, time signature
 *   and length; its sections; its tracks with their mixer state and where
 *   their placements sit; a description of the selection; and the
 *   selection's raw notes;
 * - from `buildProjectAnalysis`: derived note statistics (register, mean
 *   velocity, density, repetition).
 *
 * The projections carry more for the app's own use (the project's ID, a
 * fingerprint, suggestions, recent actions); none of it is on the list, so
 * none of it leaves. The gateway parses the result against the strict
 * `assistantContextPayloadSchema`, so a field added here without adding it
 * there is refused, not sent.
 */
import type { Project } from "../domain/entities";
import { buildAssistantContext } from "../projection/assistantContextProjection";
import {
  buildProjectAnalysis,
  type DensitySummary,
  type NoteSummary,
} from "../projection/projectAnalysisProjection";
import type { SelectionState } from "../selection/types";
import {
  type AssistantContextPayload,
  MAX_CONTEXT_PADS,
  MAX_CONTEXT_PLACEMENTS,
} from "./protocol";

type NoteStats = AssistantContextPayload["noteStats"]["song"];

function noteStats(notes: NoteSummary, density: DensitySummary | null): NoteStats {
  return {
    noteCount: notes.noteCount,
    padNoteCount: notes.padNoteCount,
    register: notes.register ? { ...notes.register } : null,
    meanVelocity: notes.meanVelocity,
    notesPerBar: density?.notesPerBar ?? null,
  };
}

/** The allowlisted context for `project` with `selection`. */
export function buildAssistantPayload(
  project: Project,
  selection?: SelectionState,
): AssistantContextPayload {
  const context = buildAssistantContext(project, selection);
  const analysis = buildProjectAnalysis(project, { selection });
  return {
    projectName: context.projectName,
    tempo: context.tempo,
    swing: context.swing,
    timeSignature: {
      numerator: context.timeSignature.numerator,
      denominator: context.timeSignature.denominator,
    } as AssistantContextPayload["timeSignature"],
    totalTicks: context.totalTicks,
    tracks: context.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      type: track.type,
      instrumentKind: track.instrumentKind,
      deviceCount: track.deviceCount,
      volume: track.volume,
      pan: track.pan,
      muted: track.muted,
      soloed: track.soloed,
      clipCount: track.clipCount,
      placementCount: track.placementCount,
      pads: track.pads
        .slice(0, MAX_CONTEXT_PADS)
        .map((pad) => ({ id: pad.id, name: pad.name })),
      placements: track.placements.slice(0, MAX_CONTEXT_PLACEMENTS).map((placement) => ({
        id: placement.id,
        clipId: placement.clipId,
        startTicks: placement.startTicks,
        durationTicks: placement.durationTicks,
        looped: placement.looped,
      })),
    })),
    sections: context.sections.map((section) => ({
      id: section.id,
      name: section.name,
      startTicks: section.startTicks,
      durationTicks: section.durationTicks,
    })),
    noteStats: {
      song: noteStats(analysis.song.notes, analysis.song.density),
      tracks: analysis.tracks.map((track) => ({
        trackId: track.id,
        ...noteStats(track.notes, track.density),
        repetitionRatio: track.repetition.repetitionRatio,
        distinctClipCount: track.repetition.distinctClipCount,
      })),
    },
    selection: context.selection
      ? {
          description: context.selection.description,
          countByKind: { ...context.selection.countByKind } as Record<string, number>,
        }
      : null,
    selectedNotes: context.selectedNotes
      ? {
          clips: context.selectedNotes.clips.map((clip) => ({
            clipId: clip.clipId,
            trackId: clip.trackId,
            lengthTicks: clip.lengthTicks,
            events: clip.events.map((event) => ({
              ...event,
              trigger: { ...event.trigger },
            })),
          })),
          noteCount: context.selectedNotes.noteCount,
          omittedNoteCount: context.selectedNotes.omittedNoteCount,
        }
      : null,
  };
}
