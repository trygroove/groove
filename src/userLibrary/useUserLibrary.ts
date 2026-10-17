import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import type { ErrorCode } from "../analytics/errorCodes";
import { createIdFactory, type IdFactory } from "../domain/ids";
import type { LibraryAsset, LibraryPackSummary } from "../library/manifest";
import type { HeldPackRefs } from "../library/packUpgrade";
import { type Clock, systemClock } from "../shared/clock";
import {
  formatBytes,
  USER_DATA_CAP_BYTES,
  type UserDataUsage,
  usageStanding,
} from "../userData/userData";
import {
  ImportError,
  type ImportFailure,
  importFailureMessage,
  importSound,
} from "./importSound";
import { deleteUserPack, deleteUserSound } from "./packOperations";
import { type AudioDecoder, webAudioDecoder } from "./soundAnalysis";
import { getUserLibraryRepository } from "./userLibraryClient";
import type { UserLibraryRepository } from "./userLibraryRepository";
import {
  DEFAULT_PACK_NAME,
  DROP_PACK_NAME,
  newUserPack,
  renamePack,
  renameSound,
  type UserPack,
  userPackAssets,
  userPackSummary,
} from "./userPacks";

/**
 * The editor's view of a producer's personal library (#282): their packs and
 * sounds as the library browser lists them, the imports in flight, how full
 * the account is, and the actions on all of it.
 *
 * It belongs to the editor rather than to the Library view, so leaving the
 * view does not cancel an upload: an import keeps going and its sound is in
 * the pack next time the library is on screen. Leaving the editor, or a
 * different account signing in, cancels every upload still in flight.
 *
 * Personal packs need an account. For a guest every action is refused before
 * it starts and `upgradeAsked` turns on, which is the library's cue to offer
 * the upgrade-account path rather than fail silently.
 */

/** Who is signed in, as far as the personal library cares. */
export interface UserLibraryAccount {
  readonly uid: string;
  /** False for a guest (an anonymous Firebase identity). */
  readonly registered: boolean;
  /**
   * An internal or admin account (GRV-112), held to no allowance: its usage
   * is still shown, but nothing is refused or warned about for its size.
   */
  readonly unlimited?: boolean;
}

/** The allowance an account is held to: none for an unlimited one. */
export function capBytesFor(account: UserLibraryAccount | null): number {
  return account?.unlimited ? Number.POSITIVE_INFINITY : USER_DATA_CAP_BYTES;
}

/** One file being imported, shown as its own row until it lands. */
export interface ImportRow {
  readonly id: string;
  readonly packId: string;
  readonly fileName: string;
  /** 0-1 while uploading. */
  readonly progress: number;
  readonly state: "uploading" | "failed" | "cancelled";
  /** Why it failed, in words the producer can act on. */
  readonly message: string | null;
  /** A failed upload that trying again could fix (a flaky write, not a refused file). */
  readonly retryable: boolean;
}

export type ImportMethod = "drop" | "picker";

export interface UserLibrary {
  /** `guest` when there is no account to store sounds under. */
  readonly status: Accessor<"guest" | "loading" | "ready" | "error">;
  readonly packs: Accessor<readonly UserPack[]>;
  /** Every personal sound, as library assets. */
  readonly assets: Accessor<readonly LibraryAsset[]>;
  /** Every personal pack, as the library lists packs. */
  readonly summaries: Accessor<readonly LibraryPackSummary[]>;
  readonly imports: Accessor<readonly ImportRow[]>;
  readonly usage: Accessor<UserDataUsage>;
  /** A message about the allowance or the last thing that went wrong. */
  readonly notice: Accessor<string | null>;
  /** A guest tried to use the personal library: offer them an account. */
  readonly upgradeAsked: Accessor<boolean>;
  /** Make an empty pack and return its ID, or `null` for a guest. */
  createPack(method: "button" | "drop", name?: string): string | null;
  renamePack(packId: string, name: string): Promise<void>;
  /** Rename one sound; its pack keeps its version. */
  renameSound(packId: string, assetId: string, name: string): Promise<void>;
  deletePack(packId: string): Promise<void>;
  deleteSound(packId: string, assetId: string): Promise<void>;
  /**
   * Import files into a pack, or into "My Sounds" when `packId` is `null`
   * (a drop on empty space). Resolves once every file has landed or failed.
   */
  importFiles(
    packId: string | null,
    files: readonly File[],
    method: ImportMethod,
  ): Promise<void>;
  cancelImport(id: string): void;
  dismissImport(id: string): void;
  /** Upload a failed row's file again, in its own place. */
  retryImport(id: string): void;
  /**
   * The sounds one of the owner's packs holds at `version`, by storage ref,
   * or `null` when that is not the version they hold. Inserting a sound added
   * since the project pinned the pack checks the upgrade against this (#282).
   */
  readonly heldPack: HeldPackRefs;
}

