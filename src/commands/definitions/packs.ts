import { z } from "zod";
import {
  type PackDependency,
  type PackVersion,
  packDependencySchema,
  packVersionSchema,
} from "../../domain/entities";
import { type PackId, packIdSchema } from "../../domain/ids";
import { CONTROL_PARTS, controlAddress, SONG_ENTITY } from "../controlAddress";
import {
  applied,
  type CommandInput,
  defineCommand,
  eraseCommand,
  type RegisteredCommand,
  rejected,
} from "../types";

/**
 * Pack-shelf commands (LIB-08).
 *
 * The shelf (`metadata.addedPacks`) is the "packs the user has added to this
 * project" list, distinct from the *derived* `packDependencies` ("packs the
 * project uses"). It is the one piece of pack state a command maintains rather
 * than derives, because adding a pack the user has not yet drawn a sound from
 * has to survive a reload — deriving the shelf from usage would make that pack
 * vanish.
 *
 * Two rules make these commands safe against the derived list:
 *
 * - `pack.add` shelves a pack at a version. If the pack is already shelved at
 *   the same version it is a no-op error (nothing to undo); at a *different*
 *   version it is refused, because a project shelves one version per pack.
 * - `pack.remove` refuses to unshelve a pack the project still uses, so a used
 *   pack is never silently dropped from the panel while its sounds play. The
 *   caller resolves the assets first (or the pack surfaces as a missing-pack
 *   state via `resolvePackAvailability`); the command does not do it for them.
 *
 * Neither command touches `song.assets`, so neither changes `packDependencies`.
 *
 * `pack.setVersion` (#892) is the one pack command that does: it moves the
 * project's pin for one pack from one version to another — every asset the
 * project carries from that pack, and its shelf entry, together. Assets are
 * immutable content, so the sounds themselves do not change; only the version
 * the project resolves them from does. It is how a project pinned to an older
 * version takes a sound from a newer one, in the same transaction as the
 * insert, and its inverse (the same command, versions swapped) is how one undo
 * puts the old pin back. It refuses a pin the project does not hold, so it can
 * never leave a pack at two versions.
 */

export const packAddPayloadSchema = z.strictObject({
  pack: packDependencySchema,
});
export type PackAddPayload = z.infer<typeof packAddPayloadSchema>;

export const packRemovePayloadSchema = z.strictObject({
  pack: packDependencySchema,
});
export type PackRemovePayload = z.infer<typeof packRemovePayloadSchema>;

export const packSetVersionPayloadSchema = z.strictObject({
  packId: packIdSchema,
  from: packVersionSchema,
  to: packVersionSchema,
});
export type PackSetVersionPayload = z.infer<typeof packSetVersionPayloadSchema>;

function shelfIndexOf(shelf: readonly PackDependency[], packId: PackId): number {
  return shelf.findIndex((entry) => entry.packId === packId);
}

export const packAddCommand = defineCommand<PackAddPayload>({
  type: "pack.add",
  version: 1,
  schema: packAddPayloadSchema,
  touches: () => [controlAddress(SONG_ENTITY, CONTROL_PARTS.packs)],
  summarize: (payload) => `Add pack ${payload.pack.packId} to project`,
  apply(project, payload) {
    const shelf = project.metadata.addedPacks;
    const existingIndex = shelfIndexOf(shelf, payload.pack.packId);
    if (existingIndex >= 0) {
      const existing = shelf[existingIndex];
      if (existing.version === payload.pack.version) {
        return rejected(`Pack ${payload.pack.packId} is already on the project's shelf`);
      }
      return rejected(
        `Pack ${payload.pack.packId} is already on the shelf at version ${existing.version}; a project shelves one version per pack`,
      );
    }
    return applied({
      ...project,
      metadata: {
        ...project.metadata,
        addedPacks: [...shelf, payload.pack],
      },
    });
  },
  invert: (payload) => [removePack(payload.pack)],
});

