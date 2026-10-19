import { beforeEach, describe, expect, it } from "vitest";
import { createAsset, createPack, type Project, packVersion } from "../domain";
import { addAsset, addPack, removeAsset, setPadAsset, setSample } from ".";
import { executeCommand, executeTransaction } from "./execute";
import { CommandHistory } from "./history";
import { findTrack } from "./projectEdits";
import {
  type CommandTestProject,
  createCommandTestProject,
  createTestFactoryContext,
} from "./testProjects";

/**
 * `asset.add` / `asset.remove` (LIB-05, invariant 12).
 *
 * The behaviour worth pinning is not the array splice: it is that carrying a
 * sound and pointing at it commit as one transaction, that the derived pack
 * dependency list follows the assets rather than being maintained alongside
 * them, and that an asset something still resolves cannot be dropped.
 */

function apply(project: Project, command: Parameters<typeof executeCommand>[1]): Project {
  const result = executeCommand(project, command);
  if (!result.ok) {
    throw new Error(`Expected success: ${result.issues[0].message}`);
  }
  return result.project;
}

/** The pack shelf as a set of `packId@version` keys. */
function shelfOf(project: Project): string[] {
  return project.metadata.addedPacks
    .map((entry) => `${entry.packId}@${entry.version}`)
    .sort();
}

/** A sound from a pack the fixture does not carry. */
function libraryAsset(seed = "asset-test") {
  const context = createTestFactoryContext(seed);
  return createAsset(context, {
    pack: createPack(context, { name: "Test Extras" }),
    name: "Closed Hat",
    storageRef: "samples/house/drums/hh/909-hh.wav",
  });
}

describe("asset.add", () => {
  let fixture: CommandTestProject;

  beforeEach(() => {
    fixture = createCommandTestProject();
  });

  it("carries the asset and derives the pack it resolves from", () => {
    const asset = libraryAsset();
    const next = apply(fixture.project, addAsset(asset));

    expect(next.song.assets.at(-1)).toEqual(asset);
    expect(
      next.metadata.packDependencies.some(
        (dependency) => dependency.packId === asset.packId,
      ),
    ).toBe(true);
    // The shelf follows the dependency, so the pack the sound came from is
    // browsable without a second command (LIB-08).
    expect(next.metadata.addedPacks.some((entry) => entry.packId === asset.packId)).toBe(
      true,
    );
  });

  it("loads a dropped sound onto a sampler as one undoable transaction", () => {
    const asset = libraryAsset();
    const history = new CommandHistory(fixture.project);

    const result = history.execute([
      addAsset(asset),
      setSample(fixture.trackAId, asset.id),
    ]);
    expect(result.ok, result.ok ? "" : result.issues[0].message).toBe(true);

    const instrument = findTrack(history.project, fixture.trackAId)?.instrument;
    expect(instrument?.kind === "sampler" && instrument.assetId).toBe(asset.id);
    expect(history.project.metadata.revision).toBe(fixture.project.metadata.revision + 1);

    // One undo takes back both halves: the sampler holds what it held, and the
    // project no longer carries a sound nothing plays.
    history.undo();
    const restored = findTrack(history.project, fixture.trackAId)?.instrument;
    expect(restored?.kind === "sampler" && restored.assetId).toBe(
      fixture.assetIds.sampler,
    );
    expect(
      history.project.song.assets.some((candidate) => candidate.id === asset.id),
    ).toBe(false);
  });

  it("names a transaction for what the sound was carried in for (GRV-160)", () => {
    const asset = libraryAsset();
    const carried = executeTransaction(fixture.project, [
      addAsset(asset),
      setSample(fixture.trackAId, asset.id),
    ]);
    if (!carried.ok) throw new Error(carried.issues[0].message);
    // The label is the sampler change alone: the asset is left out of the
    // count as well as the name.
    expect(carried.summary).not.toContain("to the project");
    expect(carried.summary).not.toContain("more change");

    // On its own it still names the transaction.
    const only = executeCommand(fixture.project, addAsset(asset));
    expect(only.ok && only.summary).toBe("Add Closed Hat to the project");
  });

  it("undoes the pack shelving the add caused, and redo shelves it again (GRV-50)", () => {
    const asset = libraryAsset();
    const shelved = { packId: asset.packId, version: asset.packVersion };
    const history = new CommandHistory(fixture.project);

    history.execute([addAsset(asset)]);
    expect(history.project.metadata.addedPacks).toContainEqual(shelved);
    expect(history.undo()?.ok).toBe(true);
    // The shelf is a set: reconciling it sorts it, so compare membership.
    expect(shelfOf(history.project)).toEqual(shelfOf(fixture.project));
    expect(history.redo()?.ok).toBe(true);
    expect(history.project.metadata.addedPacks).toContainEqual(shelved);
  });

  it("puts a shelved-but-unused pack back at its own version on undo (GRV-50)", () => {
    const asset = libraryAsset();
    const older = { packId: asset.packId, version: packVersion("0.9.0") };
    const history = new CommandHistory(fixture.project);
    history.execute([addPack(older)]);
    const withOlder = history.project;

    history.execute([addAsset(asset)]);
    expect(history.project.metadata.addedPacks).toContainEqual({
      packId: asset.packId,
      version: asset.packVersion,
    });
    expect(history.undo()?.ok).toBe(true);
    expect(shelfOf(history.project)).toEqual(shelfOf(withOlder));
  });

  it("inserts at an explicit index rather than appending", () => {
    const asset = libraryAsset();
    const next = apply(fixture.project, addAsset(asset, 1));
    expect(next.song.assets[1]).toEqual(asset);
    expect(next.song.assets).toHaveLength(fixture.project.song.assets.length + 1);
  });

  it("rejects an asset the project already carries", () => {
    const existing = fixture.project.song.assets[0];
    const result = executeCommand(fixture.project, addAsset(existing));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.issues[0].message).toMatch(/already/);
  });

  it("rejects an index past the end rather than appending quietly", () => {
    const result = executeCommand(fixture.project, addAsset(libraryAsset(), 99));
    expect(result.ok).toBe(false);
  });
});

