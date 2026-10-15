import { describe, expect, it } from "vitest";
import { factoryLibrary } from "../../library/factoryLibrary";
import { assetStorageRef, parsePackManifest } from "../../library/manifest";
import {
  bundledFactorySounds,
  factoryCatalog,
  manifestFactorySounds,
} from "./factoryCatalog";

const kick = factoryLibrary()[0];
if (!kick) throw new Error("the factory library is empty");

function manifest(kind: "factory" | "user") {
  return parsePackManifest({
    schemaVersion: 1,
    pack: {
      id: kick.pack.id,
      slug: "core-electronic-drums",
      name: kick.pack.name,
      version: "9.0.0",
      publisher: "Groove",
      kind,
      description: "",
      assetCount: 2,
    },
    assets: [
      {
        id: "sg-one-shot-drums-kick-0001",
        name: "Renamed Kick",
        type: "one-shot",
        family: "drums",
        role: "kick",
        pack: { id: kick.pack.id, version: "9.0.0" },
        tags: { genres: [], characters: [] },
        files: { master: { storageKey: kick.storageRef.split("/audio/")[1] } },
        license: { id: "solid-groove-owned" },
      },
      {
        id: "sg-preset-0001",
        name: "A preset",
        type: "preset",
        family: "drums",
        role: "kit",
        pack: { id: kick.pack.id, version: "9.0.0" },
        tags: { genres: [], characters: [] },
      },
    ],
  });
}

describe("factoryCatalog", () => {
  it("resolves a bundled sound by its pack and storage reference", () => {
    const catalog = factoryCatalog(bundledFactorySounds());
    expect(
      catalog.sound({ packId: kick.pack.id as never, storageRef: kick.storageRef }),
    ).toMatchObject({
      names: [kick.name],
    });
    expect(
      catalog.sound({ packId: kick.pack.id as never, storageRef: "users/uid_x/a.wav" }),
    ).toBeNull();
    expect(catalog.hasPack(kick.pack.id)).toBe(true);
  });

  it("reads a factory manifest's sounds, keeping every name a sound has had", () => {
    const sounds = manifestFactorySounds(manifest("factory"));
    expect(sounds).toEqual([
      {
        packId: kick.pack.id,
        storageRef: assetStorageRef(kick.storageRef.split("/audio/")[1] as string),
        name: "Renamed Kick",
        licence: "solid-groove-owned",
      },
    ]);
    const catalog = factoryCatalog([...bundledFactorySounds(), ...sounds]);
    expect(
      catalog.sound({ packId: kick.pack.id as never, storageRef: kick.storageRef })
        ?.names,
    ).toEqual([kick.name, "Renamed Kick"]);
  });

  it("reads nothing from a pack that is not a factory pack", () => {
    expect(manifestFactorySounds(manifest("user"))).toEqual([]);
  });
});
