import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDevice } from "../../domain/devices";
import type { Clip, Device, Project, Track } from "../../domain/entities";
import {
  createAsset,
  createAudioLoopClip,
  createDrumMachineInstrument,
  createDrumPad,
  createEmptySong,
  createFactoryContext,
  createNoteClip,
  createNoteEvent,
  createPack,
  createPlacement,
  createProjectMetadata,
  createReturnBus,
  createSamplerInstrument,
  createSection,
  createSend,
  createSynthInstrument,
  createTrack,
} from "../../domain/factories";
import { createSeededIdFactory } from "../../domain/ids";
import { derivePackDependencies } from "../../domain/packs";
import { assertProject, parseProject } from "../../domain/parse";
import { serializeProject } from "../../domain/serialize";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH, toTicks } from "../../domain/time";
import { createFactoryAsset } from "../../library/factoryLibrary";
import { bundledFactorySounds, factoryCatalog } from "./factoryCatalog";
import { namedFixture } from "./namedFixtures";
import { FIXTURE_OWNER_ID, scrubFixture } from "./scrubFixture";

const OWNER = "uid_SecretOwner42";

/** Every string a producer wrote into the project below. */
const SECRETS = [
  "Midnight Basement Banger",
  OWNER,
  "uid_SecretCollaborator",
  "secret-template",
  "secret-genre",
  "Wobbly Drum Rack",
  "Zeta Bassline",
  "Tape Loop Room",
  "Grandma Whistle Track",
  "Cathedral Bus",
  "Sneaky Intro",
  "Big Drop",
  "Groove of Doom",
  "Bass Wander",
  "Dusty Loop",
  "Whistle Phrase",
  "My Crunchy Clap",
  "Grandma's whistle",
  "My Secret Preset",
  "preset_secret",
  "Grandma Pack",
];

