/**
 * The layout and the limits of what a user stores (#282).
 *
 * Everything a user keeps that is not a project — their personal packs today,
 * recordings and presets later — lives in Cloud Storage under
 * `users/{uid}/{kind}/…` and counts against one allowance per account. This
 * module is that contract written down once: the paths, the kinds, the cap,
 * the per-file limit, the accepted audio types, and the usage document a
 * Storage-triggered Cloud Function keeps (`functions/src/index.ts`).
 *
 * It imports nothing, so the browser, the Cloud Function bundle and the tests
 * all read the same numbers. `storage.rules` cannot import it, so it repeats
 * the cap, the file limit and the type list as literals, and
 * `userData.test.ts` fails if the two drift apart.
 */

/** 1 GB of user data per account, across every kind (decision 2 on #282). */
export const USER_DATA_CAP_BYTES = 1024 ** 3;

/** The largest single audio file an import accepts. */
export const MAX_IMPORT_FILE_BYTES = 100 * 1024 ** 2;

/**
 * The most sounds one personal pack holds. A pack is one Firestore document
 * with its sounds inline (about 1 KB each, waveform peaks included), and a
 * document cannot exceed 1 MiB, so this keeps the fullest pack at half that.
 * `firestore.rules` repeats it.
 */
export const MAX_PACK_SOUNDS = 500;

/**
 * The kinds of user data that count against {@link USER_DATA_CAP_BYTES}, one
 * per top-level folder under `users/{uid}/`. Adding recordings or presets is a
 * new entry here plus its own `storage.rules` match; the usage counter already
 * tallies any kind it is told about.
 */
export const USER_DATA_KINDS = ["packs"] as const;
export type UserDataKind = (typeof USER_DATA_KINDS)[number];

/**
 * The audio types an import accepts, by MIME type. Browsers disagree on what
 * they call a WAV or an AIFF, so every spelling seen in the wild is listed.
 * `storage.rules` accepts exactly these.
 */
export const IMPORT_CONTENT_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/aiff",
  "audio/x-aiff",
  "audio/flac",
  "audio/x-flac",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
] as const;
export type ImportContentType = (typeof IMPORT_CONTENT_TYPES)[number];

/**
 * The content type a file is stored with, from what the browser said about it
 * or, when it said nothing (some systems leave `File.type` empty), from its
 * extension. `null` means the file is not audio we accept.
 */
export function importContentType(file: {
  readonly name: string;
  readonly type: string;
}): ImportContentType | null {
  const declared = file.type.toLowerCase();
  if ((IMPORT_CONTENT_TYPES as readonly string[]).includes(declared)) {
    return declared as ImportContentType;
  }
  if (declared !== "" && declared !== "application/octet-stream") return null;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return extension ? (EXTENSION_TYPES[extension] ?? null) : null;
}

