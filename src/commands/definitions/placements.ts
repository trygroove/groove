import { z } from "zod";
import { type Placement, type Project, placementSchema } from "../../domain/entities";
import { type ClipId, type PlacementId, placementIdSchema } from "../../domain/ids";
import {
  type PlacementSpan,
  placementsOverlap,
  spanEnd,
  trimHead,
} from "../../domain/placementOverlap";
import { toTicks } from "../../domain/time";
import { arrangementControl, CONTROL_PARTS, controlAddress } from "../controlAddress";
import { describeLength, describePosition } from "../musicalWording";
import {
  clipLabel,
  findClip,
  findPlacement,
  replacePlacement,
  withSong,
} from "../projectEdits";
import {
  applied,
  type CommandInput,
  defineCommand,
  eraseCommand,
  type RawCommandInput,
  type RegisteredCommand,
  rejected,
} from "../types";

/**
 * Arrangement placement commands.
 *
 * A placement is the arrangement's reference to a clip, kept separate from the
 * clip's content (invariant 3) so the same clip can appear many times. Moving
 * a placement to another track is allowed only when that track already owns
 * the clip; the integrity check enforces it, so a cross-track drag has to
 * create a compatible clip first rather than silently re-parenting one.
 */

export const placementCreatePayloadSchema = z.strictObject({
  placement: placementSchema,
});
export type PlacementCreatePayload = z.infer<typeof placementCreatePayloadSchema>;

export const placementDeletePayloadSchema = z.strictObject({
  placementId: placementIdSchema,
});
export type PlacementDeletePayload = z.infer<typeof placementDeletePayloadSchema>;

export const placementChangesSchema = z
  .strictObject({
    trackId: placementSchema.shape.trackId.optional(),
    startTicks: placementSchema.shape.startTicks.optional(),
    durationTicks: placementSchema.shape.durationTicks.optional(),
    clipOffsetTicks: placementSchema.shape.clipOffsetTicks.optional(),
    looped: placementSchema.shape.looped.optional(),
  })
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: "An update must change at least one field",
  });
export type PlacementChanges = z.infer<typeof placementChangesSchema>;

export const placementUpdatePayloadSchema = z.strictObject({
  placementId: placementIdSchema,
  changes: placementChangesSchema,
});
export type PlacementUpdatePayload = z.infer<typeof placementUpdatePayloadSchema>;

export const placementCreateCommand = defineCommand<PlacementCreatePayload>({
  type: "placement.create",
  version: 1,
  schema: placementCreatePayloadSchema,
  touches: (payload) => [controlAddress(payload.placement.id, CONTROL_PARTS.placement)],
  summarize: (payload, project) =>
    `Place ${clipLabel(project, payload.placement.clipId)} at ${describePosition(payload.placement.startTicks)}`,
  apply(project, payload) {
    if (findPlacement(project, payload.placement.id)) {
      return rejected(`Placement ${payload.placement.id} already exists`);
    }
    return applied(
      withSong(project, {
        ...project.song,
        placements: [...project.song.placements, payload.placement],
      }),
    );
  },
  invert: (payload) => [removePlacement(payload.placement.id)],
});

export const placementDeleteCommand = defineCommand<PlacementDeletePayload>({
  type: "placement.delete",
  version: 1,
  schema: placementDeletePayloadSchema,
  touches: (payload, project) => [
    arrangementControl(
      project.song.placements.find((placement) => placement.id === payload.placementId)
        ?.trackId,
    ),
  ],
  summarize(payload, project) {
    const placement = findPlacement(project, payload.placementId);
    return placement
      ? `Remove ${clipLabel(project, placement.clipId)} from the arrangement`
      : "Remove a placement from the arrangement";
  },
  apply(project, payload) {
    const placement = findPlacement(project, payload.placementId);
    if (!placement) {
      return rejected(`Placement ${payload.placementId} does not exist`);
    }
    return applied(
      withSong(project, {
        ...project.song,
        placements: project.song.placements.filter(
          (candidate) => candidate.id !== placement.id,
        ),
      }),
    );
  },
  invert(payload, before) {
    const placement = findPlacement(before, payload.placementId);
    return placement ? [addPlacement(placement)] : [];
  },
});

export const placementUpdateCommand = defineCommand<PlacementUpdatePayload>({
  type: "placement.update",
  version: 1,
  schema: placementUpdatePayloadSchema,
  touches: (payload) => [controlAddress(payload.placementId, CONTROL_PARTS.placement)],
  summarize(payload, project) {
    const placement = findPlacement(project, payload.placementId);
    const label = placement ? clipLabel(project, placement.clipId) : "a placement";
    if (payload.changes.startTicks !== undefined) {
      return `Move ${label} to ${describePosition(payload.changes.startTicks)}`;
    }
    if (payload.changes.durationTicks !== undefined) {
      return `Resize ${label} to ${describeLength(payload.changes.durationTicks)}`;
    }
    if (payload.changes.looped !== undefined) {
      return `${payload.changes.looped ? "Loop" : "Unloop"} ${label}`;
    }
    return `Edit ${label}`;
  },
  apply(project, payload) {
    const placement = findPlacement(project, payload.placementId);
    if (!placement) {
      return rejected(`Placement ${payload.placementId} does not exist`);
    }
    return applied(
      replacePlacement(project, {
        ...placement,
        ...(payload.changes.trackId !== undefined
          ? { trackId: payload.changes.trackId }
          : {}),
        ...(payload.changes.startTicks !== undefined
          ? { startTicks: payload.changes.startTicks }
          : {}),
        ...(payload.changes.durationTicks !== undefined
          ? { durationTicks: payload.changes.durationTicks }
          : {}),
        ...(payload.changes.clipOffsetTicks !== undefined
          ? { clipOffsetTicks: payload.changes.clipOffsetTicks }
          : {}),
        ...(payload.changes.looped !== undefined
          ? { looped: payload.changes.looped }
          : {}),
      }),
    );
  },
  invert(payload, before) {
    const placement = findPlacement(before, payload.placementId);
    if (!placement) {
      return [];
    }
    return [
      updatePlacement(payload.placementId, {
        ...(payload.changes.trackId !== undefined ? { trackId: placement.trackId } : {}),
        ...(payload.changes.startTicks !== undefined
          ? { startTicks: placement.startTicks }
          : {}),
        ...(payload.changes.durationTicks !== undefined
          ? { durationTicks: placement.durationTicks }
          : {}),
        ...(payload.changes.clipOffsetTicks !== undefined
          ? { clipOffsetTicks: placement.clipOffsetTicks }
          : {}),
        ...(payload.changes.looped !== undefined ? { looped: placement.looped } : {}),
      }),
    ];
  },
});

