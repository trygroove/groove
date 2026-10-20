import { z } from "zod";
import {
  type AutomationLane,
  automationLaneSchema,
  type Clip,
  clipSchema,
  type Placement,
  placementSchema,
  type Track,
  trackSchema,
} from "../../domain/entities";
import { type TrackId, trackIdSchema } from "../../domain/ids";
import { CONTROL_PARTS, controlAddress, SONG_ENTITY } from "../controlAddress";
import {
  byOrder,
  findTrack,
  renumber,
  replaceTrack,
  trackLabel,
  withClips,
  withSong,
} from "../projectEdits";
import {
  applied,
  type CommandInput,
  defineCommand,
  eraseCommand,
  type RegisteredCommand,
  rejected,
} from "../types";

/**
 * Track lifecycle and mixer-flag commands.
 *
 * Deleting a track cascades to everything that cannot outlive it — its clips,
 * the placements on it, and any automation lane targeting it — because leaving
 * one behind is a dangling reference. `track.create` therefore accepts those
 * companions, so the inverse of a delete restores the whole track in one
 * atomic command rather than a best-effort sequence.
 */

export const trackCreatePayloadSchema = z.strictObject({
  track: trackSchema,
  clips: z.array(clipSchema).default([]),
  placements: z.array(placementSchema).default([]),
  automation: z.array(automationLaneSchema).default([]),
});
export type TrackCreatePayload = z.infer<typeof trackCreatePayloadSchema>;

export const trackDeletePayloadSchema = z.strictObject({
  trackId: trackIdSchema,
});
export type TrackDeletePayload = z.infer<typeof trackDeletePayloadSchema>;

export const trackChangesSchema = z
  .strictObject({
    name: trackSchema.shape.name.optional(),
    color: trackSchema.shape.color.optional(),
  })
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: "An update must change at least one field",
  });
export type TrackChanges = z.infer<typeof trackChangesSchema>;

export const trackUpdatePayloadSchema = z.strictObject({
  trackId: trackIdSchema,
  changes: trackChangesSchema,
});
export type TrackUpdatePayload = z.infer<typeof trackUpdatePayloadSchema>;

export const trackReorderPayloadSchema = z.strictObject({
  trackId: trackIdSchema,
  toIndex: z.int().min(0),
});
export type TrackReorderPayload = z.infer<typeof trackReorderPayloadSchema>;

export const trackFlagSchema = z.enum(["muted", "soloed"]);
export type TrackFlag = z.infer<typeof trackFlagSchema>;

export const trackSetFlagPayloadSchema = z.strictObject({
  trackId: trackIdSchema,
  flag: trackFlagSchema,
  value: z.boolean(),
});
export type TrackSetFlagPayload = z.infer<typeof trackSetFlagPayloadSchema>;

/** Does this automation lane point at the given track in any of its scopes? */
function targetsTrack(lane: AutomationLane, trackId: TrackId): boolean {
  return "trackId" in lane.target && lane.target.trackId === trackId;
}

export const trackCreateCommand = defineCommand<TrackCreatePayload>({
  type: "track.create",
  version: 1,
  schema: trackCreatePayloadSchema,
  touches: (payload) => [controlAddress(payload.track.id, CONTROL_PARTS.header)],
  // Always "Add": the entry's label comes from the forward command, and a
  // delete's undo is labelled "Undo Delete track" by the history, so a
  // payload carrying clips (every UI add, every duplicate) is never a restore.
  summarize: (payload) => `Add track "${payload.track.name}"`,
  apply(project, payload) {
    if (findTrack(project, payload.track.id)) {
      return rejected(`Track ${payload.track.id} already exists`);
    }
    const sorted = byOrder(project.song.tracks);
    if (payload.track.order > sorted.length) {
      return rejected(
        `Cannot insert a track at position ${payload.track.order} of ${sorted.length}`,
      );
    }
    const foreignClip = payload.clips.find((clip) => clip.trackId !== payload.track.id);
    if (foreignClip) {
      return rejected(
        `Clip ${foreignClip.id} does not belong to track ${payload.track.id}`,
      );
    }
    const tracks = renumber([
      ...sorted.slice(0, payload.track.order),
      payload.track,
      ...sorted.slice(payload.track.order),
    ]);
    const next = withClips(project, [...project.clips, ...payload.clips]);
    return applied(
      withSong(next, {
        ...next.song,
        tracks,
        placements: [...next.song.placements, ...payload.placements],
        automation: [...next.song.automation, ...payload.automation],
      }),
    );
  },
  invert: (payload) => [removeTrack(payload.track.id)],
});

export const trackDeleteCommand = defineCommand<TrackDeletePayload>({
  type: "track.delete",
  version: 1,
  schema: trackDeletePayloadSchema,
  touches: () => [controlAddress(SONG_ENTITY, CONTROL_PARTS.tracks)],
  summarize: (payload, project) => `Delete track ${trackLabel(project, payload.trackId)}`,
  apply(project, payload) {
    const track = findTrack(project, payload.trackId);
    if (!track) {
      return rejected(`Track ${payload.trackId} does not exist`);
    }
    const next = withClips(
      project,
      project.clips.filter((clip) => clip.trackId !== track.id),
    );
    return applied(
      withSong(next, {
        ...next.song,
        tracks: renumber(
          byOrder(next.song.tracks).filter((candidate) => candidate.id !== track.id),
        ),
        placements: next.song.placements.filter(
          (placement) => placement.trackId !== track.id,
        ),
        automation: next.song.automation.filter((lane) => !targetsTrack(lane, track.id)),
      }),
    );
  },
  invert(payload, before) {
    const track = findTrack(before, payload.trackId);
    if (!track) {
      return [];
    }
    return [
      addTrack(track, {
        clips: before.clips.filter((clip) => clip.trackId === track.id),
        placements: before.song.placements.filter(
          (placement) => placement.trackId === track.id,
        ),
        automation: before.song.automation.filter((lane) => targetsTrack(lane, track.id)),
      }),
    ];
  },
});

