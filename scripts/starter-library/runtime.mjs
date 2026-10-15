// The generated bridge between the library pipeline and the application.
//
// `CNT-001`'s fourth acceptance criterion is that "runtime and tests consume
// generated manifests rather than hand-maintained duplicate lists". Before this
// task the app's "New Project" starter carried its own copy of an asset — a
// name, a storage path, a duration, a sample rate, a channel count, and an
// invented pack — none of which the library pipeline knew about, and one of
// which ("909 Bass Drum") was a brand name the manifest validator rejects.
//
// This module removes the duplicate rather than adding a second one: it selects
// a few assets *by catalogue ID* out of the same builders `buildAllPacks` uses,
// and emits them as a committed TypeScript module the app imports. The audio it
// writes is the same content-addressed object the bucket serves, at the same
// key, so the app resolves a real library asset in dev, in the browser suites,
// and in production alike.
//
// Only the selected assets are rendered. A dev server must not pay for the
// whole 200-asset library to start, and rendering the selection through the
// same `buildAsset`/`buildLoop` functions means there is no second code path
// whose output could drift — `runtime.test.mjs` pins that the committed module
// matches a fresh emit.

import { CATALOG, LOOP_CATALOG } from "./catalog/index.mjs";
import { createRng, seedFromString } from "./dsp.mjs";
import { buildAsset, buildLoop, RELEASED_AT } from "./manifest.mjs";
import { packById } from "./packs.mjs";
import { renderVoice } from "./voices.mjs";

/**
 * What the application itself ships with, keyed by the role it plays in the
 * product rather than by asset ID — the app asks for "the starter sampler
 * sound", and which catalogue entry that is stays a library decision.
 *
 * Deliberately tiny. This is not a bundled library: section 12's delivery model
 * is that a client fetches the pack index and then a pack manifest it needs
 * (`LOOP-013`). These are only the assets that must exist before any fetch has
 * happened — the ones a brand-new project is built from.
 */
export const RUNTIME_SELECTION = [
  {
    key: "starterKick",
    assetId: "sg-one-shot-drums-kick-0001",
    use: "The sampler asset a new project's one track is created with (FND-009).",
  },
  {
    key: "starterClap",
    assetId: "sg-one-shot-drums-clap-0001",
    use: "The second drum voice, for fixtures and multi-track smoke tests.",
  },
  {
    key: "starterSnare",
    assetId: "sg-one-shot-drums-snare-0001",
    use: "The snare a new drum machine's SD pad starts with (#447).",
  },
  {
    key: "starterHat",
    assetId: "sg-one-shot-drums-closed-hat-0001",
    use: "The closed hat a new drum machine's HH pad starts with (#447).",
  },
  {
    key: "starterLoop",
    assetId: "sg-loop-drums-full-loop-0001",
    use: "An audio loop, so an audio-clip path has real bar-aligned material.",
  },
];

/**
 * Build exactly the selected assets, through the same builders the full
 * pipeline uses.
 *
 * @returns {{ assets: object[], files: {storageKey: string, bytes: Buffer}[] }}
 */
export function buildRuntimeLibrary(selection = RUNTIME_SELECTION) {
  const oneShots = new Map(CATALOG.map((entry) => [entry.id, entry]));
  const loops = new Map(LOOP_CATALOG.map((entry) => [entry.id, entry]));
  const renderSource = (id) => {
    const entry = oneShots.get(id);
    if (!entry) throw new Error(`unknown source asset ${id}`);
    return renderVoice(entry, createRng(seedFromString(entry.id)));
  };

  const built = selection.map(({ key, assetId, use }) => {
    const oneShot = oneShots.get(assetId);
    const loop = loops.get(assetId);
    if (!oneShot && !loop) {
      throw new Error(`runtime selection names unknown asset ${assetId}`);
    }
    const record = oneShot ? buildAsset(oneShot) : buildLoop(loop, renderSource);
    return { key, use, ...record };
  });

  return {
    assets: built.map(({ key, use, asset }) => ({ key, use, asset })),
    files: built.map(({ asset, bytes }) => ({
      storageKey: asset.files.master.storageKey,
      bytes,
    })),
  };
}

