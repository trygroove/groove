import { describe, expect, it } from "vitest";
import { addPack, CommandHistory, executeTransaction, removeClip } from "../commands";
import { packVersion } from "../domain/entities";
import { createFactoryContext } from "../domain/factories";
import {
  createDrumMachineFixtureProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import { createSeededIdFactory } from "../domain/ids";
import { TICKS_PER_BAR } from "../domain/time";
import { fixturePackManifest } from "./__fixtures__/fixtures";
import {
  addPadWithSampleCommands,
  carriedAsset,
  createLibraryAsset,
  insertLoopCommands,
  loadPadSampleCommands,
  loadSampleCommands,
  loopClipLengthTicks,
  replaceLoopCommands,
  toLibrarySample,
} from "./insertion";
import { LIBRARY_ROOT, packAssets, parsePackManifest } from "./manifest";

/**
 * Loading a browsed sound onto a track (#225).
 *
 * The assets here come from the committed slice of the real delivered library,
 * so this exercises the wire shape production parses rather than a hand-written
 * asset that could drift from it.
 */

async function libraryAssets(slug = "core-electronic-drums") {
  const raw = fixturePackManifest(slug);
  return packAssets(parsePackManifest(raw));
}

function context(seed = "insertion") {
  return createFactoryContext({
    ids: createSeededIdFactory(seed),
    now: 1_700_000_000_000,
  });
}

describe("toLibrarySample", () => {
  it("keeps the facts a project stores and drops the browsing facets", async () => {
    const asset = (await libraryAssets())[0];
    const sample = toLibrarySample(asset);

    expect(sample).not.toBeNull();
    expect(sample?.name).toBe(asset.name);
    expect(sample?.packId).toBe(asset.packId);
    expect(sample?.packVersion).toBe(asset.packVersion);
    expect(sample?.storageRef).toBe(`${LIBRARY_ROOT}/audio/${asset.storageKey}`);
    // The URL is whatever this page load resolves that delivery to — the
    // manifest's own, not a path this module reassembles. Under same-origin
    // delivery that is the storage reference with a leading slash; under
    // bucket delivery it is a Storage download URL, and the reference is
    // still the stable thing a project keeps.
    expect(sample?.url).toBe(asset.url);
    expect(sample).not.toHaveProperty("genres");
    expect(sample).not.toHaveProperty("role");
  });

  it("calls a tempo-labelled loop a loop, and a one-shot a sample", async () => {
    const assets = await libraryAssets("foundation-bass");
    const loop = assets.find((asset) => asset.type === "loop");
    const oneShot = assets.find((asset) => asset.type === "one-shot");
    if (!loop || !oneShot) throw new Error("expected a loop and a one-shot");
    expect(toLibrarySample(loop)?.kind).toBe("loop");
    expect(toLibrarySample(oneShot)?.kind).toBe("sample");
  });

  it("refuses an asset with no master audio, so nothing dangles", async () => {
    const assets = await libraryAssets();
    const withoutAudio = { ...assets[0], storageKey: null, url: null };
    expect(toLibrarySample(withoutAudio)).toBeNull();
  });

  it("refuses a manifest row whose pack id is not a pack id", async () => {
    const assets = await libraryAssets();
    expect(toLibrarySample({ ...assets[0], packId: "nope" })).toBeNull();
  });
});

describe("loadSampleCommands", () => {
  it("carries the sound and points the sampler at it, in one transaction", async () => {
    const project = createSliceFixtureProject();
    const track = project.song.tracks[0];
    const sample = toLibrarySample((await libraryAssets())[1]);
    if (!sample) throw new Error("expected an insertable sample");

    const result = executeTransaction(
      project,
      loadSampleCommands(project, track.id, sample, context()),
    );
    expect(result.ok, result.ok ? "" : result.issues[0].message).toBe(true);
    if (!result.ok) return;

    const asset = carriedAsset(result.project, sample);
    expect(asset?.name).toBe(sample.name);
    expect(asset?.provenance.licence).toBe(sample.licence);
    const instrument = result.project.song.tracks[0].instrument;
    expect(instrument?.kind === "sampler" && instrument.assetId).toBe(asset?.id);
    // One transaction: one revision, so one undo takes the whole drop back.
    expect(result.project.metadata.revision).toBe(project.metadata.revision + 1);
    expect(result.commands).toHaveLength(2);
  });

  it("reuses a delivery the project already carries rather than duplicating it", async () => {
    const project = createSliceFixtureProject();
    const track = project.song.tracks[0];
    const sample = toLibrarySample((await libraryAssets())[1]);
    if (!sample) throw new Error("expected an insertable sample");

    const first = executeTransaction(
      project,
      loadSampleCommands(project, track.id, sample, context("first")),
    );
    if (!first.ok) throw new Error(first.issues[0].message);
    const commands = loadSampleCommands(
      first.project,
      track.id,
      sample,
      context("second"),
    );
    expect(commands).toHaveLength(1);

    const second = executeTransaction(first.project, commands);
    if (!second.ok) throw new Error(second.issues[0].message);
    expect(second.project.song.assets).toHaveLength(first.project.song.assets.length);
  });

  it("changes nothing when the track's instrument is not a sampler", async () => {
    const project = createSliceFixtureProject();
    const sample = toLibrarySample((await libraryAssets())[0]);
    if (!sample) throw new Error("expected an insertable sample");
    // A track with no instrument at all: the asset must not be carried by a
    // transaction whose sample load is refused.
    const bare = { ...project.song.tracks[0], instrument: null };
    const withBare = {
      ...project,
      song: { ...project.song, tracks: [bare] },
    };

    const result = executeTransaction(
      withBare,
      loadSampleCommands(withBare, bare.id, sample, context()),
    );
    expect(result.ok).toBe(false);
    expect(result.project).toBe(withBare);
  });

  it("records the pack the sound resolved from as a dependency", async () => {
    const project = createSliceFixtureProject();
    const sample = toLibrarySample((await libraryAssets("tonal-elements"))[0]);
    if (!sample) throw new Error("expected an insertable sample");

    const result = executeTransaction(
      project,
      loadSampleCommands(project, project.song.tracks[0].id, sample, context()),
    );
    if (!result.ok) throw new Error(result.issues[0].message);
    expect(
      result.project.metadata.packDependencies.some(
        (dependency) =>
          dependency.packId === sample.packId &&
          dependency.version === sample.packVersion,
      ),
    ).toBe(true);
  });
});

describe("createLibraryAsset", () => {
  it("mints a project-scoped reference rather than reusing the library id", async () => {
    const asset = (await libraryAssets())[0];
    const sample = toLibrarySample(asset);
    if (!sample) throw new Error("expected an insertable sample");
    const created = createLibraryAsset(context(), sample);

    expect(created.id).toMatch(/^ast_/);
    expect(created.id).not.toBe(asset.id);
    expect(created.provenance.source).toBe("library");
  });
});

/**
 * Bringing a loop in as its own track (`LOOP-019`).
 *
 * These exist because the surface shipped without them: the arrangement's Loop
 * button opened the library, "Insert" reached a sampler-only path that returned
 * silently when no sampler was selected, and the window closed leaving the
 * project untouched — no track, no error, nothing in the console. Every
 * assertion below fails against that behaviour.
 */
describe("insertLoopCommands", () => {
  /** A loop with a stated tempo, from the delivered library. */
  async function loopSample() {
    const assets = await libraryAssets("core-electronic-drums");
    for (const asset of assets) {
      const sample = toLibrarySample(asset);
      if (sample?.kind === "loop" && sample.bpm) return sample;
    }
    // Not every committed fixture pack ships a tempo-labelled loop; build one
    // from a real asset rather than skipping, so the shape stays production's.
    const base = toLibrarySample(assets[0]);
    if (!base) throw new Error("expected an insertable asset");
    return { ...base, kind: "loop" as const, bpm: 140, durationSeconds: 3.4285 };
  }

  it("adds an audio track carrying the loop at bar 1, in one transaction", async () => {
    const project = createSliceFixtureProject();
    const sample = await loopSample();
    const before = project.song.tracks.length;

    const insert = insertLoopCommands(project, sample, context(), {
      order: before,
      existingNames: project.song.tracks.map((track) => track.name),
      songTempo: project.song.tempo,
    });
    const result = executeTransaction(project, insert.commands);
    expect(result.ok, result.ok ? "" : result.issues[0].message).toBe(true);
    if (!result.ok) return;

    // A new track, at the bottom, and no existing track touched.
    expect(result.project.song.tracks).toHaveLength(before + 1);
    const track = result.project.song.tracks[before];
    // The insertion names the track it adds, so the editor can select it (#879).
    expect(insert.trackId).toBe(track.id);
    expect(track.name).toBe(sample.name);
    expect(track.order).toBe(before);
    expect(track.type).toBe("audio");
    expect(track.instrument).toBeNull();

    // Carrying the loop: the clip is the asset, at the loop's own tempo.
    const asset = carriedAsset(result.project, sample);
    expect(asset).not.toBeNull();
    const clip = result.project.clips.find((entry) => entry.trackId === track.id);
    expect(clip?.content.kind).toBe("audioLoop");
    if (clip?.content.kind !== "audioLoop") return;
    expect(clip.content.assetId).toBe(asset?.id);
    expect(clip.content.sourceTempo).toBe(sample.bpm ?? project.song.tempo);
    expect(clip.content.startOffsetTicks).toBe(0);

    // Placed at bar 1, spanning the clip.
    const placement = result.project.song.placements.find(
      (entry) => entry.trackId === track.id,
    );
    expect(placement?.startTicks).toBe(0);
    expect(placement?.durationTicks).toBe(clip.lengthTicks);
    expect(placement?.clipId).toBe(clip.id);

    // One transaction: one revision, so one undo takes the track, the clip and
    // the asset back together.
    expect(result.project.metadata.revision).toBe(project.metadata.revision + 1);
  });

  it("is one history entry, and one undo takes the track, clip and asset back", async () => {
    const project = createSliceFixtureProject();
    const sample = await loopSample();
    const history = new CommandHistory(project);

    const result = history.execute(
      insertLoopCommands(project, sample, context(), {
        order: project.song.tracks.length,
        existingNames: project.song.tracks.map((track) => track.name),
        songTempo: project.song.tempo,
      }).commands,
    );
    expect(result.ok).toBe(true);
    expect(history.entries).toHaveLength(1);
    expect(carriedAsset(history.project, sample)).not.toBeNull();

    history.undo();
    // Nothing orphaned: the asset goes with the track that brought it.
    expect(history.project.song.tracks).toEqual(project.song.tracks);
    expect(history.project.clips).toEqual(project.clips);
    expect(history.project.song.assets).toEqual(project.song.assets);
    expect(history.project.metadata.packDependencies).toEqual(
      project.metadata.packDependencies,
    );
  });

  it("moves nothing else: tempo, loop brace, looping and every existing track", async () => {
    const project = createSliceFixtureProject();
    // A source tempo different from the song's is the case that could tempt
    // an insert into retempoing the song.
    const sample = { ...(await loopSample()), bpm: project.song.tempo + 17 };

    const result = executeTransaction(
      project,
      insertLoopCommands(project, sample, context(), {
        order: project.song.tracks.length,
        existingNames: project.song.tracks.map((track) => track.name),
        songTempo: project.song.tempo,
      }).commands,
    );
    if (!result.ok) throw new Error(result.issues[0].message);

    expect(result.project.song.tempo).toBe(project.song.tempo);
    expect(result.project.song.loop).toEqual(project.song.loop);
    expect(result.project.song.tracks.slice(0, project.song.tracks.length)).toEqual(
      project.song.tracks,
    );
    expect(
      result.project.song.placements.slice(0, project.song.placements.length),
    ).toEqual(project.song.placements);
    // ...while the clip keeps the loop's own tempo, so playback stretches it.
    const clip = result.project.clips.at(-1);
    expect(clip?.content.kind === "audioLoop" && clip.content.sourceTempo).toBe(
      sample.bpm,
    );
  });

  it("gives the new track no empty note clip", async () => {
    const project = createSliceFixtureProject();
    const sample = await loopSample();
    const result = executeTransaction(
      project,
      insertLoopCommands(project, sample, context(), {
        order: project.song.tracks.length,
        existingNames: [],
        songTempo: project.song.tempo,
      }).commands,
    );
    if (!result.ok) throw new Error(result.issues[0].message);

    const track = result.project.song.tracks.at(-1);
    const clips = result.project.clips.filter((entry) => entry.trackId === track?.id);
    // Exactly one clip, and it is the loop — an audio track has nothing to
    // program, so the empty one-bar note clip a new instrument track gets
    // would be a second, silent thing on the timeline.
    expect(clips).toHaveLength(1);
    expect(clips[0].content.kind).toBe("audioLoop");
  });

  it("reuses a delivery the project already carries", async () => {
    const project = createSliceFixtureProject();
    const sample = await loopSample();
    const options = {
      order: project.song.tracks.length,
      existingNames: project.song.tracks.map((track) => track.name),
      songTempo: project.song.tempo,
    };
    const first = executeTransaction(
      project,
      insertLoopCommands(project, sample, context("first"), options).commands,
    );
    if (!first.ok) throw new Error(first.issues[0].message);

    const commands = insertLoopCommands(first.project, sample, context("second"), {
      ...options,
      order: first.project.song.tracks.length,
      existingNames: first.project.song.tracks.map((track) => track.name),
    }).commands;
    // The track is added; the asset is not carried twice.
    expect(commands).toHaveLength(1);

    const second = executeTransaction(first.project, commands);
    if (!second.ok) throw new Error(second.issues[0].message);
    expect(second.project.song.assets).toHaveLength(first.project.song.assets.length);
    // Both tracks' clips point at the one asset, and the pack it came from is
    // a dependency exactly once.
    const loopAssetIds = second.project.clips.flatMap((clip) =>
      clip.content.kind === "audioLoop" ? [clip.content.assetId] : [],
    );
    expect(new Set(loopAssetIds).size).toBe(1);
    expect(
      second.project.metadata.packDependencies.filter(
        (dep) => dep.packId === sample.packId,
      ),
    ).toHaveLength(1);
    // ... and the second track's name does not collide with the first's.
    expect(second.project.song.tracks.at(-1)?.name).not.toBe(
      first.project.song.tracks.at(-1)?.name,
    );
  });

  it("sizes the clip from the bar count the loop declares", async () => {
    const base = await loopSample();
    // The declared count wins over a duration that measures differently —
    // the library builder cut the file to exactly that many bars.
    expect(
      loopClipLengthTicks({ ...base, bars: 4, bpm: 140, durationSeconds: 3.4285 }),
    ).toBe(4 * TICKS_PER_BAR);
    expect(
      loopClipLengthTicks({ ...base, bars: 2, bpm: null, durationSeconds: null }),
    ).toBe(2 * TICKS_PER_BAR);
  });

  it("reads the declared bar count off a delivered loop", async () => {
    const assets = await libraryAssets("core-electronic-drums");
    const declared = assets.filter((asset) => asset.type === "loop" && asset.bars);
    expect(declared.length).toBeGreaterThan(0);
    for (const asset of declared) {
      const sample = toLibrarySample(asset);
      expect(sample?.bars).toBe(asset.bars);
      if (sample)
        expect(loopClipLengthTicks(sample)).toBe((asset.bars ?? 0) * TICKS_PER_BAR);
    }
  });

  it("measures the clip in whole bars from the loop's own tempo when it declares none", async () => {
    const base = { ...(await loopSample()), bars: null };
    // Two bars at 140 BPM: 8 beats / (140/60) = 3.4285s.
    expect(loopClipLengthTicks({ ...base, bpm: 140, durationSeconds: 3.4285 })).toBe(
      2 * TICKS_PER_BAR,
    );
    // One bar at 120: 4 beats = 2s.
    expect(loopClipLengthTicks({ ...base, bpm: 120, durationSeconds: 2 })).toBe(
      TICKS_PER_BAR,
    );
    // A loop that states no tempo is not guessed at — one bar, unstretched.
    expect(loopClipLengthTicks({ ...base, bpm: null, durationSeconds: 3.4285 })).toBe(
      TICKS_PER_BAR,
    );
    expect(loopClipLengthTicks({ ...base, bpm: 140, durationSeconds: null })).toBe(
      TICKS_PER_BAR,
    );
  });

  it("is labelled as the track it adds, not the asset it carries in (GRV-160)", async () => {
    const project = createSliceFixtureProject();
    const sample = await loopSample();
    const insert = insertLoopCommands(project, sample, context(), {
      order: project.song.tracks.length,
      existingNames: [],
      songTempo: project.song.tempo,
    });
    expect(insert.commands.some((command) => command.type === "asset.add")).toBe(true);

    const result = executeTransaction(project, insert.commands);
    if (!result.ok) throw new Error(result.issues[0].message);
    expect(result.summary).toBe(`Add track "${sample.name}"`);
  });

  it("plays unstretched when the loop states no tempo", async () => {
    const project = createSliceFixtureProject();
    const base = await loopSample();
    const sample = { ...base, bpm: null };

    const result = executeTransaction(
      project,
      insertLoopCommands(project, sample, context(), {
        order: project.song.tracks.length,
        existingNames: [],
        songTempo: project.song.tempo,
      }).commands,
    );
    if (!result.ok) throw new Error(result.issues[0].message);

    const clip = result.project.clips.at(-1);
    if (clip?.content.kind !== "audioLoop") throw new Error("expected an audio loop");
    // sourceTempo === song tempo makes the stretch ratio exactly 1, so the
    // audio is left alone rather than stretched to a tempo nobody stated.
    expect(clip.content.sourceTempo).toBe(project.song.tempo);
  });
});

describe("loadPadSampleCommands (#447)", () => {
  it("carries the sound and points one pad at it, in one transaction", async () => {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks.find(
      (candidate) => candidate.instrument?.kind === "drumMachine",
    );
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [first, second] = track.instrument.pads;
    const sample = toLibrarySample((await libraryAssets())[1]);
    if (!sample) throw new Error("expected an insertable sample");

    const result = executeTransaction(
      project,
      loadPadSampleCommands(project, track.id, second.id, sample, context()),
    );
    if (!result.ok) throw new Error(result.issues[0].message);

    const asset = carriedAsset(result.project, sample);
    const drum = result.project.song.tracks.find((t) => t.id === track.id)?.instrument;
    const pads = drum?.kind === "drumMachine" ? drum.pads : [];
    expect(pads[1].assetId).toBe(asset?.id);
    // Only the chosen pad changes.
    expect(pads[0].assetId).toBe(first.assetId);
    expect(result.project.metadata.revision).toBe(project.metadata.revision + 1);

    // A second load of the same sound reuses the carried asset.
    expect(
      loadPadSampleCommands(result.project, track.id, first.id, sample, context("b")),
    ).toHaveLength(1);
  });

  it('names a pad still called "Pad N" after the sound, undone with the load', async () => {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks.find((t) => t.instrument?.kind === "drumMachine");
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const pad = track.instrument.pads[0];
    const sample = toLibrarySample((await libraryAssets())[1]);
    if (!sample) throw new Error("expected an insertable sample");
    const padOf = (p: typeof project) => {
      const drum = p.song.tracks.find((t) => t.id === track.id)?.instrument;
      return drum?.kind === "drumMachine" ? drum.pads[0] : undefined;
    };

    const auto = structuredClone(project);
    const autoTrack = auto.song.tracks.find((t) => t.id === track.id);
    if (autoTrack?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    autoTrack.instrument.pads[0].name = "Pad 7";
    const named = executeTransaction(
      auto,
      loadPadSampleCommands(auto, track.id, pad.id, sample, context()),
    );
    if (!named.ok) throw new Error(named.issues[0].message);
    expect(padOf(named.project)?.name).toBe(sample.name);
    expect(named.project.metadata.revision).toBe(auto.metadata.revision + 1);

    const typed = structuredClone(auto);
    const typedTrack = typed.song.tracks.find((t) => t.id === track.id);
    if (typedTrack?.instrument?.kind !== "drumMachine")
      throw new Error("no drum machine");
    typedTrack.instrument.pads[0].name = "My Kick";
    const kept = executeTransaction(
      typed,
      loadPadSampleCommands(typed, track.id, pad.id, sample, context()),
    );
    if (!kept.ok) throw new Error(kept.issues[0].message);
    expect(padOf(kept.project)?.name).toBe("My Kick");
  });
});

describe("undoing an insert from a pack the project does not use yet (GRV-50)", () => {
  async function insertFromNewPack() {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks.find((t) => t.instrument?.kind === "drumMachine");
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const pad = track.instrument.pads[0];
    const sample = toLibrarySample((await libraryAssets())[1]);
    if (!sample) throw new Error("expected an insertable sample");
    const shelved = { packId: sample.packId, version: sample.packVersion };
    expect(project.metadata.addedPacks).not.toContainEqual(shelved);
    return { project, track, pad, sample, shelved };
  }

  it("takes the pack the insert brought in back off the project, and redo returns it", async () => {
    const { project, track, pad, sample, shelved } = await insertFromNewPack();
    const history = new CommandHistory(project);

    const result = history.execute(
      loadPadSampleCommands(project, track.id, pad.id, sample, context()),
    );
    if (!result.ok) throw new Error(result.issues[0].message);
    expect(history.project.metadata.addedPacks).toContainEqual(shelved);

    const undone = history.undo();
    if (!undone?.ok) throw new Error("undo failed");
    expect(history.project.song.assets).toEqual(project.song.assets);
    expect(history.project.metadata.packDependencies).toEqual(
      project.metadata.packDependencies,
    );
    expect(history.project.metadata.addedPacks).toEqual(project.metadata.addedPacks);

    const redone = history.redo();
    if (!redone?.ok) throw new Error("redo failed");
    expect(history.project.metadata.addedPacks).toContainEqual(shelved);
  });

  it("keeps a pack the user added on purpose before the insert", async () => {
    const { project, track, pad, sample, shelved } = await insertFromNewPack();
    const history = new CommandHistory(project);
    const added = history.execute([addPack(shelved)]);
    if (!added.ok) throw new Error(added.issues[0].message);
    const withPack = history.project;

    const result = history.execute(
      loadPadSampleCommands(withPack, track.id, pad.id, sample, context()),
    );
    if (!result.ok) throw new Error(result.issues[0].message);

    history.undo();
    expect(history.project.metadata.addedPacks).toEqual(withPack.metadata.addedPacks);
    expect(history.project.metadata.addedPacks).toContainEqual(shelved);
  });
});

describe("addPadWithSampleCommands (#947)", () => {
  it("adds one pad playing the sound, named for it, undone in one step", async () => {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks.find((t) => t.instrument?.kind === "drumMachine");
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const before = track.instrument.pads;
    const sample = toLibrarySample((await libraryAssets())[1]);
    if (!sample) throw new Error("expected an insertable sample");
    const history = new CommandHistory(project);

    const { commands, padId } = addPadWithSampleCommands(
      project,
      track.id,
      sample,
      context(),
    );
    const result = history.execute(commands);
    if (!result.ok) throw new Error(result.issues[0].message);

    const padsOf = (p: typeof project) => {
      const drum = p.song.tracks.find((t) => t.id === track.id)?.instrument;
      return drum?.kind === "drumMachine" ? drum.pads : [];
    };
    const after = padsOf(history.project);
    expect(after).toHaveLength(before.length + 1);
    const added = after[after.length - 1];
    expect(added.id).toBe(padId);
    expect(added.name).toBe(sample.name);
    expect(added.assetId).toBe(carriedAsset(history.project, sample)?.id);
    expect(history.project.metadata.revision).toBe(project.metadata.revision + 1);

    history.undo();
    expect(padsOf(history.project)).toEqual(before);
    expect(carriedAsset(history.project, sample)).toBeNull();
  });

  it("leaves a track that is not a drum machine unchanged", async () => {
    const project = createSliceFixtureProject();
    const track = project.song.tracks[0];
    const sample = toLibrarySample((await libraryAssets())[1]);
    if (!sample) throw new Error("expected an insertable sample");
    const result = executeTransaction(
      project,
      addPadWithSampleCommands(project, track.id, sample, context()).commands,
    );
    expect(result.ok).toBe(false);
  });
});

describe("inserting into a project pinned to an older pack version (#892)", () => {
  /**
   * The drum-machine fixture with one pad playing a Core Electronic Drums
   * sound pinned at 1.0.0 — what a project made before #712 moved the factory
   * packs to 1.1.0 carries.
   */
  async function olderPinnedProject() {
    const [kept, inserted] = (await libraryAssets()).filter((asset) => asset.url);
    const keptSample = toLibrarySample(kept);
    const newer = toLibrarySample(inserted);
    if (!keptSample || !newer) throw new Error("expected insertable samples");
    const older = { ...keptSample, packVersion: packVersion("1.0.0") };
    const fixture = createDrumMachineFixtureProject();
    const track = fixture.song.tracks.find((t) => t.instrument?.kind === "drumMachine");
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [first, second] = track.instrument.pads;
    const seeded = executeTransaction(
      fixture,
      loadPadSampleCommands(fixture, track.id, first.id, older, context("older")),
    );
    if (!seeded.ok) throw new Error(seeded.issues[0].message);
    return { project: seeded.project, track, first, second, older, keptSample, newer };
  }

  it("upgrades the pin in the same transaction, and one undo restores it", async () => {
    const { project, track, second, older, newer } = await olderPinnedProject();
    expect(newer.packVersion).not.toBe(older.packVersion);
    const history = new CommandHistory(project);

    const result = history.execute(
      loadPadSampleCommands(project, track.id, second.id, newer, context()),
    );

    if (!result.ok) throw new Error(result.issues[0].message);
    const next = history.project;
    expect(next.metadata.revision).toBe(project.metadata.revision + 1);
    const fromPack = next.song.assets.filter((asset) => asset.packId === newer.packId);
    expect(fromPack).toHaveLength(2);
    for (const asset of fromPack) expect(asset.packVersion).toBe(newer.packVersion);
    expect(next.metadata.packDependencies).toContainEqual({
      packId: newer.packId,
      version: newer.packVersion,
    });
    expect(next.metadata.addedPacks).toContainEqual({
      packId: newer.packId,
      version: newer.packVersion,
    });

    history.undo();
    expect(history.project.song.assets).toEqual(project.song.assets);
    expect(history.project.metadata.packDependencies).toEqual(
      project.metadata.packDependencies,
    );
    expect(history.project.metadata.addedPacks).toEqual(project.metadata.addedPacks);
  });

  it("reuses the project's own copy of a sound it already had at the older version", async () => {
    const { project, track, second, keptSample } = await olderPinnedProject();

    const commands = loadPadSampleCommands(
      project,
      track.id,
      second.id,
      keptSample,
      context(),
    );
    const result = executeTransaction(project, commands);

    if (!result.ok) throw new Error(result.issues[0].message);
    expect(result.project.song.assets).toHaveLength(project.song.assets.length);
    expect(carriedAsset(result.project, keptSample)).not.toBeNull();
  });

  it("upgrades for the sampler and loop paths too", async () => {
    const { project, newer } = await olderPinnedProject();
    const sampler = project.song.tracks.find((t) => t.instrument?.kind === "sampler");
    const loops = (await libraryAssets()).filter((asset) => asset.type === "loop");
    const loop = toLibrarySample(loops[0]);
    if (!loop) throw new Error("expected a loop in the pack");

    const loaded = sampler
      ? executeTransaction(
          project,
          loadSampleCommands(project, sampler.id, newer, context("sampler")),
        )
      : null;
    const inserted = executeTransaction(
      project,
      insertLoopCommands(project, loop, context("loop"), {
        order: project.song.tracks.length,
        existingNames: [],
        songTempo: project.song.tempo,
      }).commands,
    );

    if (loaded && !loaded.ok) throw new Error(loaded.issues[0].message);
    if (!inserted.ok) throw new Error(inserted.issues[0].message);
  });
});

describe("replaceLoopCommands", () => {
  /** A tempo-labelled loop from the delivered library, as insertion builds one. */
  async function loopSample() {
    const base = toLibrarySample((await libraryAssets())[0]);
    if (!base) throw new Error("expected an insertable asset");
    return { ...base, kind: "loop" as const, bpm: 140, bars: 4, durationSeconds: 6.857 };
  }

  /** The drum-machine fixture's loop track and the loop clip it plays. */
  function loopTrack() {
    const project = createDrumMachineFixtureProject();
    const clip = project.clips.find((c) => c.content.kind === "audioLoop");
    if (!clip) throw new Error("fixture has no audio loop");
    return { project, clip, trackId: clip.trackId };
  }

  it("swaps the track's loop in one transaction, keeping its placements", async () => {
    const { project, clip, trackId } = loopTrack();
    const sample = await loopSample();
    const placementsBefore = project.song.placements.filter((p) => p.clipId === clip.id);
    const tracksBefore = project.song.tracks;

    const result = executeTransaction(
      project,
      replaceLoopCommands(project, trackId, sample, context(), { songTempo: 120 }),
    );
    expect(result.ok, result.ok ? "" : result.issues[0].message).toBe(true);
    if (!result.ok) return;

    // One revision, the same tracks, and the track still plays exactly one loop.
    expect(result.project.metadata.revision).toBe(project.metadata.revision + 1);
    expect(result.project.song.tracks.map((t) => t.id)).toEqual(
      tracksBefore.map((t) => t.id),
    );
    const loops = result.project.clips.filter(
      (c) => c.trackId === trackId && c.content.kind === "audioLoop",
    );
    expect(loops).toHaveLength(1);
    const [next] = loops;
    expect(next.id).not.toBe(clip.id);
    expect(next.name).toBe(sample.name);
    expect(next.lengthTicks).toBe(4 * TICKS_PER_BAR);
    const content = next.content;
    if (content.kind !== "audioLoop") throw new Error("expected a loop clip");
    expect(content.sourceTempo).toBe(140);
    const asset = result.project.song.assets.find((a) => a.id === content.assetId);
    expect(asset?.storageRef).toBe(sample.storageRef);

    // Every placement moved to the new clip, where the old one sat.
    const placementsAfter = result.project.song.placements.filter(
      (p) => p.clipId === next.id,
    );
    expect(placementsAfter.map((p) => [p.startTicks, p.durationTicks])).toEqual(
      placementsBefore.map((p) => [p.startTicks, p.durationTicks]),
    );
    expect(result.project.song.placements.some((p) => p.clipId === clip.id)).toBe(false);
  });

  it("undoes as one step, back to the original loop", async () => {
    const { project, clip, trackId } = loopTrack();
    const history = new CommandHistory(project);
    history.execute(
      replaceLoopCommands(project, trackId, await loopSample(), context(), {
        songTempo: 120,
      }),
    );
    history.undo();
    expect(history.project.clips.some((c) => c.id === clip.id)).toBe(true);
    expect(history.project.song.placements).toEqual(project.song.placements);
  });

  it("gives a loop track with no loop one at bar 1", async () => {
    const { project: withLoop, clip, trackId } = loopTrack();
    const emptied = executeTransaction(withLoop, [removeClip(clip.id)]);
    if (!emptied.ok) throw new Error("could not empty the loop track");
    const project = emptied.project;

    const result = executeTransaction(
      project,
      replaceLoopCommands(project, trackId, await loopSample(), context(), {
        songTempo: 120,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const placements = result.project.song.placements.filter(
      (p) => p.trackId === trackId,
    );
    expect(placements.map((p) => [p.startTicks, p.durationTicks])).toEqual([
      [0, 4 * TICKS_PER_BAR],
    ]);
  });

  it("does nothing for a track that is not a loop track, or a sound that is not a loop", async () => {
    const { project, trackId } = loopTrack();
    const sample = await loopSample();
    const instrumentTrack = project.song.tracks.find((t) => t.type !== "audio");
    if (!instrumentTrack) throw new Error("fixture has no instrument track");
    expect(
      replaceLoopCommands(project, instrumentTrack.id, sample, context(), {
        songTempo: 120,
      }),
    ).toEqual([]);
    expect(
      replaceLoopCommands(project, trackId, { ...sample, kind: "sample" }, context(), {
        songTempo: 120,
      }),
    ).toEqual([]);
  });
});
