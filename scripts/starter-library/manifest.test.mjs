import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog/index.mjs";
import { buildAsset, buildPackIndex, measureDelivered, serialize } from "./manifest.mjs";
import { packBySlug, packForFamily, packRef } from "./packs.mjs";
import { GENRES, TAXONOMY } from "./taxonomy.mjs";
import {
  BALANCE,
  MAX_MANIFEST_GZIP_BYTES,
  MAX_PACK_INDEX_GZIP_BYTES,
  validateLibraryBalance,
  validatePackIndex,
  validatePackManifest,
} from "./validate.mjs";
import { storageKeyFor } from "./wav.mjs";

// Rendering all 200 assets takes ~20s, which is too slow for the suite that
// runs on every save. The full catalogue is rendered and validated by
// `bun run library:validate`; here we render a few representative assets
// and drive the validation rules with fixtures.
//
// The handful of tests that actually render audio (each calls `buildAsset`)
// take ~1-2s in isolation but can exceed vitest's 5s default when the runner
// is saturated by other suites in parallel — real audio synthesis, not a hang.
// They pass this generous timeout so a busy machine can't flake them.
const RENDER_TIMEOUT_MS = 30_000;

// One entry per family, chosen so the set stays cheap to render: this file's
// whole point is to *avoid* the ~20s full build, and a single expensive pick
// silently gives most of that back. `tonal-chord-0001` used to hold the tonal
// slot at ~1030ms against 6-40ms for every other sample here — the chord voice
// sums up to 64 sine partials per sample across a long tail — and the five
// `buildAsset` tests below re-render the set, so it cost ~11s of this file's
// runtime on its own. `tonal-key-0001` carries the same contract the tonal
// slot is here for (a `rootNote` of C3 and a `tuningCents` of 0, asserted in
// "describes tonal and unpitched assets differently") for ~40ms. The chord
// voice is still rendered and validated by `bun run library:validate`, which
// builds the whole catalogue.
const SAMPLE_IDS = [
  "sg-one-shot-drums-kick-0001",
  "sg-one-shot-drums-closed-hat-0002",
  "sg-one-shot-bass-sub-0001",
  "sg-one-shot-tonal-key-0001",
  "sg-one-shot-fx-glitch-0001",
];

const sampleEntries = SAMPLE_IDS.map((id) => {
  const entry = CATALOG.find((asset) => asset.id === id);
  if (!entry) throw new Error(`test fixture references a missing asset: ${id}`);
  return entry;
});