const EXTENSION_TYPES: Readonly<Record<string, ImportContentType>> = {
  wav: "audio/wav",
  wave: "audio/wav",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

/** The file extensions an import accepts, for a file picker's `accept`. */
export const IMPORT_EXTENSIONS = Object.keys(EXTENSION_TYPES).map((ext) => `.${ext}`);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Where one personal pack's audio lives: `users/{uid}/packs/{packId}/{assetId}`. */
export function packAudioPath(uid: string, packId: string, assetId: string): string {
  return `users/${uid}/packs/${packId}/${assetId}`;
}

/** Where one personal pack's document lives: `users/{uid}/packs/{packId}`. */
export function userPackDocPath(uid: string, packId: string): string {
  return `users/${uid}/packs/${packId}`;
}

/** The owner, pack and sound one stored sound's path names. */
export interface PackAudioObject {
  readonly uid: string;
  readonly packId: string;
  readonly assetId: string;
}

/** Reads {@link packAudioPath} back, or `null` for any other path. */
export function parsePackAudioPath(path: string): PackAudioObject | null {
  const match = /^users\/([^/]+)\/packs\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return null;
  const [, uid, packId, assetId] = match;
  return { uid, packId, assetId };
}

/** The owner and kind a storage object belongs to, or `null` if it is not user data. */
export interface UserDataObject {
  readonly uid: string;
  readonly kind: UserDataKind;
}

/**
 * Reads `users/{uid}/{kind}/…` back out of an object path. Anything else in
 * the bucket — the factory library, a kind nobody has declared — is `null`,
 * so the usage counter never charges a user for an object that is not theirs.
 */
export function parseUserDataPath(path: string): UserDataObject | null {
  const match = /^users\/([^/]+)\/([^/]+)\/.+$/.exec(path);
  if (!match) return null;
  const [, uid, kind] = match;
  if (!(USER_DATA_KINDS as readonly string[]).includes(kind)) return null;
  return { uid, kind: kind as UserDataKind };
}

// ---------------------------------------------------------------------------
// The usage document
// ---------------------------------------------------------------------------

/** The Firestore document holding one user's running total. */
export function usageDocPath(uid: string): string {
  return `users/${uid}/usage/current`;
}

/**
 * The ledger entry for one storage object, under the usage document. Keyed by
 * the object's path (encoded, since a document ID cannot hold `/`), so an
 * event delivered twice, or out of order, is recognised rather than counted
 * twice.
 */
export function usageObjectDocPath(uid: string, objectPath: string): string {
  return `${usageDocPath(uid)}/objects/${encodeURIComponent(objectPath)}`;
}

/** What the usage document holds. Clients read it; only the function writes it. */
export interface UsageDocument {
  readonly totalBytes: number;
  readonly byKind: Readonly<Partial<Record<UserDataKind, number>>>;
  readonly updatedAt: number;
}

/**
 * What the ledger did with one generation of an object:
 *
 *  - `counted`: its bytes are in the total;
 *  - `refused`: it arrived with the account already full, so the function
 *    deleted it again and never counted it (two uploads raced past the rules);
 *  - `deleted`: it is gone. The entry stays as a tombstone, so a write event
 *    for that generation delivered late is recognised and not counted.
 */
export type UsageLedgerState = "counted" | "refused" | "deleted";

/** One ledger entry: what an object was counted as. */
export interface UsageLedgerEntry {
  readonly kind: UserDataKind;
  /** Bytes in the total for this object: zero unless `state` is `counted`. */
  readonly bytes: number;
  /** The object generation this entry is about; older events are ignored. */
  readonly generation: string;
  readonly state: UsageLedgerState;
}

/** How full an account is, as the client shows it. */
export interface UserDataUsage {
  readonly usedBytes: number;
  readonly capBytes: number;
}

/**
 * Where an account stands against its allowance after adding `incomingBytes`:
 * `ok`, `near` (past 90%, warn before it blocks), or `over` (the write would be
 * refused, so do not start it).
 */
export function usageStanding(
  usage: UserDataUsage,
  incomingBytes = 0,
): "ok" | "near" | "over" {
  const after = usage.usedBytes + incomingBytes;
  if (after > usage.capBytes) return "over";
  return after >= usage.capBytes * 0.9 ? "near" : "ok";
}

/**
 * The storage meter's size text: "512 bytes", "1.5 KB", "12 MB", "1 GB".
 *
 * It divides by 1024 at each step but prints the familiar "KB / MB / GB"
 * labels, so the "1 GB" allowance is 1024³ bytes (`USER_DATA_CAP_BYTES`). It is
 * not `formatExportSize` (`editor/export/stemSelection.ts`), which prints binary
 * MiB / GiB. The meter keeps these labels because they are the product's wording
 * for a producer's own storage; switching to GiB would change what the meter
 * says, not just how it is named. Below 10 it keeps one decimal, from 10 up it
 * rounds to whole numbers.
 */
export function formatStorageSize(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} bytes`;
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
