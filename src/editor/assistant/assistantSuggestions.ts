/**
 * The suggestion chips above the composer (GRV-26): #70's context-derived
 * next steps (`buildProjectAnalysis`'s `suggestions`), ordered to follow the
 * view on screen and the scope the chip says. Clicking one sends its label
 * as a message.
 *
 * The analysis reads the whole project, so on its own it offers the same
 * chips everywhere. The panel's focused next steps come first: one for the
 * selection when the chip is on it (vary these notes, these clips), and one
 * for the view on screen and the track in scope (develop a part in the
 * arrangement, a fill in the sequence view, the sound in the instrument view,
 * a sound in the library, the balance in the mixer). Widening the chip to the
 * song drops the track's.
 *
 * Then the analysis's: a suggestion whose scope is the chip's own comes
 * first, then one the view is for (the arrangement for structure, the mixer
 * for balance, the clip and instrument views for parts), then the rest in the
 * analysis's own order. Only the first {@link MAX_SHOWN} are shown, so the
 * row never scrolls far.
 */
import type { Project } from "../../domain/entities";
import {
  buildProjectAnalysis,
  type Suggestion,
  type SuggestionId,
} from "../../projection/projectAnalysisProjection";
import type { EditorViewName } from "../composition/editorViews";
import type { AssistantScope, CatalogScope } from "./assistantScope";

/** The most chips shown at once. */
export const MAX_SHOWN = 3;

/** The suggestions each view is for. */
const VIEW_AFFINITY: Readonly<Record<EditorViewName, readonly SuggestionId[]>> = {
  arrangement: ["create_arrangement", "build_transition", "add_variation", "add_track"],
  sequence: ["fill_empty_track", "add_variation"],
  instrument: ["fill_empty_track", "add_track"],
  library: ["add_track", "fill_empty_track"],
  mixer: ["balance_section"],
};

function fitOf(
  suggestion: Suggestion,
  view: EditorViewName,
  scope: CatalogScope,
): number {
  const scopeFit = suggestion.scope === scope ? 2 : 0;
  const viewFit = VIEW_AFFINITY[view].includes(suggestion.id) ? 1 : 0;
  return scopeFit + viewFit;
}

/** Orders `suggestions` for the view and scope, best first, and caps them. */
export function rankSuggestions(
  suggestions: readonly Suggestion[],
  view: EditorViewName,
  scope: CatalogScope,
): readonly Suggestion[] {
  return suggestions
    .map((suggestion, index) => ({
      suggestion,
      index,
      score: fitOf(suggestion, view, scope),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_SHOWN)
    .map(({ suggestion }) => suggestion);
}

/** The panel's own next steps for the selection, the view and the track in scope. */
export function focusedSuggestions(
  view: EditorViewName,
  scope: AssistantScope,
): readonly Suggestion[] {
  const focused: Suggestion[] = [];
  if (scope.level === "selection" && scope.selection) {
    focused.push(
      scope.selection.kind === "notes"
        ? {
            id: "vary_notes",
            scope: "clip",
            label: "Vary these notes",
            rationale: `${scope.label} selected.`,
          }
        : {
            id: "vary_clips",
            scope: "section",
            label: "Make a variation of these clips",
            rationale: `${scope.label} selected.`,
          },
    );
  }
  // The song scope names no track, so the track's own steps go with it.
  const track = scope.level === "song" ? null : scope.track;
  const forTrack = track ? `"${track.name}" is in scope.` : "";
  switch (view) {
    case "arrangement":
      if (track) {
        focused.push({
          id: "develop_part",
          scope: "track",
          label: `Develop the ${track.name} part`,
          rationale: forTrack,
        });
      }
      break;
    case "sequence":
      if (track) {
        focused.push({
          id: "write_fill",
          scope: "track",
          label: `Write a fill for ${track.name}`,
          rationale: forTrack,
        });
      }
      break;
    case "instrument":
      if (track) {
        focused.push({
          id: "shape_sound",
          scope: "track",
          label: `Shape the ${track.name} sound`,
          rationale: forTrack,
        });
      }
      break;
    case "library":
      focused.push({
        id: "find_sound",
        scope: track ? "track" : "song",
        label: track ? `Find a sound for ${track.name}` : "Find a sound to add",
        rationale: track ? forTrack : "The library is open.",
      });
      break;
    case "mixer":
      focused.push({
        id: "balance_mix",
        scope: track ? "track" : "song",
        label: track ? `Balance ${track.name} in the mix` : "Balance the mix",
        rationale: track ? forTrack : "The mixer is open.",
      });
      break;
  }
  return focused;
}

/** The suggestions for the view and scope on screen: the focused ones, then the analysis's. */
export function assistantSuggestions(
  project: Project,
  view: EditorViewName,
  scope: AssistantScope,
): readonly Suggestion[] {
  const focused = focusedSuggestions(view, scope);
  const taken = new Set(focused.map((suggestion) => suggestion.id));
  const analysed = rankSuggestions(
    buildProjectAnalysis(project).suggestions,
    view,
    scope.catalogScope,
  ).filter((suggestion) => !taken.has(suggestion.id));
  return [...focused, ...analysed].slice(0, MAX_SHOWN);
}