/**
 * Where the emitted audio lands, and therefore what the app's asset URLs point
 * at. Mirrors the bucket layout exactly (`audio/<storageKey>` under the library
 * root), so the only difference between a local file and a delivered object is
 * the origin.
 */
export const RUNTIME_AUDIO_PREFIX = "samples/starter-library/audio";

export function runtimeStorageRef(storageKey) {
  return `${RUNTIME_AUDIO_PREFIX}/${storageKey}`;
}

/**
 * Render the committed TypeScript module.
 *
 * Written as source rather than JSON because the app and its tests want it
 * typed and tree-shaken, and because a type error is a better drift signal than
 * a runtime `undefined`. `biome.json` excludes it from formatting — a formatter
 * that rewrapped a line would make the committed file differ from a fresh emit
 * and fail the drift check for no reason — but `tsc` still checks it, which is
 * where a stale or malformed emit actually shows up.
 */
export function renderRuntimeModule(library = buildRuntimeLibrary()) {
  const entries = library.assets.map(({ key, use, asset }) => {
    const pack = packById(asset.pack.id);
    return [
      "\t{",
      `\t\t/** ${use} */`,
      `\t\tkey: ${JSON.stringify(key)},`,
      `\t\tassetId: ${JSON.stringify(asset.id)},`,
      `\t\tname: ${JSON.stringify(asset.name)},`,
      `\t\ttype: ${JSON.stringify(asset.type)},`,
      `\t\trole: ${JSON.stringify(asset.role)},`,
      "\t\tpack: {",
      `\t\t\tid: ${JSON.stringify(pack.id)},`,
      `\t\t\tname: ${JSON.stringify(pack.name)},`,
      `\t\t\tversion: ${JSON.stringify(pack.version)},`,
      `\t\t\tpublisher: ${JSON.stringify(pack.publisher)},`,
      `\t\t\tkind: ${JSON.stringify(pack.kind)},`,
      `\t\t\tdescription: ${JSON.stringify(pack.description)},`,
      "\t\t\trights: {",
      `\t\t\t\tlicence: ${JSON.stringify(pack.rights.licence)},`,
      `\t\t\t\trawRedistribution: ${pack.rights.rawRedistribution},`,
      `\t\t\t\tattributionRequired: ${pack.rights.attributionRequired},`,
      "\t\t\t},",
      "\t\t},",
      `\t\tstorageRef: ${JSON.stringify(runtimeStorageRef(asset.files.master.storageKey))},`,
      `\t\tsha256: ${JSON.stringify(asset.files.master.sha256)},`,
      `\t\tdurationSeconds: ${asset.audio.durationSeconds},`,
      `\t\tsampleRate: ${asset.audio.sampleRate},`,
      `\t\tchannelCount: ${asset.audio.channels},`,
      `\t\tlicence: ${JSON.stringify(asset.license.id)},`,
      "\t},",
    ].join("\n");
  });

  return `${[
    "// GENERATED FILE — do not edit.",
    "//",
    "// Emitted by `bun run library:emit-runtime` from the same manifest pipeline",
    "// that produces the delivered pack manifests (`scripts/starter-library/`).",
    "// `CNT-001`: the application resolves the assets it ships with through the",
    "// generated manifest, not through a hand-maintained list of names and paths.",
    "//",
    "// The audio these entries point at is written to `public/` by the same",
    "// command, at the same content-addressed key the bucket serves it from.",
    "//",
    `// Library release: ${RELEASED_AT}`,
    "",
    'import type { FactoryLibraryEntry } from "./factoryLibrary";',
    "",
    "export const FACTORY_LIBRARY: readonly FactoryLibraryEntry[] = [",
    ...entries,
    "];",
  ].join("\n")}\n`;
}
