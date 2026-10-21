import type { Analytics } from "../../analytics/analytics";
import type { Project } from "../../domain/entities";
import { type LibrarySample, toLibrarySample } from "../../library/insertion";
import type { LibraryClient } from "../../library/libraryClient";
import type { LibraryAsset } from "../../library/manifest";
import {
  checkPackUpgrade,
  type HeldPackRefs,
  type PackUpgradeCheck,
} from "../../library/packUpgrade";

/**
 * What the library's Insert hears back (#892). Inserting either lands, is
 * refused with one plain sentence the footer shows beside Insert, or needs the
 * producer's say-so to upgrade a pack the project pins at an older version.
 */
export type LibraryInsertOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: false;
      readonly upgrade: {
        readonly packName: string;
        readonly version: string;
        /** Sounds the upgrade would leave missing; `null` when they could not be counted. */
        readonly missing: number | null;
      };
    };

/** Whether the producer has already chosen "Upgrade anyway" for this insert. */
export interface LibraryInsertOptions {
  readonly upgradeAnyway: boolean;
}

/** What inserting needs from the editor that hosts the library. */
export interface LibraryInsertHost {
  project(): Project | null | undefined;
  readonly client: LibraryClient;
  readonly analytics: Analytics;
  /**
   * Pack versions the editor holds itself — the owner's personal packs
   * (#282) — so upgrading to one is checked against it, not the factory index.
   */
  readonly heldPacks?: HeldPackRefs;
  /**
   * Dispatches the insert for `sample` onto whatever the library was opened
   * for, as one transaction. `null` when it landed, else the sentence saying
   * why it did not.
   */
  insert(sample: LibrarySample): string | null;
}

/**
 * Inserts a sound chosen in the library, upgrading its pack's pin in the same
 * transaction when the project holds an older version (#892): without asking
 * when the upgrade is safe, and only once the producer has chosen "Upgrade
 * anyway" when it would leave sounds missing.
 */
export async function insertFromLibrary(
  host: LibraryInsertHost,
  asset: LibraryAsset,
  options: LibraryInsertOptions,
): Promise<LibraryInsertOutcome> {
  const sample = toLibrarySample(asset);
  if (!sample) {
    return {
      ok: false,
      reason: `Couldn't insert ${asset.name}: it has no audio to load.`,
    };
  }
  const project = host.project();
  if (!project) {
    return {
      ok: false,
      reason: `Couldn't insert ${asset.name}: the project isn't open.`,
    };
  }
  const check = await checkPackUpgrade(project, sample, host.client, host.heldPacks);
  if (check.kind === "unsafe" && !options.upgradeAnyway) {
    return {
      ok: false,
      upgrade: {
        packName: asset.packName,
        version: sample.packVersion,
        missing: check.missing,
      },
    };
  }
  const refusal = host.insert(sample);
  if (refusal !== null) return { ok: false, reason: refusal };
  logUpgrade(host.analytics, check);
  return { ok: true };
}

/**
 * A sound dropped onto the instrument panel. A drop has no footer to ask in,
 * so it takes a safe upgrade as an insert does but leaves the project alone
 * when the upgrade would make sounds go missing.
 */
export async function dropFromLibrary(
  host: LibraryInsertHost,
  sample: LibrarySample,
): Promise<boolean> {
  const project = host.project();
  if (!project) return false;
  const check = await checkPackUpgrade(project, sample, host.client, host.heldPacks);
  if (check.kind === "unsafe") return false;
  if (host.insert(sample) !== null) return false;
  logUpgrade(host.analytics, check);
  return true;
}

/** One `library_pack_upgraded` per insert that moved a pin, and its first use. */
function logUpgrade(analytics: Analytics, check: PackUpgradeCheck): void {
  if (check.kind === "none") return;
  if (check.kind === "safe") {
    analytics.log("library_pack_upgraded", {
      choice: "automatic",
      missing_sound_count: 0,
    });
  } else {
    analytics.log("library_pack_upgraded", {
      choice: "upgrade_anyway",
      ...(check.missing === null ? {} : { missing_sound_count: check.missing }),
    });
  }
  analytics.logFeatureFirstUse("pack_upgrade");
}