export interface UseUserLibraryOptions {
  readonly account: Accessor<UserLibraryAccount | null>;
  readonly repository?: () => Promise<UserLibraryRepository>;
  readonly analytics?: Analytics;
  readonly decode?: AudioDecoder;
  readonly ids?: IdFactory;
  readonly clock?: Clock;
}

/** The analytics code for each way an import can fail. */
const ERROR_CODE: Readonly<Record<ImportFailure, ErrorCode>> = {
  unsupported_type: "unsupported_format",
  too_large: "asset_too_large",
  over_allowance: "quota_exceeded",
  pack_full: "pack_full",
  undecodable: "decode_failed",
  cancelled: "aborted",
  permission_denied: "permission_denied",
  network: "network",
  not_found: "not_found",
  unknown: "unknown",
};

/**
 * The failures a second attempt could get past: not a refused or unreadable
 * file. A permission failure is among them: away from the allowance (which is
 * reported as `over_allowance`), it can be a network retry the rules refused
 * (GRV-77), and a retry writes to a fresh path.
 */
const RETRYABLE: ReadonlySet<ImportFailure> = new Set([
  "network",
  "unknown",
  "not_found",
  "permission_denied",
]);

/** What the allowance line says once an account is at least 90% full. */
export function allowanceNotice(usage: UserDataUsage): string | null {
  if (usageStanding(usage) === "ok") return null;
  const percent = Math.min(100, Math.floor((usage.usedBytes / usage.capBytes) * 100));
  return `Your library is ${percent}% full (${formatBytes(usage.usedBytes)} of ${formatBytes(
    usage.capBytes,
  )}). Delete sounds you no longer use to make room.`;
}

