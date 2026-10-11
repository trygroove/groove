/**
 * The library the assistant may recommend from (GRV-23): every pack the app
 * publishes, loaded through the shared library client's cache, and the
 * metadata a turn sends of it.
 *
 * Only published packs are offered: a producer's own packs (#282) are theirs,
 * and their names never leave (ADR 0007). Only sounds the app can try and
 * insert are listed: one-shots and loops with audio. What a turn sends is
 * {@link libraryContext}: names, roles, tags and IDs, never a URL or a
 * storage path.
 */

import { ASSISTANT_LIBRARY_LIMITS } from "../../assistant/config";
import type {
  AssistantLibraryContext,
  AssistantLibraryPack,
  AssistantLibrarySound,
} from "../../assistant/protocol";
import type { Project } from "../../domain/entities";
import { toLibrarySample } from "../../library/insertion";
import type { LibraryClient } from "../../library/libraryClient";
import {
  hasAudio,
  type LibraryAsset,
  type LibraryPackSummary,
} from "../../library/manifest";
import { addedPackIds } from "../editorViewModel";

/** One published pack and the sounds of it a recommendation may name. */
export interface AssistantLibraryPackEntry {
  readonly pack: LibraryPackSummary;
  readonly sounds: readonly LibraryAsset[];
}

/** The published library, as far as it loaded. */
export interface AssistantLibraryCatalog {
  readonly packs: readonly AssistantLibraryPackEntry[];
}

export interface AssistantLibrary {
  /**
   * Loads the index and every published pack's manifest, once: later calls
   * share it. A pack that will not load is left out of this load and asked for
   * again by the next one; an index that will not load resolves to null, and
   * is asked for again next time.
   */
  load(): Promise<AssistantLibraryCatalog | null>;
  /** What the last load found, or null before one has finished. */
  current(): AssistantLibraryCatalog | null;
}

/** Whether a recommendation may name `asset`: a one-shot or loop with audio. */
function recommendable(asset: LibraryAsset): boolean {
  return asset.type !== "preset" && hasAudio(asset);
}

export function createAssistantLibrary(client: LibraryClient): AssistantLibrary {
  let loading: Promise<AssistantLibraryCatalog | null> | null = null;
  let loaded: AssistantLibraryCatalog | null = null;

  async function fetchCatalog(): Promise<AssistantLibraryCatalog | null> {
    let index: readonly LibraryPackSummary[];
    try {
      index = await client.loadIndex();
    } catch {
      loading = null;
      return null;
    }
    const published = index.filter((pack) => pack.kind !== "user");
    const results = await Promise.all(published.map((pack) => client.loadPack(pack)));
    // A pack that failed is asked for again by the next load; the client's
    // cache answers the ones that loaded without fetching them twice.
    if (results.some((result) => !result.ok)) loading = null;
    const catalog: AssistantLibraryCatalog = {
      packs: published.flatMap((pack, at) => {
        const result = results[at];
        if (!result?.ok) return [];
        return [{ pack, sounds: result.assets.filter(recommendable) }];
      }),
    };
    loaded = catalog;
    return catalog;
  }

  return {
    load() {
      loading ??= fetchCatalog();
      return loading;
    },
    current: () => loaded,
  };
}

/** Where a sound's audio lives, as a project's asset records it. */
function storageRefOf(asset: LibraryAsset): string | null {
  return toLibrarySample(asset)?.storageRef ?? null;
}

/** Whether the project uses `asset`: one of its assets is that delivery. */
export function projectUsesSound(project: Project, asset: LibraryAsset): boolean {
  const ref = storageRefOf(asset);
  return ref !== null && project.song.assets.some((used) => used.storageRef === ref);
}

/** Whether `packId` is one of the project's packs (`In this project`, LIB-010). */
export function projectHasPack(project: Project, packId: string): boolean {
  return addedPackIds(project, []).includes(packId);
}

/**
 * The gateway's caps on what a turn sends of the library
 * (`assistantLibraryPackSchema`). A field over its cap is clipped, so one long
 * name cannot fail every turn; an ID over its cap cannot be clipped without
 * naming something else, so its pack or sound is left out instead.
 */
const SENT = {
  packId: 64,
  soundId: 128,
  name: 200,
  version: 32,
  role: 64,
  tag: 64,
} as const;

function clip(text: string, max: number): string {
  return text.slice(0, max);
}

function soundOf(asset: LibraryAsset, project: Project): AssistantLibrarySound {
  return {
    id: asset.id,
    name: clip(asset.name, SENT.name),
    role: clip(asset.role, SENT.role),
    type: asset.type === "loop" ? "loop" : "one-shot",
    tags: [
      ...new Set(
        [...asset.genres, ...asset.characters].map((tag) => clip(tag, SENT.tag)),
      ),
    ].slice(0, ASSISTANT_LIBRARY_LIMITS.maxTags),
    inProject: projectUsesSound(project, asset),
  };
}

/**
 * What a turn sends of the library: each pack and its sounds' metadata, and
 * what the project already uses, within the gateway's limits. Never a URL, a
 * storage path or a producer's own pack. Null when there is nothing to send,
 * so the turn is offered no way to recommend from an empty library.
 */
export function libraryContext(
  catalog: AssistantLibraryCatalog,
  project: Project,
): AssistantLibraryContext | null {
  let room: number = ASSISTANT_LIBRARY_LIMITS.maxSounds;
  const packs: AssistantLibraryPack[] = [];
  const sendable = catalog.packs.filter(({ pack }) => pack.id.length <= SENT.packId);
  for (const { pack, sounds } of sendable.slice(0, ASSISTANT_LIBRARY_LIMITS.maxPacks)) {
    const sent = sounds.filter((sound) => sound.id.length <= SENT.soundId).slice(0, room);
    room -= sent.length;
    packs.push({
      id: pack.id,
      name: clip(pack.name, SENT.name),
      publisher: clip(pack.publisher, SENT.name),
      version: clip(pack.version, SENT.version),
      description: pack.description.slice(
        0,
        ASSISTANT_LIBRARY_LIMITS.maxDescriptionChars,
      ),
      soundCount: pack.assetCount,
      inProject: projectHasPack(project, pack.id),
      sounds: sent.map((sound) => soundOf(sound, project)),
    });
  }
  return packs.some((pack) => pack.sounds.length > 0) ? { packs } : null;
}
