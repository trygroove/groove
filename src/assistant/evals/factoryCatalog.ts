/**
 * The factory sounds a scrubbed eval fixture may keep (GRV-109).
 *
 * `bun run assistant:fixture` turns a production project into a fixture in a
 * public repository, so an asset survives only when it is one of the factory
 * library's own sounds: its pack is a factory pack and its storage reference is
 * a sound that pack delivers. Audio is content-addressed and every pack
 * version's manifest is immutable, so a pack and a storage reference identify
 * the bytes whichever version the project pins. A producer's own sound (#282)
 * lives under `users/{uid}/` and is never in here.
 *
 * Pure: the catalog is built from the generated factory module and from pack
 * manifests the caller has already fetched and parsed.
 */
import type { Asset } from "../../domain/entities";
import { factoryLibrary } from "../../library/factoryLibrary";
import { assetStorageRef, type PackManifest } from "../../library/manifest";

/** One factory sound, as the library states it. */
export interface FactorySound {
  readonly packId: string;
  readonly storageRef: string;
  /** The sound's name in the library. */
  readonly name: string;
  /** The licence the library delivers it under, when it states one. */
  readonly licence: string | null;
}

/** A resolved factory sound: every name the library has given it. */
export interface CatalogSound {
  readonly packId: string;
  readonly storageRef: string;
  readonly names: readonly string[];
  readonly licence: string | null;
}

export interface FactoryCatalog {
  /** The factory sound an asset is, or `null` when it is not one. */
  sound(asset: Pick<Asset, "packId" | "storageRef">): CatalogSound | null;
  /** Whether the library has a factory pack with this ID. */
  hasPack(packId: string): boolean;
}

const keyOf = (packId: string, storageRef: string) => `${packId}\u0000${storageRef}`;

export function factoryCatalog(sounds: Iterable<FactorySound>): FactoryCatalog {
  const byKey = new Map<string, CatalogSound>();
  const packs = new Set<string>();
  for (const sound of sounds) {
    packs.add(sound.packId);
    const key = keyOf(sound.packId, sound.storageRef);
    const known = byKey.get(key);
    byKey.set(key, {
      packId: sound.packId,
      storageRef: sound.storageRef,
      names: known?.names.includes(sound.name)
        ? known.names
        : [...(known?.names ?? []), sound.name],
      licence: known?.licence ?? sound.licence,
    });
  }
  return {
    sound: (asset) => byKey.get(keyOf(asset.packId, asset.storageRef)) ?? null,
    hasPack: (packId) => packs.has(packId),
  };
}

/** The factory sounds the app bundles (`factoryLibrary.generated.ts`). */
export function bundledFactorySounds(): FactorySound[] {
  return factoryLibrary()
    .filter((entry) => entry.pack.kind === "factory")
    .map((entry) => ({
      packId: entry.pack.id,
      storageRef: entry.storageRef,
      name: entry.name,
      licence: entry.licence,
    }));
}

/** The sounds one factory pack manifest delivers; none for any other kind. */
export function manifestFactorySounds(manifest: PackManifest): FactorySound[] {
  if (manifest.pack.kind !== "factory") return [];
  return manifest.assets.flatMap((asset) => {
    const storageKey = asset.files?.master?.storageKey;
    if (!storageKey) return [];
    return [
      {
        packId: manifest.pack.id,
        storageRef: assetStorageRef(storageKey),
        name: asset.name,
        licence: asset.license?.id ?? null,
      },
    ];
  });
}
