import { z } from "zod";
import { type Asset, assetSchema, type Project } from "../../domain/entities";
import { type AssetId, assetIdSchema } from "../../domain/ids";
import { trackAssetIds } from "../../domain/packs";
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
 * Asset lifecycle commands (PRD LIB-05, invariant 12).
 *
 * A project stores a *reference* to a library sound, not the library record, so
 * putting a sound on a track is two things: the project has to carry the asset,
 * and something has to point at it. These commands own the first half; the
 * pointer is `instrument.setSample`, `drum.setPadAsset`, or an audio-loop clip.
 * Both halves go in one transaction, which is what makes "drag a sound onto a
 * sampler" one undoable step rather than two.
 *
 * Three things fall out of the kernel rather than being restated here:
 *
 * - **Pack dependencies stay derived.** Neither command touches
 *   `metadata.packDependencies` or the shelf; `executeTransaction` recomputes
 *   both from `song.assets` once per transaction (`withDerivedPackDependencies`),
 *   so adding the first sound from a pack shelves that pack atomically with the
 *   edit that needed it.
 * - **Nothing dangles.** `asset.remove` refuses an asset a track's instrument, a
 *   drum pad, or an audio-loop clip still resolves, naming what holds it, rather
 *   than letting the transaction fail later as a broken project.
 * - **Undo restores position.** `song.assets` is serialized in order, so
 *   removal's inverse puts the asset back at the index it came from instead of
 *   appending it and calling the project equal.
 */

export const assetAddPayloadSchema = z.strictObject({
  /** The asset to carry. Its ID is explicit so a replay lands the same asset. */
  asset: assetSchema,
  /** Position in `song.assets`; appended when omitted. */
  index: z.int().min(0).optional(),
});
export type AssetAddPayload = z.infer<typeof assetAddPayloadSchema>;

export const assetRemovePayloadSchema = z.strictObject({
  assetId: assetIdSchema,
});
export type AssetRemovePayload = z.infer<typeof assetRemovePayloadSchema>;

/**
 * What still resolves this asset — tracks whose instrument loads it (sampler or
 * drum pad) and audio-loop clips that play it — named so the refusal says what
 * to clear first rather than only that something did.
 */
function holdersOf(project: Project, assetId: AssetId): string[] {
  const holders = project.song.tracks
    .filter((track) => trackAssetIds(track).includes(assetId))
    .map((track) => `track ${track.id}`);
  holders.push(
    ...project.clips
      .filter(
        (clip) => clip.content.kind === "audioLoop" && clip.content.assetId === assetId,
      )
      .map((clip) => `clip ${clip.id}`),
  );
  return holders;
}

export const assetAddCommand = defineCommand<AssetAddPayload>({
  type: "asset.add",
  version: 1,
  schema: assetAddPayloadSchema,
  touches: () => [controlAddress(SONG_ENTITY, CONTROL_PARTS.assets)],
  summarize: (payload) => `Add ${payload.asset.name} to the project`,
  supporting: true,
  apply(project, payload) {
    const assets = project.song.assets;
    if (assets.some((candidate) => candidate.id === payload.asset.id)) {
      return rejected(`Asset ${payload.asset.id} is already in this project`);
    }
    const index = payload.index ?? assets.length;
    if (index > assets.length) {
      return rejected(
        `Cannot add an asset at index ${index}; the project carries ${assets.length}`,
      );
    }
    const next = [...assets];
    next.splice(index, 0, payload.asset);
    return applied({ ...project, song: { ...project.song, assets: next } });
  },
  invert: (payload) => [removeAsset(payload.asset.id)],
});

export const assetRemoveCommand = defineCommand<AssetRemovePayload>({
  type: "asset.remove",
  version: 1,
  schema: assetRemovePayloadSchema,
  touches: () => [controlAddress(SONG_ENTITY, CONTROL_PARTS.assets)],
  summarize: (payload, project) =>
    `Remove ${assetLabel(project.song.assets, payload.assetId)} from the project`,
  apply(project, payload) {
    const index = project.song.assets.findIndex(
      (candidate) => candidate.id === payload.assetId,
    );
    if (index < 0) {
      return rejected(`Asset ${payload.assetId} is not in this project`);
    }
    const holders = holdersOf(project, payload.assetId);
    if (holders.length > 0) {
      return rejected(
        `Asset ${payload.assetId} is still loaded by ${holders.join(", ")}`,
      );
    }
    return applied({
      ...project,
      song: {
        ...project.song,
        assets: project.song.assets.filter((_, position) => position !== index),
      },
    });
  },
  invert(payload, before) {
    const index = before.song.assets.findIndex(
      (candidate) => candidate.id === payload.assetId,
    );
    const asset = before.song.assets[index];
    return asset ? [addAsset(asset, index)] : [];
  },
});

/** The asset's name when the project carries it, else its ID. */
function assetLabel(assets: readonly Asset[], assetId: AssetId): string {
  return assets.find((asset) => asset.id === assetId)?.name ?? assetId;
}

// --- Typed builders -------------------------------------------------------

export function addAsset(asset: Asset, index?: number): CommandInput<AssetAddPayload> {
  return {
    type: assetAddCommand.type,
    payload: index === undefined ? { asset } : { asset, index },
  };
}

export function removeAsset(assetId: AssetId): CommandInput<AssetRemovePayload> {
  return { type: assetRemoveCommand.type, payload: { assetId } };
}

/** Registered, payload-erased commands from this module. */
export const assetCommands: readonly RegisteredCommand[] = [
  eraseCommand(assetAddCommand),
  eraseCommand(assetRemoveCommand),
];