function distinctiveProject(): Project {
  const context = createFactoryContext({
    ids: createSeededIdFactory("scrub-source"),
    now: 1_760_000_000_000,
  });
  const kick = createFactoryAsset(context, "starterKick");
  const clap = createFactoryAsset(context, "starterClap");
  const loop = createFactoryAsset(context, "starterLoop");
  const userPack = createPack(context, { name: "Grandma Pack", kind: "user" });
  const whistle = createAsset(context, {
    pack: userPack,
    name: "Grandma's whistle",
    storageRef: `users/${OWNER}/library/whistle.wav`,
    source: "user",
  });

  const reverb = createReturnBus(context, { name: "Cathedral Bus", order: 0 });
  reverb.devices.push(createDevice(context.ids("device"), "reverb", 0));

  const kickPad = createDrumPad(context, { name: kick.name, assetId: kick.id });
  const clapPad = createDrumPad(context, { name: "My Crunchy Clap", assetId: clap.id });
  clapPad.parameters = { tune: 3 };
  clapPad.mixer = { volume: -4, pan: 0.25, muted: false, soloed: true };
  const filter: Device = {
    ...createDevice(context.ids("device"), "filter", 0),
    parameters: { cutoff: 1234, resonance: 0.4, mode: 1 },
    preset: { id: "preset_secret", name: "My Secret Preset", source: "user" },
  };
  const drums = createTrack(context, {
    name: "Wobbly Drum Rack",
    order: 0,
    instrument: createDrumMachineInstrument([kickPad, clapPad]),
    devices: [filter],
    sendConfig: [createSend(reverb.id, -12)],
    volume: -3,
    pan: -0.2,
  });
  const bass = createTrack(context, {
    name: "Zeta Bassline",
    order: 1,
    instrument: createSynthInstrument(),
    devices: [createDevice(context.ids("device"), "compressor", 0)],
  });
  const tape = createTrack(context, {
    name: "Tape Loop Room",
    order: 2,
    type: "audio",
    instrument: null,
  });
  const grandma = createTrack(context, {
    name: "Grandma Whistle Track",
    order: 3,
    instrument: createSamplerInstrument(whistle.id),
  });

  const beat = createNoteClip(context, {
    trackId: drums.id,
    name: "Groove of Doom",
    events: [0, 4, 8, 12].map((step) =>
      createNoteEvent(context, {
        startTicks: step * TICKS_PER_SIXTEENTH,
        durationTicks: TICKS_PER_SIXTEENTH,
        padId: step % 8 === 0 ? kickPad.id : clapPad.id,
        velocity: 0.5 + step / 40,
        probability: step === 12 ? 0.5 : null,
      }),
    ),
  });
  const bassClip = createNoteClip(context, {
    trackId: bass.id,
    name: "Bass Wander",
    events: [36, 39, 43].map((pitch, index) =>
      createNoteEvent(context, {
        startTicks: index * 4 * TICKS_PER_SIXTEENTH,
        durationTicks: 3 * TICKS_PER_SIXTEENTH,
        pitch,
        velocity: 0.7,
      }),
    ),
  });
  const loopClip = createAudioLoopClip(context, {
    trackId: tape.id,
    assetId: loop.id,
    name: "Dusty Loop",
    sourceTempo: 124,
  });
  const whistleClip = createNoteClip(context, {
    trackId: grandma.id,
    name: "Whistle Phrase",
    events: [createNoteEvent(context, { startTicks: 0, durationTicks: 96, pitch: 72 })],
  });
  const clips = [whistleClip, loopClip, bassClip, beat];

  const tracks = [drums, bass, tape, grandma];
  const song = {
    ...createEmptySong(126),
    swing: 58,
    key: { root: 9, scale: "minor" as const },
    tracks,
    returns: [reverb],
    sections: [
      createSection(context, {
        name: "Big Drop",
        startTicks: TICKS_PER_BAR * 4,
        durationTicks: TICKS_PER_BAR * 4,
      }),
      createSection(context, {
        name: "Sneaky Intro",
        startTicks: 0,
        durationTicks: TICKS_PER_BAR * 4,
      }),
    ],
    placements: clips.map((clip, index) =>
      createPlacement(context, {
        clipId: clip.id,
        trackId: clip.trackId,
        startTicks: TICKS_PER_BAR * index,
        durationTicks: TICKS_PER_BAR,
      }),
    ),
    automation: [
      {
        id: context.ids("automation"),
        target: {
          scope: "track" as const,
          trackId: bass.id,
          parameterId: "track.volume",
        },
        interpolation: "linear" as const,
        points: [
          { tick: toTicks(0), value: -12 },
          { tick: toTicks(TICKS_PER_BAR), value: -2 },
        ],
      },
      {
        id: context.ids("automation"),
        target: {
          scope: "trackDevice" as const,
          trackId: drums.id,
          deviceId: filter.id,
          parameterId: "filter.cutoff",
        },
        interpolation: "step" as const,
        points: [{ tick: toTicks(0), value: 800 }],
      },
      {
        id: context.ids("automation"),
        target: {
          scope: "track" as const,
          trackId: grandma.id,
          parameterId: "track.pan",
        },
        interpolation: "linear" as const,
        points: [{ tick: toTicks(0), value: 0.5 }],
      },
    ],
    assets: [kick, clap, loop, whistle],
  };
  const packDependencies = derivePackDependencies(song);
  return assertProject({
    metadata: createProjectMetadata(context, {
      ownerId: OWNER,
      name: "Midnight Basement Banger",
      collaboratorIds: ["uid_SecretCollaborator"],
      template: "secret-template",
      genre: "secret-genre",
      revision: 87,
      packDependencies,
    }),
    song,
    clips,
  });
}

const catalog = factoryCatalog(bundledFactorySounds());

function scrubbed(source = distinctiveProject()) {
  const result = scrubFixture(source, {
    catalog,
    seed: "fixture-test",
    dropUnresolvable: true,
  });
  if (!result.ok) throw new Error(`scrub failed: ${JSON.stringify(result)}`);
  return result;
}