describe("buildAsset", () => {
  it(
    "is deterministic: the same entry renders byte-identical audio",
    () => {
      for (const entry of sampleEntries) {
        const first = buildAsset(entry);
        const second = buildAsset(entry);
        expect(second.bytes.equals(first.bytes)).toBe(true);
        expect(second.asset).toEqual(first.asset);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "derives the storage key from the bytes it actually wrote",
    () => {
      for (const entry of sampleEntries) {
        const { asset, bytes } = buildAsset(entry);
        expect(asset.files.master.bytes).toBe(bytes.length);
        expect(asset.files.master.storageKey).toBe(
          storageKeyFor(asset.files.master.sha256),
        );
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "records rights, provenance, and a reproducible recipe",
    () => {
      const { asset } = buildAsset(sampleEntries[0]);
      expect(asset.license).toMatchObject({
        creator: "Groove",
        rawRedistributionAllowed: true,
        evidencePath: "docs/licenses/starter-library-v1.md",
      });
      expect(asset.provenance.sourceType).toBe("synthesized");
      expect(asset.provenance.recipe.voice).toBe("kick");
      expect(asset.provenance.recipe.seed).toBeTypeOf("number");
      // Not `approved`: no human has run the section 11 musical review.
      expect(asset.provenance.reviewState).toBe("metadata-review");
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "qualifies every asset with the pack its family belongs to (CNT-000b)",
    () => {
      for (const entry of sampleEntries) {
        const { asset } = buildAsset(entry);
        expect(asset.pack).toEqual(packRef(packForFamily(entry.family)));
      }
      // Different families land in different packs — this is the whole point of
      // pack-qualified identity (docs/sample-library.md section 5.1).
      const drums = buildAsset(sampleEntries[0]).asset; // drums/kick
      const bass = buildAsset(sampleEntries[2]).asset; // bass/sub
      expect(drums.pack.id).not.toBe(bass.pack.id);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "describes tonal and unpitched assets differently",
    () => {
      // Tuning is measured from the delivered bytes, as `buildAllPacks` does,
      // not claimed by the builder.
      const delivered = (entry) => {
        const { asset, bytes } = buildAsset(entry);
        return measureDelivered(asset, bytes);
      };
      const tonal = delivered(sampleEntries[3]);
      expect(tonal.audio.rootNote).toBe("C3");
      expect(tonal.audio.tuningStatus).toBe("detected");
      expect(tonal.audio.tuningCents).toBe(0);
      const glitch = delivered(sampleEntries[4]);
      expect(glitch.audio.rootNote).toBeNull();
      expect(glitch.audio.tuningCents).toBeNull();
      expect(glitch.audio.tuningStatus).toBeNull();
      // One-shots never claim a tempo.
      expect(glitch.audio.loopable).toBe(false);
      expect(glitch.audio.bpm).toBeNull();
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "marks the choke group on hats",
    () => {
      const hat = buildAsset(sampleEntries[1]).asset;
      expect(hat.audio.chokeGroup).toBe("drums-hat");
      expect(hat.audio.chokeRole).toBe("closed");
    },
    RENDER_TIMEOUT_MS,
  );
});

describe("serialize", () => {
  it("sorts keys so an unchanged library produces an unchanged file", () => {
    expect(serialize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(serialize({ a: { c: 3, d: 2 }, b: 1 })).toBe(
      serialize({ b: 1, a: { d: 2, c: 3 } }),
    );
  });

  it("preserves array order, which carries meaning", () => {
    expect(serialize({ peaks: [3, 1, 2] })).toBe('{"peaks":[3,1,2]}');
  });
});

// --- validation ------------------------------------------------------------

const DRUMS_PACK = packBySlug("core-electronic-drums");

function validAsset(pack, overrides = {}, index = 0) {
  const hash = String(index).padStart(64, "a");
  const role = pack.coverage.roles[index % pack.coverage.roles.length];
  return {
    id: `sg-one-shot-${pack.family}-${role}-${String(index + 1).padStart(4, "0")}`,
    version: 1,
    pack: packRef(pack),
    name: `Fixture Asset ${index}`,
    type: "one-shot",
    family: pack.family,
    role,
    files: {
      master: {
        storageKey: storageKeyFor(hash),
        sha256: hash,
        bytes: 1024,
        format: "wav",
      },
    },
    audio: {
      sampleRate: 48000,
      bitDepth: 24,
      channels: 1,
      durationSeconds: 0.5,
      peakDbfs: -1.5,
      rmsDbfs: -14,
      loudnessLufs: -14,
      spectralSketch: Array.from({ length: 32 }, (_unused, band) => band),
      rootNote: null,
      tuningCents: null,
      bpm: null,
      bars: null,
      loopable: false,
      chokeGroup: null,
      chokeRole: null,
    },
    waveform: { buckets: 2, peaks: [-1, 1, -1, 1] },
    tags: {
      // The first fixture asset alone satisfies the pack's whole genre
      // coverage claim, so mutating any *other* field on it (or any field on
      // a later asset) never incidentally breaks genre coverage.
      genres: index === 0 ? [...pack.coverage.genres] : [pack.coverage.genres[0]],
      characters: ["dry", "experimental"],
      intensity: "medium",
      sourceTypes: ["synthesized"],
    },
    license: {
      id: pack.rights.licence,
      rawRedistributionAllowed: pack.rights.rawRedistribution,
      creator: "Groove",
      sourceUrl: null,
      retrievedAt: "2026-07-25",
      evidencePath: "docs/licenses/starter-library-v1.md",
      agreementId: null,
    },
    provenance: {
      sourceType: "synthesized",
      recipe: { voice: role, params: {}, seed: 1 },
      modifications: [],
      reviewState: "metadata-review",
      reviewer: null,
      reviewedAt: null,
    },
    ...overrides,
  };
}

/** One asset per role the pack claims, so the pack's own coverage holds. */
function packAssets(pack, count = pack.coverage.roles.length) {
  return Array.from({ length: count }, (_unused, index) => validAsset(pack, {}, index));
}

function packHeader(pack, assetCount) {
  return {
    id: pack.id,
    slug: pack.slug,
    name: pack.name,
    version: pack.version,
    publisher: pack.publisher,
    kind: pack.kind,
    description: pack.description,
    coverage: pack.coverage,
    rights: pack.rights,
    releasedAt: "2026-07-25",
    assetCount,
  };
}

/** A fixture pack manifest that satisfies its own rules, so per-asset faults isolate cleanly. */
function validPackManifest(pack = DRUMS_PACK, assets) {
  const generated = assets ?? packAssets(pack);
  return {
    schemaVersion: 1,
    pack: packHeader(pack, generated.length),
    assets: generated,
  };
}

function errorsFor(mutate, pack = DRUMS_PACK) {
  const manifest = validPackManifest(pack);
  mutate(manifest);
  return validatePackManifest(manifest).errors;
}

describe("validatePackManifest", () => {
  it("accepts a well-formed pack manifest", () => {
    const { errors } = validatePackManifest(validPackManifest());
    expect(errors).toEqual([]);
  });

  it("accepts 48 valid peaks, and a manifest without any", () => {
    const withPeaks = validPackManifest();
    withPeaks.assets[0].peaks = Array.from({ length: 48 }, (_, i) => i * 5);
    expect(validatePackManifest(withPeaks).errors).toEqual([]);
    expect("peaks" in validPackManifest().assets[0]).toBe(false);
  });

  it("accepts every real registered pack's own coverage claim", () => {
    // Proves packs.mjs's hand-authored coverage.genres/roles are not just
    // plausible-looking — every pack built here actually delivers what it
    // claims, checked against the *real* fixture generator, not a mock.
    for (const family of ["drums", "bass", "tonal", "texture", "fx"]) {
      const pack = packForFamily(family);
      const { errors } = validatePackManifest(validPackManifest(pack));
      expect(errors).toEqual([]);
    }
  });

  // docs/sample-library.md section 9 names each of these as a CI failure.
  it.each([
    [
      "a missing checksum",
      (m) => {
        m.assets[0].files.master.sha256 = "";
      },
      /not a SHA-256/,
    ],
    [
      "a storage key that is not content-addressed",
      (m) => {
        m.assets[0].files.master.storageKey = "audio/kick.wav";
      },
      /does not derive from sha256/,
    ],
    [
      "absent rights evidence",
      (m) => {
        m.assets[0].license.evidencePath = null;
      },
      /evidencePath is required/,
    ],
    [
      "an absent creator",
      (m) => {
        m.assets[0].license.creator = "";
      },
      /creator is required/,
    ],
    [
      "unapproved redistribution",
      (m) => {
        m.assets[0].license.rawRedistributionAllowed = false;
      },
      /raw redistribution is not approved/,
    ],
    [
      "a missing licence block",
      (m) => {
        m.assets[0].license = undefined;
      },
      /license is required/,
    ],
    [
      "invalid audio metadata",
      (m) => {
        m.assets[0].audio.sampleRate = 44100;
      },
      /sampleRate must be 48000/,
    ],
    [
      "a silent asset",
      (m) => {
        m.assets[0].audio.peakDbfs = Number.NEGATIVE_INFINITY;
      },
      /asset is silent/,
    ],
    [
      "no headroom",
      (m) => {
        m.assets[0].audio.peakDbfs = 0;
      },
      /leaves no headroom/,
    ],
    [
      "an audio asset whose loudness was never measured",
      (m) => {
        delete m.assets[0].audio.loudnessLufs;
      },
      /loudnessLufs was not measured/,
    ],
    [
      "an audio asset under the BS.1770 absolute gate",
      (m) => {
        m.assets[0].audio.loudnessLufs = null;
      },
      /no measurable loudness/,
    ],
    [
      "an audio asset with no near-duplicate fingerprint",
      (m) => {
        delete m.assets[0].audio.spectralSketch;
      },
      /spectralSketch must be 32 integers/,
    ],
    [
      "a malformed spectral sketch",
      (m) => {
        m.assets[0].audio.spectralSketch = [0, 1, 2];
      },
      /spectralSketch must be 32 integers/,
    ],
    [
      "a detected pitch past the tuning tolerance",
      (m) => {
        Object.assign(m.assets[0].audio, {
          rootNote: "C3",
          tuningStatus: "detected",
          tuningCents: 80,
        });
      },
      /\+80 cents from its declared root C3, beyond the ±50 cent tolerance/,
    ],
    [
      "a tuning claimed for a sound with no detectable pitch",
      (m) => {
        Object.assign(m.assets[0].audio, {
          rootNote: "C3",
          tuningStatus: "undetectable",
          tuningCents: 0,
        });
      },
      /claims a value but no pitch was detected/,
    ],
    [
      "a tonal asset with no tuning",
      (m) => {
        m.assets[0].audio.rootNote = "C3";
      },
      /tuning was not measured/,
    ],
    [
      "a loop with no tempo",
      (m) => {
        m.assets[0].audio.loopable = true;
      },
      /missing bpm\/bars/,
    ],
    [
      "a duplicate id",
      (m) => {
        m.assets[1].id = m.assets[0].id;
      },
      /duplicate asset id/,
    ],
    [
      "a duplicate name",
      (m) => {
        m.assets[1].name = m.assets[0].name;
      },
      /duplicate name/,
    ],
    [
      "byte-identical audio",
      (m) => {
        m.assets[1].files.master.sha256 = m.assets[0].files.master.sha256;
      },
      /byte-identical to/,
    ],
    [
      "an unknown role",
      (m) => {
        m.assets[0].role = "kazoo";
      },
      /unknown one-shot family\/role/,
    ],
    ["an unknown genre", (m) => m.assets[0].tags.genres.push("polka"), /unknown genre/],
    [
      "an unknown character",
      (m) => m.assets[0].tags.characters.push("crunchy"),
      /unknown character/,
    ],
    [
      "an unknown intensity",
      (m) => {
        m.assets[0].tags.intensity = "quite";
      },
      /unknown intensity/,
    ],
    [
      "a truncated waveform",
      (m) => m.assets[0].waveform.peaks.pop(),
      /waveform peaks do not match/,
    ],
    [
      "peaks that are too short",
      (m) => {
        m.assets[0].peaks = new Array(47).fill(1);
      },
      /peaks must be exactly 48 integers/,
    ],
    [
      "peaks out of range",
      (m) => {
        m.assets[0].peaks = new Array(48).fill(256);
      },
      /peaks must be exactly 48 integers/,
    ],
    [
      "fractional peaks",
      (m) => {
        m.assets[0].peaks = new Array(48).fill(0.5);
      },
      /peaks must be exactly 48 integers/,
    ],
    [
      "a missing generation recipe",
      (m) => {
        m.assets[0].provenance.recipe = null;
      },
      /missing its generation recipe/,
    ],
    [
      "a wrong asset count",
      (m) => {
        m.pack.assetCount = 3;
      },
      /does not match assets.length/,
    ],
  ])("rejects %s", (_label, mutate, expected) => {
    expect(errorsFor(mutate).join("\n")).toMatch(expected);
  });

  // Section 3.5: cleared replacements use descriptive names, not third-party
  // product branding, and a familiar filename proves nothing about rights.
  it.each(["Punchy 909 Kick", "Ableton Style Clap", "Amen Break Hit"])(
    "rejects the third-party brand name %s",
    (name) => {
      expect(
        errorsFor((m) => {
          m.assets[0].name = name;
        }).join("\n"),
      ).toMatch(/contains third-party branding/);
    },
  );

  it("lets a private-alpha pack name the machine a kit was recorded from", () => {
    const errors = errorsFor((m) => {
      m.pack.rights = { ...m.pack.rights, licence: "private-alpha" };
      for (const asset of m.assets) asset.license.id = "private-alpha";
      m.assets[0].name = "TR-909 Kick";
    });
    expect(errors.join("\n")).not.toMatch(/third-party branding/);
  });

  it("rejects an empty pack rather than reporting a healthy one", () => {
    const { errors } = validatePackManifest({
      schemaVersion: 1,
      pack: packHeader(DRUMS_PACK, 0),
      assets: [],
    });
    expect(errors.join("\n")).toMatch(/pack.assets is empty/);
  });

  // --- the CNT-000b pack rules (docs/sample-library.md section 5.1, 9) -----

  it.each([
    [
      "no pack referenced at all",
      (m) => {
        m.assets[0].pack = undefined;
      },
      /pack is required \(exactly one pack per asset\)/,
    ],
    [
      "an asset naming a different pack than the manifest it appears in",
      (m) => {
        m.assets[0].pack = { id: "pak_doesNotExist000000_", version: 1 };
      },
      /does not match the manifest it appears in/,
    ],
    [
      "an asset whose pack version disagrees with the manifest's",
      (m) => {
        m.assets[0].pack = { ...m.assets[0].pack, version: 99 };
      },
      /pack.version 99 does not match/,
    ],
    [
      "an asset licence that exceeds its pack's rights position",
      (m) => {
        m.assets[0].license.id = "CC0-1.0";
      },
      /exceeds pack "core-electronic-drums"'s rights position/,
    ],
    [
      "a manifest naming a pack that packs.mjs never registered",
      (m) => {
        m.pack.slug = "not-a-real-pack";
      },
      /"not-a-real-pack" is not a registered pack/,
    ],
    [
      "a manifest whose pack.id does not match the registered pack's",
      (m) => {
        m.pack.id = "pak_wrongIdWrongIdWrongIdW";
      },
      /pack.id does not match the registered id/,
    ],
    [
      "an unknown pack kind",
      (m) => {
        m.pack.kind = "premium";
      },
      /pack.kind must be factory, user, or third-party/,
    ],
    [
      "a pack claiming a role no asset in it delivers",
      (m) => {
        m.assets = m.assets.filter((asset) => asset.role !== "tom");
        m.pack.assetCount = m.assets.length;
      },
      /claims role "tom" but no asset in it delivers that role/,
    ],
  ])("rejects %s", (_label, mutate, expected) => {
    expect(errorsFor(mutate).join("\n")).toMatch(expected);
  });

  it("rejects a pack claiming a genre no asset in it delivers", () => {
    // The drums pack already claims every genre in the vocabulary, so this
    // needs a pack with room to claim one it does not deliver.
    const texturePack = packForFamily("texture");
    expect(texturePack.coverage.genres).not.toContain("trance");
    const errors = errorsFor((m) => {
      m.pack.coverage = {
        ...m.pack.coverage,
        genres: [...m.pack.coverage.genres, "trance"],
      };
    }, texturePack).join("\n");
    expect(errors).toMatch(/claims genre "trance" but no asset in it is tagged with it/);
  });
});

describe("collection balance (section 6.4, measured library-wide — section 6.5)", () => {
  /**
   * One asset per taxonomy role across every family, pack-qualified correctly,
   * and every asset tagged with every genre — so the section 6.4 per-genre
   * floor (measured library-wide, not per pack) is met by construction and
   * each test below isolates the one thing it mutates.
   */
  function balanceAssets() {
    return Object.entries(TAXONOMY).flatMap(([family, roles]) => {
      const pack = packForFamily(family);
      return roles.map((role, roleIndex) =>
        validAsset(
          pack,
          {
            id: `sg-one-shot-${family}-${role}-0001`,
            name: `Fixture ${family} ${role}`,
            family,
            role,
            tags: {
              genres: [...GENRES],
              characters: ["dry", "experimental"],
              intensity: "medium",
              sourceTypes: ["synthesized"],
            },
          },
          roleIndex,
        ),
      );
    });
  }

  it("accepts a library that meets every collection-level floor", () => {
    const { errors, warnings } = validateLibraryBalance(balanceAssets());
    expect(errors).toEqual([]);
    // The synthesized-library gap is always reported, never silently passed.
    expect(warnings.join(" ")).toMatch(/recorded or field-recorded/);
  });

  it("leaves private-alpha content out of the collection balance", () => {
    const assets = balanceAssets();
    const alpha = balanceAssets().map((asset) => ({
      ...asset,
      license: { ...asset.license, id: "private-alpha" },
      tags: { ...asset.tags, characters: ["punchy"] },
    }));
    expect(validateLibraryBalance([...assets, ...alpha, ...alpha]).errors).toEqual([]);
  });

  it("rejects a library with too little experimental material", () => {
    const assets = balanceAssets();
    for (const asset of assets) asset.tags.characters = ["dry"];
    expect(validateLibraryBalance(assets).errors.join("\n")).toMatch(
      /experimental or abrasive/,
    );
  });

  it("rejects a library with too little dry, shapeable material", () => {
    const assets = balanceAssets();
    for (const asset of assets) asset.tags.characters = ["experimental"];
    expect(validateLibraryBalance(assets).errors.join("\n")).toMatch(
      /dry or lightly processed/,
    );
  });

  it("rejects a library dominated by one source family", () => {
    const assets = balanceAssets();
    const padding = Array.from({ length: 40 }, (_unused, index) =>
      validAsset(
        DRUMS_PACK,
        {
          id: `sg-one-shot-drums-kick-${String(index + 100).padStart(4, "0")}`,
          name: `Pad ${index}`,
          role: "kick",
        },
        index + 100,
      ),
    );
    assets.push(...padding);
    expect(validateLibraryBalance(assets).errors.join("\n")).toMatch(
      /single-family ceiling/,
    );
  });

  it("rejects a library that leaves a required genre unusable", () => {
    const assets = balanceAssets();
    for (const asset of assets) {
      asset.tags.genres = asset.tags.genres.filter((genre) => genre !== "uk-garage");
    }
    expect(validateLibraryBalance(assets).errors.join("\n")).toMatch(/genre "uk-garage"/);
  });

  it("rejects a library that leaves a taxonomy role empty", () => {
    const assets = balanceAssets().filter((asset) => asset.role !== "riser");
    expect(validateLibraryBalance(assets).errors.join("\n")).toMatch(
      /no assets cover fx\/riser/,
    );
  });

  // Section 12: the browser fetches a pack manifest before it can search
  // anything inside that pack.
  it("rejects a pack manifest over the section 12 per-pack budget", () => {
    const manifest = validPackManifest();
    // Incompressible, so the assertion is about the *gzipped* size the
    // budget is written in. A repeated character would compress to nothing.
    const serialized = randomBytes(MAX_MANIFEST_GZIP_BYTES + 65536).toString("base64");
    const { errors, stats } = validatePackManifest(manifest, { serialized });
    expect(stats.manifestGzipBytes).toBeGreaterThan(MAX_MANIFEST_GZIP_BYTES);
    expect(errors.join("\n")).toMatch(/over the .* budget/);
  });

  it("exposes the thresholds it enforces", () => {
    expect(BALANCE).toMatchObject({
      minExperimentalShare: 0.15,
      minDryShare: 0.3,
      maxSingleRoleShare: 0.2,
    });
  });
});

describe("validatePackIndex", () => {
  // Cheap fixture manifests (no audio rendering) rather than `buildAllPacks()`
  // — the full 200-asset render is reserved for `bun run library:validate`
  // (see the note at the top of this file).
  const FIXTURE_PACKS = ["drums", "bass", "tonal"].map((family) =>
    validPackManifest(packForFamily(family)),
  );

  it("accepts an index that lists exactly the built packs", () => {
    const index = buildPackIndex(FIXTURE_PACKS);
    const { errors } = validatePackIndex(index, FIXTURE_PACKS, {
      serialized: serialize(index),
    });
    expect(errors).toEqual([]);
  });

  it("rejects a pack index entry with no matching built manifest", () => {
    const index = buildPackIndex(FIXTURE_PACKS);
    index.packs.push({
      id: "pak_ghostPackGhostPackGhost",
      slug: "ghost-pack",
      version: 1,
      manifestPath: "packs/ghost-pack/v1.json",
    });
    const { errors } = validatePackIndex(index, FIXTURE_PACKS);
    expect(errors.join("\n")).toMatch(/no built pack manifest matches/);
  });

  it("rejects an index that is missing a pack the build actually produced", () => {
    const index = buildPackIndex(FIXTURE_PACKS);
    index.packs.pop();
    const { errors } = validatePackIndex(index, FIXTURE_PACKS);
    expect(errors.join("\n")).toMatch(/missing from the pack index/);
  });

  it("rejects a pack index over its section 12 budget", () => {
    const index = buildPackIndex(FIXTURE_PACKS);
    const serialized = randomBytes(MAX_PACK_INDEX_GZIP_BYTES + 8192).toString("base64");
    const { errors } = validatePackIndex(index, FIXTURE_PACKS, { serialized });
    expect(errors.join("\n")).toMatch(/over the .* budget/);
  });
});
