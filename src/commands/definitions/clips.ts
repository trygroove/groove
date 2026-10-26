import { z } from "zod";
import {
  type Clip,
  clipSchema,
  type Placement,
  placementSchema,
} from "../../domain/entities";
import { type ClipId, clipIdSchema } from "../../domain/ids";
import {
  arrangementControl,
  CONTROL_PARTS,
  type ControlAddress,
  controlAddress,
} from "../controlAddress";
import { describeLength } from "../musicalWording";
import { clipLabel, findClip, replaceClip, withClips, withSong } from "../projectEdits";
import {
  applied,
  type CommandInput,
  defineCommand,
  eraseCommand,
  type RegisteredCommand,
  rejected,
} from "../types";

/**
 * Clip lifecycle commands.
 *
 * Deleting a clip also removes the arrangement placements that reference it,
 * because a placement pointing at a missing clip is an invalid project
 * (invariant 5). The inverse therefore restores the clip *and* its placements
 * in one command, so undo of a delete is exact rather than approximate.
 */

export const clipCreatePayloadSchema = z.strictObject({
  clip: clipSchema,
  /** Placements restored alongside the clip; empty when creating a new one. */
  placements: z.array(placementSchema).default([]),
});
export type ClipCreatePayload = z.infer<typeof clipCreatePayloadSchema>;

export const clipDeletePayloadSchema = z.strictObject({
  clipId: clipIdSchema,
});
export type ClipDeletePayload = z.infer<typeof clipDeletePayloadSchema>;

export const clipChangesSchema = z
  .strictObject({
    name: clipSchema.shape.name.optional(),
    color: clipSchema.shape.color.optional(),
    lengthTicks: clipSchema.shape.lengthTicks.optional(),
  })
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: "An update must change at least one field",
  });
export type ClipChanges = z.infer<typeof clipChangesSchema>;

export const clipUpdatePayloadSchema = z.strictObject({
  clipId: clipIdSchema,
  changes: clipChangesSchema,
});
export type ClipUpdatePayload = z.infer<typeof clipUpdatePayloadSchema>;

/** One address per field a `clip.update` changes: its name, colour or length. */
function clipChangeControls(clipId: string, changes: ClipChanges): ControlAddress[] {
  const controls: ControlAddress[] = [];
  if (changes.name !== undefined)
    controls.push(controlAddress(clipId, CONTROL_PARTS.name));
  if (changes.color !== undefined)
    controls.push(controlAddress(clipId, CONTROL_PARTS.color));
  if (changes.lengthTicks !== undefined)
    controls.push(controlAddress(clipId, CONTROL_PARTS.length));
  return controls;
}

export const clipCreateCommand = defineCommand<ClipCreatePayload>({
  type: "clip.create",
  version: 1,
  schema: clipCreatePayloadSchema,
  touches: (payload) => [controlAddress(payload.clip.id, CONTROL_PARTS.notes)],
  summarize: (payload) =>
    payload.placements.length > 0
      ? `Restore clip "${payload.clip.name}"`
      : `Add clip "${payload.clip.name}"`,
  apply(project, payload) {
    if (findClip(project, payload.clip.id)) {
      return rejected(`Clip ${payload.clip.id} already exists`);
    }
    const foreign = payload.placements.find(
      (placement) => placement.clipId !== payload.clip.id,
    );
    if (foreign) {
      return rejected(
        `Placement ${foreign.id} does not belong to clip ${payload.clip.id}`,
      );
    }
    const withClip = withClips(project, [...project.clips, payload.clip]);
    return applied(
      withSong(withClip, {
        ...withClip.song,
        placements: [...withClip.song.placements, ...payload.placements],
      }),
    );
  },
  invert: (payload) => [removeClip(payload.clip.id)],
});

export const clipDeleteCommand = defineCommand<ClipDeletePayload>({
  type: "clip.delete",
  version: 1,
  schema: clipDeletePayloadSchema,
  touches: (payload, project) => [
    arrangementControl(project.clips.find((clip) => clip.id === payload.clipId)?.trackId),
  ],
  summarize: (payload, project) => `Delete clip ${clipLabel(project, payload.clipId)}`,
  apply(project, payload) {
    const clip = findClip(project, payload.clipId);
    if (!clip) {
      return rejected(`Clip ${payload.clipId} does not exist`);
    }
    const remaining = withClips(
      project,
      project.clips.filter((candidate) => candidate.id !== clip.id),
    );
    return applied(
      withSong(remaining, {
        ...remaining.song,
        placements: remaining.song.placements.filter(
          (placement) => placement.clipId !== clip.id,
        ),
      }),
    );
  },
  invert(payload, before) {
    const clip = findClip(before, payload.clipId);
    if (!clip) {
      return [];
    }
    return [
      addClip(
        clip,
        before.song.placements.filter((placement) => placement.clipId === clip.id),
      ),
    ];
  },
});

export const clipUpdateCommand = defineCommand<ClipUpdatePayload>({
  type: "clip.update",
  version: 1,
  schema: clipUpdatePayloadSchema,
  touches: (payload) => clipChangeControls(payload.clipId, payload.changes),
  summarize(payload, project) {
    const label = clipLabel(project, payload.clipId);
    if (payload.changes.name !== undefined) {
      return `Rename clip ${label} to "${payload.changes.name}"`;
    }
    if (payload.changes.lengthTicks !== undefined) {
      return `Resize clip ${label} to ${describeLength(payload.changes.lengthTicks)}`;
    }
    return `Recolor clip ${label}`;
  },
  apply(project, payload) {
    const clip = findClip(project, payload.clipId);
    if (!clip) {
      return rejected(`Clip ${payload.clipId} does not exist`);
    }
    return applied(replaceClip(project, { ...clip, ...definedOnly(payload.changes) }));
  },
  invert(payload, before) {
    const clip = findClip(before, payload.clipId);
    if (!clip) {
      return [];
    }
    return [
      updateClip(payload.clipId, {
        ...(payload.changes.name !== undefined ? { name: clip.name } : {}),
        ...(payload.changes.color !== undefined ? { color: clip.color } : {}),
        ...(payload.changes.lengthTicks !== undefined
          ? { lengthTicks: clip.lengthTicks }
          : {}),
      }),
    ];
  },
});

/** Drops absent keys so a spread never overwrites a field with `undefined`. */
function definedOnly<T extends object>(changes: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

// --- Typed builders -------------------------------------------------------

export function addClip(
  clip: Clip,
  placements: readonly Placement[] = [],
): CommandInput<ClipCreatePayload> {
  return {
    type: clipCreateCommand.type,
    payload: { clip, placements: [...placements] },
  };
}

export function removeClip(clipId: ClipId): CommandInput<ClipDeletePayload> {
  return { type: clipDeleteCommand.type, payload: { clipId } };
}

export function updateClip(
  clipId: ClipId,
  changes: ClipChanges,
): CommandInput<ClipUpdatePayload> {
  return { type: clipUpdateCommand.type, payload: { clipId, changes } };
}

/** Registered, payload-erased commands from this module. */
export const clipCommands: readonly RegisteredCommand[] = [
  eraseCommand(clipCreateCommand),
  eraseCommand(clipDeleteCommand),
  eraseCommand(clipUpdateCommand),
];