/** Every entity ID in a project, except pack IDs, which name public library content. */
function entityIds(project: Project): string[] {
  const text = JSON.stringify(serializeProject(project));
  const ids = text.match(/\b[a-z]{2,4}_[A-Za-z0-9_-]{21}\b/g) ?? [];
  const packs = new Set(project.song.assets.map((asset) => asset.packId as string));
  return [...new Set(ids)].filter((id) => !packs.has(id) && !id.startsWith("pak_"));
}

function notesOf(project: Project, clip: Clip) {
  if (clip.content.kind !== "notes") return [];
  const track = project.song.tracks.find((candidate) => candidate.id === clip.trackId);
  const pads =
    track?.instrument?.kind === "drumMachine"
      ? track.instrument.pads.map((pad) => pad.id)
      : [];
  return clip.content.events.map((event) => ({
    trigger:
      event.trigger.kind === "pad"
        ? { pad: pads.indexOf(event.trigger.padId) }
        : { pitch: event.trigger.pitch },
    startTicks: event.startTicks,
    durationTicks: event.durationTicks,
    velocity: event.velocity,
    probability: event.probability,
  }));
}

function trackData(track: Track) {
  return {
    type: track.type,
    color: track.color,
    mixer: track.mixer,
    kind: track.instrument?.kind ?? null,
    instrumentParameters: track.instrument?.parameters ?? null,
    pads:
      track.instrument?.kind === "drumMachine"
        ? track.instrument.pads.map((pad) => ({
            chokeGroup: pad.chokeGroup,
            parameters: pad.parameters,
            mixer: pad.mixer,
          }))
        : null,
    devices: track.devices.map((device) => ({
      type: device.type,
      order: device.order,
      bypassed: device.bypassed,
      parameters: device.parameters,
    })),
    sends: track.sendConfig.map((send) => ({
      level: send.level,
      preFader: send.preFader,
    })),
  };
}