// --- Typed builders -------------------------------------------------------

export function addPlacement(placement: Placement): CommandInput<PlacementCreatePayload> {
  return { type: placementCreateCommand.type, payload: { placement } };
}

export function removePlacement(
  placementId: PlacementId,
): CommandInput<PlacementDeletePayload> {
  return { type: placementDeleteCommand.type, payload: { placementId } };
}

export function updatePlacement(
  placementId: PlacementId,
  changes: PlacementChanges,
): CommandInput<PlacementUpdatePayload> {
  return {
    type: placementUpdateCommand.type,
    payload: { placementId, changes },
  };
}

/**
 * The commands that clear `incoming`'s ticks on its track so it can land there
 * (#290 overwrite): the incoming placement wins, and each placement it covers is
 * removed (full cover), trimmed to the boundary (partial cover), or split around
 * it (landing inside), so the track stays disjoint. `incoming` itself — when it
 * already exists, as a dragged placement does — is never touched. A split's tail
 * is a new placement, so its ID comes from `newPlacementId`, keeping replay and
 * redo exact. Composed by the edit that places `incoming`, in the same
 * transaction, so one undo restores everything it covered.
 */
export function overwritePlacements(
  project: Project,
  incoming: PlacementSpan & { readonly id?: PlacementId },
  newPlacementId: () => PlacementId,
): RawCommandInput[] {
  const start = incoming.startTicks;
  const end = spanEnd(incoming);
  return project.song.placements.flatMap((placement): RawCommandInput[] => {
    if (placement.id === incoming.id || !placementsOverlap(placement, incoming)) {
      return [];
    }
    const coversHead = start <= placement.startTicks;
    const coversTail = end >= spanEnd(placement);
    if (coversHead && coversTail) return [removePlacement(placement.id)];
    const tail = trimHead(placement, toTicks(end));
    const tailChanges = {
      startTicks: tail.startTicks,
      durationTicks: tail.durationTicks,
      clipOffsetTicks: tail.clipOffsetTicks,
    };
    if (coversHead) return [updatePlacement(placement.id, tailChanges)];
    const head = updatePlacement(placement.id, {
      durationTicks: toTicks(start - placement.startTicks),
    });
    return coversTail ? [head] : [head, addPlacement({ ...tail, id: newPlacementId() })];
  });
}

/**
 * The placements of `clipId` that follow it when it grows from `fromLength` to
 * `toLength` ticks long (#963), already grown. A placement that showed the clip
 * through its old end grows to show the new end, so what the clip editor shows
 * is what plays and exports. It stops at the next placement on its track, as
 * the track's placements never overlap. A looped placement already repeats the
 * clip and one that stopped short of the end showed only part of it, so both
 * keep their length. Empty when the clip does not grow.
 */
export function placementsGrownWithClip(
  project: Project,
  clipId: ClipId,
  fromLength: number,
  toLength: number,
): Placement[] {
  if (toLength <= fromLength) return [];
  const all = project.song.placements;
  return all.flatMap((placement): Placement[] => {
    if (placement.clipId !== clipId || placement.looped) return [];
    if (placement.clipOffsetTicks + placement.durationTicks < fromLength) return [];
    const wanted = placement.startTicks + toLength - placement.clipOffsetTicks;
    const room = all.reduce(
      (limit, other) =>
        other.trackId === placement.trackId &&
        other.startTicks > placement.startTicks &&
        other.startTicks < limit
          ? other.startTicks
          : limit,
      wanted,
    );
    const durationTicks = room - placement.startTicks;
    return durationTicks > placement.durationTicks
      ? [{ ...placement, durationTicks: toTicks(durationTicks) }]
      : [];
  });
}

/**
 * The commands that grow `clipId`'s placements with it when it becomes
 * `lengthTicks` long. Composed after the `clip.update` that resizes it, in the
 * same transaction, so the resize is one revision and one undo step.
 */
export function growPlacementsWithClip(
  project: Project,
  clipId: ClipId,
  lengthTicks: number,
): RawCommandInput[] {
  const clip = findClip(project, clipId);
  if (!clip) return [];
  return placementsGrownWithClip(project, clipId, clip.lengthTicks, lengthTicks).map(
    (placement) =>
      updatePlacement(placement.id, { durationTicks: placement.durationTicks }),
  );
}

/** Registered, payload-erased commands from this module. */
export const placementCommands: readonly RegisteredCommand[] = [
  eraseCommand(placementCreateCommand),
  eraseCommand(placementDeleteCommand),
  eraseCommand(placementUpdateCommand),
];
