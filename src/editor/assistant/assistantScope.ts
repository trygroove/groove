/**
 * What the assistant reads and may change (GRV-26): the composer's scope
 * chip, and the project context a turn sends for it.
 *
 * The scope follows the editor:
 *
 * - **your selection**, when there is one: notes selected in the clip on
 *   screen (`clip`), or clips selected in the arrangement (`section`, the
 *   arrangement's stretch of the song: since #292 a band selects the clips it
 *   touches rather than a range);
 * - else **the selected track** (`track`);
 * - or **the whole song** (`song`).
 *
 * One click widens it (selection, then track, then song, and back round),
 * and the choice resets when the selection changes. A selection only counts
 * on the view that shows it, so what the chip says is always what is on
 * screen.
 *
 * The context is the allowlisted payload (`src/assistant/payload.ts`, ADR
 * 0007). Raw note events go for what the scope points at: the selection's
 * notes, or every note on the track in scope (GRV-122: a producer who has
 * just written hats into a new drum track has that track in scope, and asks
 * about them without selecting anything). The song scope sends none.
 *
 * Pure, so the rules are tested without rendering.
 */
import { buildAssistantPayload } from "../../assistant/payload";
import type { AssistantContextPayload } from "../../assistant/protocol";
import type { Project, Track } from "../../domain/entities";
import type { EventId, PlacementId } from "../../domain/ids";
import type { SelectionScope, SelectionState } from "../../selection";

/** How wide the scope is, narrowest first. */
export type ScopeLevel = "selection" | "track" | "song";

/** The analytics catalog's `scope` values (`assistant_message_sent`). */
export type CatalogScope = "clip" | "section" | "track" | "song";

/** A selection the chip can name. */
export type ScopeSelection =
  | { readonly kind: "notes"; readonly eventIds: readonly EventId[] }
  | { readonly kind: "clips"; readonly placementIds: readonly PlacementId[] };

/** What the editor is pointed at, as the scope reads it. */
export interface ScopeSources {
  readonly selection: ScopeSelection | null;
  readonly track: Track | null;
}

export interface AssistantScope {
  readonly level: ScopeLevel;
  readonly catalogScope: CatalogScope;
  /** What the chip and a sent message say, e.g. "3 notes", "BD", "Whole song". */
  readonly label: string;
  /** What `level` was resolved from, for building the context. */
  readonly selection: ScopeSelection | null;
  readonly track: Track | null;
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** The levels open to these sources, narrowest first. Always ends in `song`. */
export function availableLevels(sources: ScopeSources): readonly ScopeLevel[] {
  return [
    ...(sources.selection ? (["selection"] as const) : []),
    ...(sources.track ? (["track"] as const) : []),
    "song",
  ];
}

/** The level one click on the chip moves to: wider, or back to the narrowest. */
export function widen(level: ScopeLevel, sources: ScopeSources): ScopeLevel {
  const levels = availableLevels(sources);
  const index = levels.indexOf(level);
  return levels[(index + 1) % levels.length] ?? "song";
}

/**
 * The scope at `chosen`, or the narrowest open level when nothing was chosen
 * or the choice is no longer open (the selection it named has gone).
 */
export function resolveScope(
  sources: ScopeSources,
  chosen: ScopeLevel | null,
): AssistantScope {
  const levels = availableLevels(sources);
  const level = chosen && levels.includes(chosen) ? chosen : (levels[0] ?? "song");
  if (level === "selection" && sources.selection) {
    const selection = sources.selection;
    return {
      level,
      catalogScope: selection.kind === "notes" ? "clip" : "section",
      label:
        selection.kind === "notes"
          ? plural(selection.eventIds.length, "note", "notes")
          : plural(selection.placementIds.length, "clip", "clips"),
      selection,
      track: sources.track,
    };
  }
  if (level === "track" && sources.track) {
    return {
      level,
      catalogScope: "track",
      label: sources.track.name,
      selection: null,
      track: sources.track,
    };
  }
  return {
    level: "song",
    catalogScope: "song",
    label: "Whole song",
    selection: null,
    track: null,
  };
}

/**
 * A key that changes exactly when the selection does, so a widened choice
 * made against one selection is let go when the next one arrives.
 */
export function selectionKey(sources: ScopeSources): string {
  const selection = sources.selection;
  const picked =
    selection === null
      ? "none"
      : selection.kind === "notes"
        ? `notes:${[...selection.eventIds].sort().join(",")}`
        : `clips:${[...selection.placementIds].sort().join(",")}`;
  return `${picked}|${sources.track?.id ?? "no-track"}`;
}

function selectionStateOf(selection: ScopeSelection): SelectionState {
  const scopes: SelectionScope[] =
    selection.kind === "notes"
      ? selection.eventIds.map((id) => ({ kind: "event", id }))
      : selection.placementIds.map((id) => ({ kind: "placement", id }));
  return selectionOf(scopes);
}

function selectionOf(scopes: SelectionScope[]): SelectionState {
  return { scopes, focus: scopes[0] ?? null };
}

/** The most a selection description may be (`assistantSelectionContextSchema`). */
const MAX_DESCRIPTION = 200;

/** The project context one turn sends for `scope`. */
export function scopedContext(
  project: Project,
  scope: AssistantScope,
): AssistantContextPayload {
  if (scope.level === "selection" && scope.selection) {
    return buildAssistantPayload(project, selectionStateOf(scope.selection));
  }
  if (scope.level === "track" && scope.track) {
    const track = scope.track;
    return {
      ...buildAssistantPayload(project, selectionOf([{ kind: "track", id: track.id }])),
      selection: {
        description: `In scope: the track "${track.name}" (${track.id})`.slice(
          0,
          MAX_DESCRIPTION,
        ),
        countByKind: { track: 1 },
      },
    };
  }
  return buildAssistantPayload(project);
}