export const trackUpdateCommand = defineCommand<TrackUpdatePayload>({
  type: "track.update",
  version: 1,
  schema: trackUpdatePayloadSchema,
  touches: (payload) => [controlAddress(payload.trackId, CONTROL_PARTS.header)],
  summarize(payload, project) {
    const label = trackLabel(project, payload.trackId);
    return payload.changes.name !== undefined
      ? `Rename track ${label} to "${payload.changes.name}"`
      : `Recolor track ${label}`;
  },
  apply(project, payload) {
    const track = findTrack(project, payload.trackId);
    if (!track) {
      return rejected(`Track ${payload.trackId} does not exist`);
    }
    return applied(
      replaceTrack(project, {
        ...track,
        ...(payload.changes.name !== undefined ? { name: payload.changes.name } : {}),
        ...(payload.changes.color !== undefined ? { color: payload.changes.color } : {}),
      }),
    );
  },
  invert(payload, before) {
    const track = findTrack(before, payload.trackId);
    if (!track) {
      return [];
    }
    return [
      updateTrack(payload.trackId, {
        ...(payload.changes.name !== undefined ? { name: track.name } : {}),
        ...(payload.changes.color !== undefined ? { color: track.color } : {}),
      }),
    ];
  },
});

export const trackReorderCommand = defineCommand<TrackReorderPayload>({
  type: "track.reorder",
  version: 1,
  schema: trackReorderPayloadSchema,
  touches: (payload) => [controlAddress(payload.trackId, CONTROL_PARTS.header)],
  summarize: (payload, project) =>
    `Move track ${trackLabel(project, payload.trackId)} to position ${payload.toIndex + 1}`,
  apply(project, payload) {
    const sorted = byOrder(project.song.tracks);
    const from = sorted.findIndex((track) => track.id === payload.trackId);
    if (from < 0) {
      return rejected(`Track ${payload.trackId} does not exist`);
    }
    if (payload.toIndex >= sorted.length) {
      return rejected(
        `Cannot move a track to position ${payload.toIndex} of ${sorted.length}`,
      );
    }
    const moved = sorted[from];
    const without = sorted.filter((_, index) => index !== from);
    const tracks = renumber([
      ...without.slice(0, payload.toIndex),
      moved,
      ...without.slice(payload.toIndex),
    ]);
    return applied(withSong(project, { ...project.song, tracks }));
  },
  invert(payload, before) {
    const track = findTrack(before, payload.trackId);
    return track ? [reorderTrack(payload.trackId, track.order)] : [];
  },
});

export const trackSetFlagCommand = defineCommand<TrackSetFlagPayload>({
  type: "track.setFlag",
  version: 1,
  schema: trackSetFlagPayloadSchema,
  touches: (payload) => [controlAddress(payload.trackId, payload.flag)],
  summarize: (payload, project) =>
    `${payload.value ? "Enable" : "Disable"} ${payload.flag === "muted" ? "mute" : "solo"} on track ${trackLabel(project, payload.trackId)}`,
  apply(project, payload) {
    const track = findTrack(project, payload.trackId);
    if (!track) {
      return rejected(`Track ${payload.trackId} does not exist`);
    }
    return applied(
      replaceTrack(project, {
        ...track,
        mixer: { ...track.mixer, [payload.flag]: payload.value },
      }),
    );
  },
  invert(payload, before) {
    const track = findTrack(before, payload.trackId);
    return track
      ? [setTrackFlag(payload.trackId, payload.flag, track.mixer[payload.flag])]
      : [];
  },
});

// --- Typed builders -------------------------------------------------------

export function addTrack(
  track: Track,
  restore: {
    clips?: readonly Clip[];
    placements?: readonly Placement[];
    automation?: readonly AutomationLane[];
  } = {},
): CommandInput<TrackCreatePayload> {
  return {
    type: trackCreateCommand.type,
    payload: {
      track,
      clips: [...(restore.clips ?? [])],
      placements: [...(restore.placements ?? [])],
      automation: [...(restore.automation ?? [])],
    },
  };
}

export function removeTrack(trackId: TrackId): CommandInput<TrackDeletePayload> {
  return { type: trackDeleteCommand.type, payload: { trackId } };
}

export function updateTrack(
  trackId: TrackId,
  changes: TrackChanges,
): CommandInput<TrackUpdatePayload> {
  return { type: trackUpdateCommand.type, payload: { trackId, changes } };
}

export function reorderTrack(
  trackId: TrackId,
  toIndex: number,
): CommandInput<TrackReorderPayload> {
  return { type: trackReorderCommand.type, payload: { trackId, toIndex } };
}

export function setTrackFlag(
  trackId: TrackId,
  flag: TrackFlag,
  value: boolean,
): CommandInput<TrackSetFlagPayload> {
  return { type: trackSetFlagCommand.type, payload: { trackId, flag, value } };
}

/** Registered, payload-erased commands from this module. */
export const trackCommands: readonly RegisteredCommand[] = [
  eraseCommand(trackCreateCommand),
  eraseCommand(trackDeleteCommand),
  eraseCommand(trackUpdateCommand),
  eraseCommand(trackReorderCommand),
  eraseCommand(trackSetFlagCommand),
];
