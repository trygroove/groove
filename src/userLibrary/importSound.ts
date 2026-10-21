import type { IdFactory } from "../domain/ids";
import type { Clock } from "../shared/clock";
import {
  formatStorageSize,
  importContentType,
  MAX_IMPORT_FILE_BYTES,
  MAX_PACK_SOUNDS,
  packAudioPath,
  type UserDataUsage,
  usageStanding,
} from "../userData/userData";
import { type AudioDecoder, analyseSound, UndecodableAudioError } from "./soundAnalysis";
import {
  type StorageFailure,
  type UploadOptions,
  UserLibraryError,
  type UserLibraryRepository,
} from "./userLibraryRepository";
import { addSound, packHasRoom, type UserPackAsset } from "./userPacks";

/**
 * Bringing one file into a personal pack (#282, LIB-03).
 *
 * The order is what keeps the library clean: everything that can refuse a
 * file — its type, its size, the account's allowance, whether it decodes —
 * runs before a byte is uploaded, so a refusal leaves nothing behind. The
 * upload goes next and the pack document last, so a sound is only ever listed
 * once its audio is stored; if the pack write fails, or the import is cancelled
 * between the two, the stored audio is deleted again. A failed or cancelled
 * import therefore never leaves a partial or unplayable sound.
 */

/** Why an import did not land, one per message the producer can act on. */
export type ImportFailure =
  | "unsupported_type"
  | "too_large"
  | "over_allowance"
  | "pack_full"
  | "undecodable"
  | StorageFailure;

export class ImportError extends Error {
  constructor(
    readonly reason: ImportFailure,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

/** What the producer is told, per reason. Never the file's name or a URL. */
export function importFailureMessage(reason: ImportFailure): string {
  switch (reason) {
    case "unsupported_type":
      return "Not an audio file we can import. Use WAV, AIFF, FLAC, MP3, OGG or M4A.";
    case "too_large":
      return `Too large to import. Files can be up to ${formatStorageSize(MAX_IMPORT_FILE_BYTES)}.`;
    case "over_allowance":
      return "Your library is full. Delete sounds you no longer use to make room.";
    case "pack_full":
      return `This pack is full: a pack holds up to ${MAX_PACK_SOUNDS} sounds. Start a new pack for more.`;
    case "undecodable":
      return "This file could not be played. It may be damaged.";
    case "cancelled":
      return "Cancelled.";
    case "permission_denied":
      // The rules refused it. The client checks every limit it knows before
      // uploading, so what is left is a limit it could not see (a pack filled
      // from another tab) or a sign-in that expired: say both, blame neither.
      return "Your library couldn't take this sound. The pack may be full, or your sign-in may have expired.";
    case "network":
      return "Upload failed. Check your connection and try again.";
    case "not_found":
      return "The pack is gone, so the sound was not added.";
    case "unknown":
      return "Upload failed. Try again.";
  }
}

export interface ImportSoundOptions extends UploadOptions {
  readonly repository: UserLibraryRepository;
  readonly uid: string;
  readonly packId: string;
  readonly file: File;
  readonly decode: AudioDecoder;
  readonly ids: IdFactory;
  readonly clock: Clock;
  /** The account's standing before this file, from the usage document. */
  readonly usage: UserDataUsage;
  /**
   * How many sounds the caller knows the pack holds (or is about to), so a
   * full pack refuses the file before it uploads. The pack write checks again
   * against what is stored.
   */
  readonly soundsInPack?: number;
}

/** Import one file into one pack. Rejects with an {@link ImportError}. */
export async function importSound(options: ImportSoundOptions): Promise<UserPackAsset> {
  const { repository, uid, packId, file, signal } = options;
  const contentType = importContentType(file);
  if (contentType === null) {
    throw new ImportError("unsupported_type", "Unsupported file type");
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new ImportError("too_large", "File over the per-file limit");
  }
  if (usageStanding(options.usage, file.size) === "over") {
    throw new ImportError("over_allowance", "Import would exceed the allowance");
  }
  if (!packHasRoom(options.soundsInPack ?? 0)) {
    throw new ImportError("pack_full", "The pack holds as many sounds as it can");
  }
  if (file.size === 0) throw new ImportError("undecodable", "Empty file");

  let analysis: Awaited<ReturnType<typeof analyseSound>>;
  try {
    analysis = await analyseSound(file, options.decode);
  } catch (error) {
    if (error instanceof UndecodableAudioError) {
      throw new ImportError("undecodable", error.message);
    }
    throw error;
  }
  throwIfCancelled(signal);

  const assetId = options.ids("asset");
  const path = packAudioPath(uid, packId, assetId);
  try {
    await repository.uploadAudio(path, file, contentType, {
      onProgress: options.onProgress,
      signal,
    });
  } catch (error) {
    throw asImportError(error);
  }

  try {
    throwIfCancelled(signal);
    const now = options.clock.now();
    const stored = await repository.updatePack(uid, packId, (pack) => {
      if (!packHasRoom(pack.assets.length)) {
        throw new ImportError("pack_full", "The pack holds as many sounds as it can");
      }
      return addSound(
        pack,
        {
          id: assetId,
          name: analysis.name,
          type: analysis.type,
          family: analysis.family,
          role: analysis.role,
          storagePath: path,
          contentType,
          sizeBytes: file.size,
          durationSeconds: analysis.durationSeconds,
          sampleRate: analysis.sampleRate,
          channelCount: analysis.channelCount,
          bpm: analysis.bpm,
          peaks: analysis.peaks ? [...analysis.peaks] : null,
          createdAt: now,
        },
        now,
      );
    });
    const asset = stored.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new ImportError("unknown", "The sound was not stored");
    return asset;
  } catch (error) {
    // The audio is stored but the pack does not list it: take it back out, so
    // nothing unlisted counts against the allowance or lingers in storage.
    await repository.deleteAudio(path).catch(() => undefined);
    throw asImportError(error);
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportError("cancelled", "Import cancelled");
}

function asImportError(error: unknown): ImportError {
  if (error instanceof ImportError) return error;
  if (error instanceof UserLibraryError)
    return new ImportError(error.reason, error.message);
  return new ImportError("unknown", error instanceof Error ? error.message : "Failed");
}