export const packRemoveCommand = defineCommand<PackRemovePayload>({
  type: "pack.remove",
  version: 1,
  schema: packRemovePayloadSchema,
  touches: () => [controlAddress(SONG_ENTITY, CONTROL_PARTS.packs)],
  summarize: (payload) => `Remove pack ${payload.pack.packId} from project`,
  apply(project, payload) {
    const shelf = project.metadata.addedPacks;
    const index = shelfIndexOf(shelf, payload.pack.packId);
    if (index < 0 || shelf[index].version !== payload.pack.version) {
      return rejected(
        `Pack ${payload.pack.packId} at version ${payload.pack.version} is not on the project's shelf`,
      );
    }
    // A used pack must stay shelved: removing it would leave the project
    // depending on a pack that is no longer on the shelf, which is exactly the
    // drift `checkProjectIntegrity` rejects. Refuse with a named reason rather
    // than silently dropping it. "Used" is read off the song's assets, not the
    // derived dependency list, which is only recomputed when the transaction
    // ends: an undo that takes a sound back and then unshelves its pack
    // (GRV-50) runs both in one transaction.
    const stillUsed = project.song.assets.some(
      (asset) => asset.packId === payload.pack.packId,
    );
    if (stillUsed) {
      return rejected(
        `Pack ${payload.pack.packId} is in use by this project and cannot be removed from the shelf while its sounds are loaded`,
      );
    }
    return applied({
      ...project,
      metadata: {
        ...project.metadata,
        addedPacks: shelf.filter((_, position) => position !== index),
      },
    });
  },
  invert: (payload) => [addPack(payload.pack)],
});

export const packSetVersionCommand = defineCommand<PackSetVersionPayload>({
  type: "pack.setVersion",
  version: 1,
  schema: packSetVersionPayloadSchema,
  touches: () => [controlAddress(SONG_ENTITY, CONTROL_PARTS.packs)],
  summarize: (payload) =>
    `Move pack ${payload.packId} from version ${payload.from} to ${payload.to}`,
  supporting: true,
  apply(project, payload) {
    const { packId, from, to } = payload;
    if (from === to) {
      return rejected(`Pack ${packId} is already at version ${to}`);
    }
    const assets = project.song.assets.filter((asset) => asset.packId === packId);
    const shelf = project.metadata.addedPacks;
    const shelfIndex = shelfIndexOf(shelf, packId);
    if (assets.length === 0 && shelfIndex < 0) {
      return rejected(`Pack ${packId} is not in this project`);
    }
    const elsewhere =
      assets.find((asset) => asset.packVersion !== from)?.packVersion ??
      (shelfIndex >= 0 && shelf[shelfIndex].version !== from
        ? shelf[shelfIndex].version
        : undefined);
    if (elsewhere !== undefined) {
      return rejected(
        `Pack ${packId} is at version ${elsewhere} in this project, not ${from}`,
      );
    }
    // The derived dependency list follows the assets when the transaction
    // normalizes; the shelf is maintained, so it moves here.
    return applied({
      ...project,
      song: {
        ...project.song,
        assets: project.song.assets.map((asset) =>
          asset.packId === packId ? { ...asset, packVersion: to } : asset,
        ),
      },
      metadata: {
        ...project.metadata,
        addedPacks:
          shelfIndex < 0
            ? shelf
            : shelf.map((entry, position) =>
                position === shelfIndex ? { ...entry, version: to } : entry,
              ),
      },
    });
  },
  invert: (payload) => [setPackVersion(payload.packId, payload.to, payload.from)],
});

// --- Typed builders -------------------------------------------------------

export function addPack(pack: PackDependency): CommandInput<PackAddPayload> {
  return { type: packAddCommand.type, payload: { pack } };
}

export function removePack(pack: PackDependency): CommandInput<PackRemovePayload> {
  return { type: packRemoveCommand.type, payload: { pack } };
}

/** Moves the project's pin for `packId` from version `from` to `to`. */
export function setPackVersion(
  packId: PackId,
  from: PackVersion,
  to: PackVersion,
): CommandInput<PackSetVersionPayload> {
  return { type: packSetVersionCommand.type, payload: { packId, from, to } };
}

/** Registered, payload-erased commands from this module. */
export const packCommands: readonly RegisteredCommand[] = [
  eraseCommand(packAddCommand),
  eraseCommand(packRemoveCommand),
  eraseCommand(packSetVersionCommand),
];
