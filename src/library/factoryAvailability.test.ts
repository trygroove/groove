import { describe, expect, it } from "vitest";
import { executeTransaction } from "../commands";
import type { Project } from "../domain/entities";
import { createFactoryContext } from "../domain/factories";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createReferenceProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import { createSeededIdFactory } from "../domain/ids";
import { resolvePackAvailability, trackAssetIds } from "../domain/packs";
import { parseProject } from "../domain/parse";
import { stringifyProject } from "../domain/serialize";
import { createStarterProject } from "../editor/composition/starterProject";
import { packAudioPath } from "../userData/userData";
import { FIXTURE_PACK_INDEX_DOC, fixturePackManifest } from "./__fixtures__/fixtures";
import { withdrawnFactoryPacks } from "./factoryAvailability";
import { insertLoopCommands, toLibrarySample } from "./insertion";
import {
  type LibraryPackSummary,
  packAssets,
  packSummaries,
  parsePackIndex,
  parsePackManifest,
} from "./manifest";

/**
 * Withdrawing factory content from the published library (#78): a pack the
 * index stops listing is reported with the tracks and clips it affects, and a
 * sound only dropped from discovery is not missing at all. Either way the
 * project itself is never touched.
 *
 * The projects here are built from the committed slice of the real delivered
 * library, through the same insertion commands the Library view dispatches.
 */

const index = (): LibraryPackSummary[] =>
  packSummaries(parsePackIndex(FIXTURE_PACK_INDEX_DOC));
const without = (slug: string) => index().filter((pack) => pack.slug !== slug);
const bassPack = () => {
  const pack = index().find((entry) => entry.slug === "foundation-bass");
  if (!pack) throw new Error("the fixture library has no foundation-bass pack");
  return pack;
};

/** The starter (a Core Electronic Drums kick) plus a Foundation Bass loop on its own track. */
function libraryProject(): { project: Project; loopTrackId: string } {
  const starter = createStarterProject("owner-1", () => 0.5);
  const loop = packAssets(parsePackManifest(fixturePackManifest("foundation-bass"))).find(
    (asset) => asset.type === "loop",
  );
  const sample = loop && toLibrarySample(loop);
  if (!sample) throw new Error("the fixture bass pack has no insertable loop");
  const insert = insertLoopCommands(
    starter,
    sample,
    createFactoryContext({ ids: createSeededIdFactory("withdrawal"), now: 1 }),
    { order: 1, existingNames: ["BD"], songTempo: starter.song.tempo },
  );
  const result = executeTransaction(starter, insert.commands);
  if (!result.ok) throw new Error(result.issues[0].message);
  return { project: result.project, loopTrackId: insert.trackId };
}

describe("withdrawnFactoryPacks", () => {
  it("reports nothing while the index lists every pack the project uses", () => {
    expect(withdrawnFactoryPacks(libraryProject().project, index())).toEqual([]);
  });

  it("reports a withdrawn pack with the sound, track and clip it takes down", () => {
    const { project, loopTrackId } = libraryProject();
    const [missing, ...rest] = withdrawnFactoryPacks(project, without("foundation-bass"));
    expect(rest).toEqual([]);

    const loopAsset = project.song.assets.find((asset) => asset.packId === bassPack().id);
    const loopClip = project.clips.find((clip) => clip.trackId === loopTrackId);
    expect(missing).toEqual({
      packId: bassPack().id,
      version: loopAsset?.packVersion,
      reason: "pack_unavailable",
      assets: [{ id: loopAsset?.id, name: loopAsset?.name }],
      tracks: [],
      clips: [{ id: loopClip?.id, name: loopClip?.name }],
    });
  });

  it("names the drum track whose pad sound went with its pack, and only that", () => {
    const { project } = libraryProject();
    const [missing] = withdrawnFactoryPacks(project, without("core-electronic-drums"));
    expect(missing.tracks.map((track) => track.name)).toEqual(["BD"]);
    expect(missing.clips.map((clip) => clip.name)).toEqual(["Four on the floor"]);
  });

  it("does not report a sound only removed from discovery in a newer pack version", () => {
    const { project } = libraryProject();
    // Foundation Bass republished without the loop: the project still pins the
    // version it resolved, whose audio is immutable and still delivered.
    const republished = index().map((pack) =>
      pack.slug === "foundation-bass"
        ? { ...pack, version: "9.0.0", assetCount: pack.assetCount - 1 }
        : pack,
    );
    expect(withdrawnFactoryPacks(project, republished)).toEqual([]);
  });

  it("leaves personal sounds to their owner's packs", () => {
    const { project } = libraryProject();
    const personal: Project = {
      ...project,
      song: {
        ...project.song,
        assets: project.song.assets.map((asset) =>
          asset.packId === bassPack().id
            ? { ...asset, storageRef: packAudioPath("owner-1", asset.packId, asset.id) }
            : asset,
        ),
      },
    };
    expect(withdrawnFactoryPacks(personal, without("foundation-bass"))).toEqual([]);
  });

  it("does not judge a sound the factory library never delivered", () => {
    // The domain fixtures' prototype paths are nobody's library delivery.
    expect(withdrawnFactoryPacks(createSliceFixtureProject(), [])).toEqual([]);
  });
});

/**
 * Every pack gone at once, from every fixture project: the domain fixtures
 * through `resolvePackAvailability` (their sounds are not library deliveries),
 * the library-built one through the factory check the editor runs.
 */
describe("withdrawing every pack from existing fixture projects", () => {
  const fixtures: [string, () => Project][] = [
    ["slice", () => createSliceFixtureProject()],
    ["drum machine", () => createDrumMachineFixtureProject()],
    ["piano roll", () => createPianoRollFixtureProject()],
    ["reference", () => createReferenceProject({ trackCount: 6 })],
    ["library", () => libraryProject().project],
  ];

  it.each(fixtures)(
    "reports the %s project's packs and leaves it valid and unchanged",
    (name, make) => {
      const project = make();
      const before = stringifyProject(project);
      const missing =
        name === "library"
          ? withdrawnFactoryPacks(project, [])
          : resolvePackAvailability(project, []).missing;

      // Every dependency is reported, every asset named once, and every track
      // that plays one of them is among the affected.
      expect(missing.map((entry) => entry.packId).sort()).toEqual(
        project.metadata.packDependencies.map((dependency) => dependency.packId).sort(),
      );
      expect(
        missing.flatMap((entry) => entry.assets.map((asset) => asset.id)).sort(),
      ).toEqual(project.song.assets.map((asset) => asset.id).sort());
      const affected = new Set(
        missing.flatMap((entry) => entry.tracks.map((track) => track.id)),
      );
      for (const track of project.song.tracks) {
        if (trackAssetIds(track).length > 0)
          expect(affected.has(track.id), track.name).toBe(true);
      }

      // Nothing was repaired, dropped or substituted: the project still parses,
      // serializes byte-for-byte as before, and keeps each asset's licence, so
      // what an export may do with it stays answerable from the project alone.
      expect(stringifyProject(project)).toBe(before);
      expect(parseProject(JSON.parse(before)).ok).toBe(true);
      for (const asset of project.song.assets) {
        expect(asset.provenance.licence, asset.name).toBeTruthy();
      }
    },
  );
});