describe("asset.remove", () => {
  let fixture: CommandTestProject;

  beforeEach(() => {
    fixture = createCommandTestProject();
  });

  it("drops an asset nothing loads", () => {
    const next = apply(fixture.project, removeAsset(fixture.assetIds.unused));
    expect(next.song.assets.some((asset) => asset.id === fixture.assetIds.unused)).toBe(
      false,
    );
  });

  it("refuses an asset a sampler still loads, naming the track", () => {
    const result = executeCommand(fixture.project, removeAsset(fixture.assetIds.sampler));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.issues[0].message).toContain(fixture.trackAId);
    expect(result.project).toBe(fixture.project);
  });

  it("refuses an asset a drum pad still loads", () => {
    const result = executeCommand(fixture.project, removeAsset(fixture.assetIds.pad));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.issues[0].message).toContain(fixture.trackBId);
  });

  it("drops an asset once the pad that held it lets go, in one transaction", () => {
    const result = executeTransaction(fixture.project, [
      setPadAsset(fixture.trackBId, fixture.padIds[0], null),
      removeAsset(fixture.assetIds.pad),
    ]);
    expect(result.ok, result.ok ? "" : result.issues[0].message).toBe(true);
    if (!result.ok) return;
    expect(
      result.project.song.assets.some((asset) => asset.id === fixture.assetIds.pad),
    ).toBe(false);
    // The pack that asset resolved from is no longer a dependency, because the
    // dependency list is derived from `song.assets` rather than maintained.
    expect(
      result.project.metadata.packDependencies.some(
        (dependency) => dependency.packId === fixture.packs[0].id,
      ),
    ).toBe(false);
  });

  it("rejects an asset the project does not carry", () => {
    const result = executeCommand(fixture.project, removeAsset(libraryAsset().id));
    expect(result.ok).toBe(false);
  });
});