export function useUserLibrary(options: UseUserLibraryOptions): UserLibrary {
  const analytics = options.analytics ?? defaultAnalytics;
  const loadRepository = options.repository ?? getUserLibraryRepository;
  const decode = options.decode ?? webAudioDecoder;
  const ids = options.ids ?? createIdFactory();
  const clock = options.clock ?? systemClock;

  const [status, setStatus] = createSignal<"guest" | "loading" | "ready" | "error">(
    "guest",
  );
  const [packs, setPacks] = createSignal<readonly UserPack[]>([]);
  const [imports, setImports] = createSignal<readonly ImportRow[]>([]);
  const [usedBytes, setUsedBytes] = createSignal(0);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [upgradeAsked, setUpgradeAsked] = createSignal(false);

  // Plain mirrors of what the actions read back. A Solid 2 signal read in the
  // same tick as its write still answers the old value, and these are read
  // from event handlers that also write.
  let current: { uid: string; repository: UserLibraryRepository } | null = null;
  /** No registered account is signed in. */
  let guest = true;
  /** The account's packs have arrived at least once. */
  let packsLoaded = false;
  let latestPacks: readonly UserPack[] = [];
  let latestUsed = 0;
  /** The usage total has arrived at least once. */
  let usageLoaded = false;
  /**
   * Imports the usage total has not counted yet, by import row ID: every one
   * from the moment its upload starts until the total rises to include it.
   * The total moves only once the Cloud Function counts a stored file, a
   * moment after it lands, so these count against the allowance here in the
   * meantime, and neither a multi-file drop nor a second drop straight after
   * the first can slip past it. `path` is set once the sound is listed: one its
   * pack no longer lists (deleted, or refused over the allowance) stops
   * counting, and so does one whose import failed.
   */
  const uncounted = new Map<string, { bytes: number; path: string | null }>();
  const uncountedBytes = () =>
    [...uncounted.values()].reduce((sum, entry) => sum + entry.bytes, 0);

  /** The usage total rose by `delta`: that much of the oldest is counted now. */
  function settleUncounted(delta: number): void {
    let left = delta;
    for (const [id, entry] of uncounted) {
      if (left <= 0) break;
      const settled = Math.min(entry.bytes, left);
      left -= settled;
      if (settled === entry.bytes) uncounted.delete(id);
      else uncounted.set(id, { ...entry, bytes: entry.bytes - settled });
    }
  }

  /** Forget landed imports their packs no longer list. */
  function forgetUnlisted(next: readonly UserPack[]): void {
    if (uncounted.size === 0) return;
    const listed = new Set(
      next.flatMap((pack) => pack.assets.map((asset) => asset.storagePath)),
    );
    for (const [id, entry] of uncounted) {
      if (entry.path !== null && !listed.has(entry.path)) uncounted.delete(id);
    }
  }

  const controllers = new Map<string, AbortController>();
  /** The file behind each import row, kept so a failed upload can be retried. */
  const importFilesById = new Map<string, { file: File; method: ImportMethod }>();
  /** The pack each import in flight is headed for, by import row ID. */
  const inFlight = new Map<string, string>();
  /** Packs made here whose document is still being written, by ID. */
  const creating = new Map<string, Promise<boolean>>();
  /**
   * Files dropped while the account's packs were still loading. They import
   * once the packs arrive (a drop on empty space has to know whether "My
   * Sounds" exists first), and are let go if the account changes.
   */
  let queued: {
    readonly packId: string | null;
    readonly files: readonly File[];
    readonly method: ImportMethod;
    readonly done: () => void;
  }[] = [];

  function releaseQueue(): void {
    const waiting = queued;
    queued = [];
    for (const entry of waiting) entry.done();
  }

  function flushQueue(): void {
    const waiting = queued;
    queued = [];
    for (const entry of waiting) {
      void importFiles(entry.packId, entry.files, entry.method).then(entry.done);
    }
  }

  /** Cancel every upload in flight: their account is no longer the one here. */
  function abortAll(): void {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  }

  const usage = createMemo<UserDataUsage>(() => ({
    usedBytes: usedBytes(),
    capBytes: capBytesFor(options.account()),
  }));
  const assets = createMemo(() => packs().flatMap(userPackAssets));
  const summaries = createMemo(() => packs().map(userPackSummary));
  const notice = createMemo(() => failure() ?? allowanceNotice(usage()));

  // Subscribe while a registered account is signed in; a guest, a sign-out or
  // a different account tears the subscription down.
  createEffect(
    () => {
      const account = options.account();
      return account?.registered ? account.uid : null;
    },
    (uid) => {
      current = null;
      guest = uid === null;
      packsLoaded = false;
      latestPacks = [];
      latestUsed = 0;
      usageLoaded = false;
      uncounted.clear();
      creating.clear();
      setPacks([]);
      setImports([]);
      setUsedBytes(0);
      if (uid === null) {
        setStatus("guest");
        return;
      }
      setStatus("loading");
      setUpgradeAsked(false);
      let stopped = false;
      const stops: (() => void)[] = [];
      void loadRepository().then(
        (repository) => {
          if (stopped) return;
          current = { uid, repository };
          stops.push(
            repository.watchPacks(
              uid,
              (next) => {
                latestPacks = next;
                forgetUnlisted(next);
                setPacks(next);
                setStatus("ready");
                if (!packsLoaded) {
                  packsLoaded = true;
                  flushQueue();
                }
              },
              () => failLoading(),
            ),
            repository.watchUsage(uid, (bytes) => {
              // The first total is where the account stood, not a rise.
              if (usageLoaded) settleUncounted(bytes - latestUsed);
              usageLoaded = true;
              latestUsed = bytes;
              setUsedBytes(bytes);
            }),
          );
        },
        () => failLoading(),
      );
      return () => {
        stopped = true;
        for (const stop of stops) stop();
        // A different account, a sign-out, or the editor going away: nothing
        // started for this account carries on, and nothing waits for it.
        abortAll();
        releaseQueue();
      };
    },
  );

  function failLoading(): void {
    setStatus("error");
    if (queued.length > 0) {
      setFailure("Your packs couldn't load, so the dropped files weren't imported.");
    }
    releaseQueue();
  }

  /** The signed-in account's repository, or `null` after asking a guest to sign up. */
  function session() {
    if (!current) {
      if (guest) setUpgradeAsked(true);
      return null;
    }
    return current;
  }

  function firstUse(): void {
    analytics.logFeatureFirstUse("user_packs");
  }

  /**
   * Make a pack: listed straight away, so its name can be typed while its
   * document is written. `landed` settles once it is (false if it failed),
   * and every import into it waits for that.
   */
  function startPack(
    active: { uid: string; repository: UserLibraryRepository },
    method: "button" | "drop",
    name: string,
  ): { readonly id: string; readonly landed: Promise<boolean> } {
    const pack = newUserPack(ids("pack"), name, clock.now());
    setFailure(null);
    latestPacks = [...latestPacks, pack];
    setPacks(latestPacks);
    const landed = active.repository.createPack(active.uid, pack).then(
      () => {
        analytics.log("user_pack_created", { method });
        firstUse();
        return true;
      },
      () => {
        setFailure("The pack could not be created. Try again.");
        return false;
      },
    );
    creating.set(pack.id, landed);
    void landed.then(() => {
      if (creating.get(pack.id) === landed) creating.delete(pack.id);
    });
    return { id: pack.id, landed };
  }

  function createPack(
    method: "button" | "drop",
    name = DEFAULT_PACK_NAME,
  ): string | null {
    const active = session();
    if (!active) return null;
    return startPack(active, method, name).id;
  }

  /**
   * Whether `packId`'s document is written. A pack made a moment ago is
   * listed before it is, so a change to it waits for that, and is let go if
   * it never landed.
   */
  async function packLanded(packId: string): Promise<boolean> {
    return (await creating.get(packId)) !== false;
  }

  async function rename(packId: string, name: string): Promise<void> {
    const active = session();
    if (!active) return;
    if (!(await packLanded(packId))) return;
    try {
      await active.repository.updatePack(active.uid, packId, (pack) =>
        renamePack(pack, name, clock.now()),
      );
    } catch {
      setFailure("The pack could not be renamed. Try again.");
    }
  }

  async function renameOneSound(
    packId: string,
    assetId: string,
    name: string,
  ): Promise<void> {
    const active = session();
    if (!active) return;
    try {
      await active.repository.updatePack(active.uid, packId, (pack) =>
        renameSound(pack, assetId, name, clock.now()),
      );
    } catch {
      setFailure("The sound could not be renamed. Try again.");
    }
  }

  function heldPack(packId: string, version: string): ReadonlySet<string> | null {
    const pack = latestPacks.find((candidate) => candidate.id === packId);
    if (!pack || pack.version !== version) return null;
    return new Set(pack.assets.map((asset) => asset.storagePath));
  }

  async function deletePack(packId: string): Promise<void> {
    const active = session();
    const pack = latestPacks.find((candidate) => candidate.id === packId);
    if (!active || !pack) return;
    try {
      await deleteUserPack(active.repository, active.uid, pack);
    } catch {
      setFailure("The pack could not be deleted. Try again.");
    }
  }

  async function deleteSound(packId: string, assetId: string): Promise<void> {
    const active = session();
    if (!active) return;
    try {
      await deleteUserSound(active.repository, active.uid, packId, assetId, clock);
    } catch {
      setFailure("The sound could not be deleted. Try again.");
    }
  }

  function updateRow(id: string, change: Partial<ImportRow>): void {
    setImports((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...change } : row)),
    );
  }

  function removeRow(id: string): void {
    importFilesById.delete(id);
    setImports((rows) => rows.filter((row) => row.id !== id));
  }

  /**
   * The pack a drop on empty space imports into: "My Sounds", made if need
   * be. Resolves once that pack exists, or `null` if it could not be made.
   */
  async function dropPack(active: {
    uid: string;
    repository: UserLibraryRepository;
  }): Promise<string | null> {
    const existing = latestPacks.find((pack) => pack.name === DROP_PACK_NAME);
    if (existing) return existing.id;
    const { id, landed } = startPack(active, "drop", DROP_PACK_NAME);
    return (await landed) ? id : null;
  }

  async function importOne(
    active: { uid: string; repository: UserLibraryRepository },
    packId: string,
    file: File,
    method: ImportMethod,
    retryOf?: string,
  ): Promise<void> {
    const id = `import-${ids("asset")}`;
    importFilesById.set(id, { file, method });
    const controller = new AbortController();
    controllers.set(id, controller);
    const row: ImportRow = {
      id,
      packId,
      fileName: file.name,
      progress: 0,
      state: "uploading",
      message: null,
      retryable: false,
    };
    // A retry takes the failed row's place in the list.
    setImports((rows) =>
      retryOf && rows.some((entry) => entry.id === retryOf)
        ? rows.map((entry) => (entry.id === retryOf ? row : entry))
        : [...rows, row],
    );
    if (retryOf) importFilesById.delete(retryOf);
    // Everything already on its way counts, so a multi-file drop cannot slip
    // past the allowance one file at a time.
    const before = {
      usedBytes: latestUsed + uncountedBytes(),
      capBytes: capBytesFor(options.account()),
    };
    // Every sound already in the pack or on its way there, so a drop of many
    // files is refused at the pack's limit before the extra ones upload.
    const soundsInPack =
      (latestPacks.find((pack) => pack.id === packId)?.assets.length ?? 0) +
      [...inFlight.values()].filter((target) => target === packId).length;
    inFlight.set(id, packId);
    uncounted.set(id, { bytes: file.size, path: null });
    try {
      const asset = await importSound({
        repository: active.repository,
        uid: active.uid,
        packId,
        file,
        decode,
        ids,
        clock,
        usage: before,
        soundsInPack,
        signal: controller.signal,
        onProgress: (progress) => updateRow(id, { progress }),
      });
      // Landed: it counts until the total does, or until its pack lets it go.
      const waiting = uncounted.get(id);
      if (waiting) uncounted.set(id, { ...waiting, path: asset.storagePath });
      removeRow(id);
      analytics.log("sound_imported", {
        asset_type: asset.type === "loop" ? "loop" : "one_shot",
        method,
      });
      firstUse();
    } catch (error) {
      uncounted.delete(id);
      let reason: ImportFailure = error instanceof ImportError ? error.reason : "unknown";
      // The rules refuse a write over the allowance as a plain permission
      // failure; near the cap, that is what it was.
      if (reason === "permission_denied" && usageStanding(before, file.size) !== "ok") {
        reason = "over_allowance";
      }
      if (reason === "cancelled") {
        updateRow(id, { state: "cancelled", message: importFailureMessage(reason) });
      } else {
        updateRow(id, {
          state: "failed",
          message: importFailureMessage(reason),
          retryable: RETRYABLE.has(reason),
        });
        analytics.log("sound_import_failed", { error_code: ERROR_CODE[reason] });
      }
    } finally {
      controllers.delete(id);
      inFlight.delete(id);
    }
  }

  async function importFiles(
    packId: string | null,
    files: readonly File[],
    method: ImportMethod,
  ): Promise<void> {
    if (files.length === 0) return;
    if (!guest && !packsLoaded) {
      // Signed in, but the packs have not arrived: hold the files until they do.
      return new Promise<void>((done) => {
        queued.push({ packId, files, method, done });
      });
    }
    const active = session();
    if (!active) return;
    setFailure(null);
    const target = packId ?? (await dropPack(active));
    if (!target) return;
    // A pack made a moment ago has to exist before a sound can be listed in it.
    if ((await creating.get(target)) === false) return;
    if (current !== active) return;
    await Promise.all(files.map((file) => importOne(active, target, file, method)));
  }

  return {
    status,
    packs,
    assets,
    summaries,
    imports,
    usage,
    notice,
    upgradeAsked,
    createPack,
    renamePack: rename,
    renameSound: renameOneSound,
    deletePack,
    deleteSound,
    importFiles,
    cancelImport: (id) => controllers.get(id)?.abort(),
    dismissImport: removeRow,
    retryImport: (id) => {
      const entry = importFilesById.get(id);
      const row = imports().find((candidate) => candidate.id === id);
      const active = session();
      if (!entry || !row || row.state !== "failed" || !active) return;
      void importOne(active, row.packId, entry.file, entry.method, id);
    },
    heldPack: (packId, version) => heldPack(packId, version),
  };
}