describe("scrubFixture", () => {
  it("refuses a project with a sound outside the factory library, naming its track", () => {
    const result = scrubFixture(distinctiveProject(), { catalog, seed: "fixture-test" });
    expect(result).toEqual({
      ok: false,
      reason: "unresolvable",
      tracks: [{ name: "Grandma Whistle Track", assets: 1 }],
    });
  });

  it("leaves none of the producer's words, IDs or uid in the output", () => {
    const source = distinctiveProject();
    const result = scrubbed(source);
    const text = JSON.stringify(result.project);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    const sourceIds = entityIds(source);
    expect(sourceIds.length).toBeGreaterThan(20);
    for (const id of sourceIds) expect(text).not.toContain(id);
    expect(result.project.metadata.ownerId).toBe(FIXTURE_OWNER_ID);
  });

  it("names everything generically, keeping a pad named after its factory sound", () => {
    const { project, droppedTracks, droppedAssets, cleared } = scrubbed();
    expect(project.metadata.name).toBe("Fixture");
    expect(project.song.tracks.map((track) => track.name)).toEqual([
      "Drum machine 1",
      "Synth 1",
      "Audio 1",
    ]);
    const drums = project.song.tracks[0]?.instrument;
    expect(drums?.kind === "drumMachine" && drums.pads.map((pad) => pad.name)).toEqual([
      "Rounded Club Kick",
      "Pad 2",
    ]);
    expect(project.song.returns.map((bus) => bus.name)).toEqual(["Return 1"]);
    expect(project.song.sections.map((section) => section.name)).toEqual([
      "Section 1",
      "Section 2",
    ]);
    expect(project.clips.map((clip) => clip.name)).toEqual([
      "Clip 1",
      "Clip 2",
      "Clip 3",
    ]);
    expect(project.metadata).toMatchObject({
      template: null,
      genre: null,
      collaboratorIds: [],
      revision: 0,
    });
    expect(droppedTracks).toEqual(["Grandma Whistle Track"]);
    expect(droppedAssets).toBe(1);
    expect(cleared).toEqual(["template", "genre", "collaborators", "1 device preset"]);
  });

  it("keeps note, device, mixer and automation data identical", () => {
    const source = distinctiveProject();
    const { project } = scrubbed(source);
    const kept = source.song.tracks.slice(0, 3);
    expect(project.song.tracks.map(trackData)).toEqual(kept.map(trackData));

    const sourceClips = [...source.clips]
      .filter((clip) => kept.some((track) => track.id === clip.trackId))
      .sort(
        (a, b) =>
          kept.findIndex((track) => track.id === a.trackId) -
          kept.findIndex((track) => track.id === b.trackId),
      );
    expect(project.clips.map((clip) => notesOf(project, clip))).toEqual(
      sourceClips.map((clip) => notesOf(source, clip)),
    );
    expect(project.clips.map((clip) => clip.lengthTicks)).toEqual(
      sourceClips.map((clip) => clip.lengthTicks),
    );
    const loop = project.clips.find((clip) => clip.content.kind === "audioLoop");
    expect(loop?.content).toMatchObject({ sourceTempo: 124, startOffsetTicks: 0 });

    expect(
      project.song.automation.map((lane) => ({
        scope: lane.target.scope,
        parameterId: lane.target.parameterId,
        interpolation: lane.interpolation,
        points: lane.points,
      })),
    ).toEqual(
      source.song.automation.slice(0, 2).map((lane) => ({
        scope: lane.target.scope,
        parameterId: lane.target.parameterId,
        interpolation: lane.interpolation,
        points: lane.points,
      })),
    );
    const { tempo, swing, key, loop: range, master } = source.song;
    expect(project.song).toMatchObject({ tempo, swing, key, loop: range });
    expect(project.song.master.volume).toBe(master.volume);
    expect(project.song.returns[0]?.devices.map((device) => device.parameters)).toEqual(
      source.song.returns[0]?.devices.map((device) => device.parameters),
    );
    expect(project.song.tracks[0]?.devices[0]?.preset).toBeNull();
  });

  it("keeps the factory assets with the library's facts, and only those packs", () => {
    const source = distinctiveProject();
    const { project } = scrubbed(source);
    expect(project.song.assets.map((asset) => asset.name)).toEqual(
      source.song.assets.slice(0, 3).map((asset) => asset.name),
    );
    for (const asset of project.song.assets) {
      expect(asset.url).toBe(`/${asset.storageRef}`);
      expect(asset.provenance.attribution).toBeNull();
    }
    expect(project.metadata.addedPacks).toEqual(project.metadata.packDependencies);
    expect(project.metadata.packDependencies.map((entry) => entry.packId)).not.toContain(
      source.song.assets[3]?.packId,
    );
  });

  it("parses, and loads as a JSON fixture", () => {
    const { project } = scrubbed();
    const json = serializeProject(project);
    expect(parseProject(json).ok).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "scrub-fixture-"));
    try {
      writeFileSync(join(dir, "scrubbed-1.json"), JSON.stringify(json, null, 2));
      expect(serializeProject(namedFixture("scrubbed-1", dir)())).toEqual(json);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic for a seed", () => {
    const a = scrubbed().project;
    const b = scrubbed().project;
    expect(serializeProject(a)).toEqual(serializeProject(b));
  });

  it("drops a field it does not know, rather than copying it", () => {
    const source = distinctiveProject();
    const leaky = {
      ...source,
      song: {
        ...source.song,
        tracks: source.song.tracks.map((track) => ({ ...track, notes: "Secret liner" })),
      },
    } as Project;
    const text = JSON.stringify(scrubbed(leaky).project);
    expect(text).not.toContain("Secret liner");
  });

  it("lists every rename, from the producer's name to the fixture's", () => {
    const { renames } = scrubbed();
    expect(renames).toContainEqual({
      kind: "project",
      from: "Midnight Basement Banger",
      to: "Fixture",
    });
    expect(renames).toContainEqual({ kind: "pad", from: "My Crunchy Clap", to: "Pad 2" });
    expect(renames.some((rename) => rename.from === "Rounded Club Kick")).toBe(false);
    expect(renames.filter((rename) => rename.kind === "track")).toHaveLength(3);
  });
});
