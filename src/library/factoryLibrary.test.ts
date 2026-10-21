import { describe, expect, it } from "vitest";
import { createFactoryContext } from "../domain/factories";
import { derivePackDependencies } from "../domain/packs";
import { assertProject } from "../domain/parse";
import { createStarterProject } from "../editor/composition/starterProject";
import {
  createFactoryAsset,
  factoryLibrary,
  factoryLibraryEntry,
  factoryPack,
} from "./factoryLibrary";

// `CNT-001`: the application resolves the assets it ships with through the
// generated manifest. These tests are the application-side half of that — the
// generator-side half (that the committed module still matches a fresh emit) is
// `scripts/starter-library/runtime.test.mjs`.

describe("the generated factory library", () => {
  it("describes every entry with what the app needs to resolve it", () => {
    expect(factoryLibrary().length).toBeGreaterThan(0);
    for (const entry of factoryLibrary()) {
      expect(entry.assetId).toMatch(/^sg-/);
      // The content-addressed delivery path, not a hand-written filename.
      expect(entry.storageRef).toMatch(
        /^samples\/starter-library\/audio\/sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.\w+$/,
      );
      expect(entry.storageRef).toContain(entry.sha256);
      expect(entry.durationSeconds).toBeGreaterThan(0);
      expect(entry.sampleRate).toBe(48_000);
      expect([1, 2]).toContain(entry.channelCount);
      expect(entry.licence).toBeTruthy();
    }
  });

  it("parses each pack record as a real domain pack", () => {
    for (const entry of factoryLibrary()) {
      const pack = factoryPack(entry);
      expect(pack.id).toBe(entry.pack.id);
      expect(pack.version).toBe(entry.pack.version);
      expect(pack.kind).toBe("factory");
    }
  });

  it("says which key is missing rather than returning undefined", () => {
    expect(() => factoryLibraryEntry("noSuchSound")).toThrow(
      /no factory library entry "noSuchSound"/,
    );
  });

  it("builds a domain asset that carries the manifest's facts", () => {
    const entry = factoryLibraryEntry("starterKick");
    const asset = createFactoryAsset(createFactoryContext(), "starterKick");
    expect(asset.name).toBe(entry.name);
    expect(asset.packId).toBe(entry.pack.id);
    expect(asset.packVersion).toBe(entry.pack.version);
    expect(asset.storageRef).toBe(entry.storageRef);
    expect(asset.url).toBe(`/${entry.storageRef}`);
    expect(asset.durationSeconds).toBe(entry.durationSeconds);
    expect(asset.sampleRate).toBe(entry.sampleRate);
    expect(asset.channelCount).toBe(entry.channelCount);
  });

  it("marks a loop entry as a loop asset, not a sample", () => {
    expect(createFactoryAsset(createFactoryContext(), "starterLoop").kind).toBe("loop");
  });
});

describe("the starter project built from it", () => {
  it("resolves its sampler asset from a real factory pack", () => {
    const project = createStarterProject("user_1");
    const [asset] = project.song.assets;
    const entry = factoryLibraryEntry("starterKick");

    expect(asset.packId).toBe(entry.pack.id);
    expect(asset.storageRef).toBe(entry.storageRef);
    expect(project.metadata.packDependencies).toEqual(
      derivePackDependencies(project.song),
    );
    // Section 3.5: the starter no longer ships a third-party product name.
    expect(asset.name.toLowerCase()).not.toMatch(/909|808/);
  });

  it("still parses as a valid schema-v1 project", () => {
    const project = createStarterProject("user_1");
    expect(() => assertProject(project)).not.toThrow();
  });
});
