/**
 * Where a recommendation may be aimed (GRV-129): the tracks a turn can name,
 * and on a drum machine their pads, as the project context lists them plus
 * whatever the turn's own proposal creates before it.
 *
 * A `recommend_sounds` call names its track and pad by ID. A model that adds
 * a drum machine and recommends sounds for its pads in the same turn names
 * pads that only exist once the proposal is applied; one that guesses an ID
 * names a pad that never will. The gateway refuses the second kind back to
 * the model (`steps.ts`), the browser holds the first kind until its
 * proposal is applied and drops it if the proposal is declined, and the
 * evals check that every recommendation lands on a real pad.
 *
 * Pure, and like the rest of `src/assistant`, free of Firebase and any SDK.
 */
import type { Instrument, Project } from "../domain/entities";
import type { AssistantContextPayload } from "./protocol";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import { resolveToolCall } from "./tools";

/**
 * Every track a recommendation may name, by ID, with the pad IDs it may name
 * on it: a drum machine's pads, and none on any other track.
 */
export type RecommendationTargets = ReadonlyMap<string, ReadonlySet<string>>;

/** One call, as a proposal or a provider's reply carries it. */
interface Call {
  readonly name: string;
  readonly input: unknown;
}

function padsOf(instrument: Instrument | null | undefined): ReadonlySet<string> {
  return new Set(
    instrument?.kind === "drumMachine" ? instrument.pads.map((pad) => pad.id) : [],
  );
}

/** The tracks and pads the project context lists. */
export function contextTargets(context: AssistantContextPayload): RecommendationTargets {
  return new Map(
    context.tracks.map((track) => [track.id, new Set(track.pads.map((pad) => pad.id))]),
  );
}

/** The tracks and pads `project` has. */
export function projectTargets(project: Project): RecommendationTargets {
  return new Map(
    project.song.tracks.map((track) => [track.id, padsOf(track.instrument)]),
  );
}

/**
 * `targets` with what `call` creates added: a track a `track_create` makes,
 * with its pads, or the pads an `instrument_change` gives a track. Any other
 * call, and one that does not parse, adds nothing.
 */
export function withCreatedTargets(
  targets: RecommendationTargets,
  call: Call,
): RecommendationTargets {
  const resolved = resolveToolCall(call.name, call.input);
  if (!resolved.ok) return targets;
  if (resolved.commandType === "track.create") {
    const { track } = resolved.payload as {
      track: { id: string; instrument: Instrument | null };
    };
    return new Map(targets).set(track.id, padsOf(track.instrument));
  }
  if (resolved.commandType === "instrument.change") {
    const { trackId, instrument } = resolved.payload as {
      trackId: string;
      instrument: Instrument | null;
    };
    return new Map(targets).set(trackId, padsOf(instrument));
  }
  return targets;
}

/** The tracks and pads `calls` create, in their order, on top of `targets`. */
export function targetsAfter(
  targets: RecommendationTargets,
  calls: readonly Call[],
): RecommendationTargets {
  return calls.reduce(withCreatedTargets, targets);
}

/** The tracks and pads `calls` create, and nothing else. */
export function createdTargets(calls: readonly Call[]): RecommendationTargets {
  return targetsAfter(new Map(), calls);
}

/** The track and pad a recommendation call names, or null for each it omits. */
export function namedTarget(input: unknown): {
  readonly trackId: string | null;
  readonly padId: string | null;
} {
  const fields = (typeof input === "object" && input !== null ? input : {}) as {
    trackId?: unknown;
    padId?: unknown;
  };
  return {
    trackId: typeof fields.trackId === "string" ? fields.trackId : null,
    padId: typeof fields.padId === "string" ? fields.padId : null,
  };
}

/**
 * Why a `recommend_sounds` call is aimed at nothing, or null when it is aimed
 * at a track and pad in `targets` (or names none, which means the selected
 * one). A pad named with no track must be on some track; a pad named on a
 * track that is not a drum machine is ignored, as the editor ignores it.
 */
export function misaimedRecommendation(
  call: Call,
  targets: RecommendationTargets,
): string | null {
  if (call.name !== RECOMMEND_SOUNDS_TOOL) return null;
  const { trackId, padId } = namedTarget(call.input);
  if (trackId !== null) {
    const pads = targets.get(trackId);
    if (!pads) {
      return `There is no track "${trackId.slice(0, 64)}" in the project or created earlier in this reply. Use a track ID from the project context or one a track_create in this reply made`;
    }
    if (padId !== null && pads.size > 0 && !pads.has(padId)) {
      return `The track "${trackId.slice(0, 64)}" has no pad "${padId.slice(0, 64)}". Use one of its pads: ${[...pads].join(", ")}`;
    }
    return null;
  }
  if (padId !== null && ![...targets.values()].some((pads) => pads.has(padId))) {
    return `There is no pad "${padId.slice(0, 64)}" in the project or created earlier in this reply. Name the pad's track too, and use a pad ID it has`;
  }
  return null;
}
