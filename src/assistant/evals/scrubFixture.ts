/**
 * Turns a production project into an eval fixture that may live in a public
 * repository (GRV-109): `bun run assistant:fixture` loads the project, and this
 * scrubs it.
 *
 * The scrubber is an **allowlist**. Every object in the output is built field
 * by field from the fields named here, never by spreading the input, so a field
 * the schema gains later is dropped until someone decides it is safe to keep
 * (and the type checker says so, because the output no longer satisfies the
 * entity type). What it keeps is musical data: notes, timing, devices and
 * their parameters, mixer values, automation, colours, tempo, key and loop.
 * What a producer wrote goes:
 *
 * - the project is called `Fixture`; tracks are named by instrument kind and
 *   index (`Drum machine 1`, `Synth 2`); clips, sections and returns are
 *   `Clip N`, `Section N` and `Return N`;
 * - a drum pad keeps its name only when it is the name the factory library
 *   gave its sound, and is otherwise `Pad N`;
 * - the template, genre, device presets, owner, collaborators and timestamps
 *   are cleared or made generic;
 * - an asset survives only when it is a factory sound (`factoryCatalog.ts`),
 *   rebuilt from the library's facts. Any other asset (a producer's own
 *   sound, GRV-282) refuses the scrub, naming the tracks it is on, unless
 *   `dropUnresolvable` removes those tracks;
 * - every ID is minted afresh from a seeded factory, so neither the
 *   production IDs nor the owner's uid appear in the output.
 *
 * The result goes back through `parseProject`. Pure: no I/O.
 */
import type {
  Asset,
  AutomationLane,
  AutomationTarget,
  Clip,
  ClipContent,
  Device,
  DrumPad,
  Instrument,
  NoteEvent,
  NoteTrigger,
  Placement,
  Project,
  ReturnBus,
  Section,
  Song,
  Track,
} from "../../domain/entities";
import {
  createSeededIdFactory,
  type EntityId,
  type EntityKind,
  type IdFactory,
} from "../../domain/ids";
import { derivePackDependencies } from "../../domain/packs";
import { formatIssue, parseProject } from "../../domain/parse";
import type { FactoryCatalog } from "./factoryCatalog";

export interface ScrubOptions {
  /** The factory sounds an asset may resolve to. */
  readonly catalog: FactoryCatalog;
  /** Seeds the fresh IDs, so the same project scrubs to the same fixture. */
  readonly seed: string;
  /** Remove tracks that use a sound outside the factory library, rather than refuse. */
  readonly dropUnresolvable?: boolean;
}

export type RenameKind = "project" | "track" | "clip" | "section" | "return" | "pad";

/** One name the scrub changed. `from` is the producer's: print it, never write it. */
export interface Rename {
  readonly kind: RenameKind;
  readonly from: string;
  readonly to: string;
}

/** A track that uses a sound the factory library does not have. */
export interface UnresolvableTrack {
  /** The track's name in the production project. */
  readonly name: string;
  /** How many of its sounds do not resolve. */
  readonly assets: number;
}

export interface FixtureSummary {
  readonly tracks: number;
  readonly clips: number;
  readonly notes: number;
  readonly devices: number;
}

export type ScrubResult =
  | {
      readonly ok: true;
      readonly project: Project;
      readonly renames: readonly Rename[];
      /** Tracks `dropUnresolvable` removed, by their production names. */
      readonly droppedTracks: readonly string[];
      /** Assets removed because they are not factory sounds. */
      readonly droppedAssets: number;
      /** Free-text fields that were cleared, e.g. `genre`. */
      readonly cleared: readonly string[];
      readonly summary: FixtureSummary;
    }
  | {
      readonly ok: false;
      readonly reason: "unresolvable";
      readonly tracks: readonly UnresolvableTrack[];
    }
  | {
      readonly ok: false;
      readonly reason: "invalid";
      readonly issues: readonly string[];
    };

/** The owner every fixture names. */
export const FIXTURE_OWNER_ID = "user_fixture";
export const FIXTURE_PROJECT_NAME = "Fixture";

const INSTRUMENT_LABELS: Record<Instrument["kind"] | "audio", string> = {
  sampler: "Sampler",
  synth: "Synth",
  drumMachine: "Drum machine",
  audio: "Audio",
};

/** The asset IDs a track's instrument and clips use. */
function assetsOfTrack(track: Track, clips: readonly Clip[]): string[] {
  const ids: string[] = [];
  const instrument = track.instrument;
  if (instrument?.kind === "sampler" && instrument.assetId) ids.push(instrument.assetId);
  if (instrument?.kind === "drumMachine") {
    for (const pad of instrument.pads) if (pad.assetId) ids.push(pad.assetId);
  }
  for (const clip of clips) {
    if (clip.trackId === track.id && clip.content.kind === "audioLoop") {
      ids.push(clip.content.assetId);
    }
  }
  return ids;
}

function targetTrackId(target: AutomationTarget): string | null {
  return target.scope === "track" ||
    target.scope === "trackDevice" ||
    target.scope === "send"
    ? target.trackId
    : null;
}

const byOrder = <T extends { order: number }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.order - b.order);

/** Mints a fresh ID per source ID, and refuses a reference to one it never minted. */
function idMinter(ids: IdFactory) {
  const minted = new Map<string, string>();
  return {
    mint<K extends EntityKind>(kind: K, source: string): EntityId<K> {
      const id = ids(kind);
      minted.set(`${kind}:${source}`, id);
      return id;
    },
    fresh<K extends EntityKind>(kind: K): EntityId<K> {
      return ids(kind);
    },
    ref<K extends EntityKind>(kind: K, source: string): EntityId<K> {
      const id = minted.get(`${kind}:${source}`);
      if (id === undefined) {
        throw new Error(
          `scrubFixture: ${kind} ${source} referenced before it was minted`,
        );
      }
      return id as EntityId<K>;
    },
  };
}

type Minter = ReturnType<typeof idMinter>;

function copyParameters(
  values: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(Object.entries(values));
}

function scrubDevices(devices: readonly Device[], ids: Minter): Device[] {
  return devices.map((device) => ({
    id: ids.mint("device", device.id),
    type: device.type,
    order: device.order,
    bypassed: device.bypassed,
    parameters: copyParameters(device.parameters),
    // A preset is named; nothing in the domain says the name is a factory one.
    preset: null,
  }));
}

function scrubAsset(asset: Asset, catalog: FactoryCatalog, ids: Minter): Asset {
  const sound = catalog.sound(asset);
  if (!sound) throw new Error("scrubFixture: an unresolvable asset reached the output");
  const name = sound.names.includes(asset.name)
    ? asset.name
    : (sound.names[0] ?? "Sound");
  return {
    id: ids.mint("asset", asset.id),
    packId: asset.packId,
    packVersion: asset.packVersion,
    kind: asset.kind,
    name,
    storageRef: sound.storageRef,
    // Same-origin delivery, as a new project's factory assets carry it: never
    // the production bucket's URL.
    url: `/${sound.storageRef}`,
    durationSeconds: asset.durationSeconds,
    sampleRate: asset.sampleRate,
    channelCount: asset.channelCount,
    provenance: {
      source: "library",
      licence: sound.licence ?? asset.provenance.licence,
      attribution: null,
    },
  };
}

export function scrubFixture(source: Project, options: ScrubOptions): ScrubResult {
  const { catalog } = options;
  const unresolvable = new Set(
    source.song.assets.filter((asset) => !catalog.sound(asset)).map((asset) => asset.id),
  );

  const affected: { track: Track; assets: number }[] = [];
  for (const track of byOrder(source.song.tracks)) {
    const count = new Set(
      assetsOfTrack(track, source.clips).filter((id) =>
        unresolvable.has(id as Asset["id"]),
      ),
    ).size;
    if (count > 0) affected.push({ track, assets: count });
  }
  if (affected.length > 0 && !options.dropUnresolvable) {
    return {
      ok: false,
      reason: "unresolvable",
      tracks: affected.map(({ track, assets }) => ({ name: track.name, assets })),
    };
  }
  const dropped = new Set<string>(affected.map(({ track }) => track.id));

  const ids = idMinter(createSeededIdFactory(options.seed));
  const renames: Rename[] = [];
  const rename = (kind: RenameKind, from: string, to: string): string => {
    if (from !== to) renames.push({ kind, from, to });
    return to;
  };

  const sourceAssets = new Map(source.song.assets.map((asset) => [asset.id, asset]));
  const assets: Asset[] = source.song.assets
    .filter((asset) => !unresolvable.has(asset.id))
    .map((asset) => scrubAsset(asset, catalog, ids));

  const returns: ReturnBus[] = byOrder(source.song.returns).map((bus, index) => ({
    id: ids.mint("return", bus.id),
    name: rename("return", bus.name, `Return ${index + 1}`),
    order: bus.order,
    devices: scrubDevices(bus.devices, ids),
    mixer: { volume: bus.mixer.volume, pan: bus.mixer.pan, muted: bus.mixer.muted },
  }));

  const scrubPad = (pad: DrumPad, index: number): DrumPad => {
    const sound = pad.assetId ? sourceAssets.get(pad.assetId) : undefined;
    const factoryNames = sound ? (catalog.sound(sound)?.names ?? []) : [];
    const name = factoryNames.includes(pad.name) ? pad.name : `Pad ${index + 1}`;
    return {
      id: ids.mint("pad", pad.id),
      name: rename("pad", pad.name, name),
      assetId: pad.assetId ? ids.ref("asset", pad.assetId) : null,
      chokeGroup: pad.chokeGroup,
      parameters: copyParameters(pad.parameters),
      mixer: {
        volume: pad.mixer.volume,
        pan: pad.mixer.pan,
        muted: pad.mixer.muted,
        soloed: pad.mixer.soloed,
      },
    };
  };

  const scrubInstrument = (instrument: Instrument | null): Instrument | null => {
    if (!instrument) return null;
    switch (instrument.kind) {
      case "sampler":
        return {
          kind: "sampler",
          assetId: instrument.assetId ? ids.ref("asset", instrument.assetId) : null,
          parameters: copyParameters(instrument.parameters),
        };
      case "synth":
        return { kind: "synth", parameters: copyParameters(instrument.parameters) };
      case "drumMachine":
        return {
          kind: "drumMachine",
          pads: instrument.pads.map(scrubPad),
          parameters: copyParameters(instrument.parameters),
        };
    }
  };

  const kept = byOrder(source.song.tracks).filter((track) => !dropped.has(track.id));
  const perKind = new Map<string, number>();
  const tracks: Track[] = kept.map((track, order) => {
    const label = INSTRUMENT_LABELS[track.instrument?.kind ?? "audio"];
    const index = (perKind.get(label) ?? 0) + 1;
    perKind.set(label, index);
    return {
      id: ids.mint("track", track.id),
      name: rename("track", track.name, `${label} ${index}`),
      color: track.color,
      order,
      type: track.type,
      instrument: scrubInstrument(track.instrument),
      devices: scrubDevices(track.devices, ids),
      sendConfig: track.sendConfig.map((send) => ({
        returnId: ids.ref("return", send.returnId),
        level: send.level,
        preFader: send.preFader,
      })),
      mixer: {
        volume: track.mixer.volume,
        pan: track.mixer.pan,
        muted: track.mixer.muted,
        soloed: track.mixer.soloed,
      },
    };
  });

  const master = {
    volume: source.song.master.volume,
    devices: scrubDevices(source.song.master.devices, ids),
    safetyLimiter: source.song.master.safetyLimiter,
  };

  const sections: Section[] = [...source.song.sections]
    .sort((a, b) => a.startTicks - b.startTicks)
    .map((section, index) => ({
      id: ids.mint("section", section.id),
      name: rename("section", section.name, `Section ${index + 1}`),
      color: section.color,
      startTicks: section.startTicks,
      durationTicks: section.durationTicks,
    }));

  // Clips in arrangement order: by track, then where each first plays.
  const trackOrder = new Map(kept.map((track, order) => [track.id as string, order]));
  const firstStart = new Map<string, number>();
  for (const placement of source.song.placements) {
    const known = firstStart.get(placement.clipId);
    if (known === undefined || placement.startTicks < known) {
      firstStart.set(placement.clipId, placement.startTicks);
    }
  }
  const orderedClips = source.clips
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => trackOrder.has(clip.trackId))
    .sort(
      (a, b) =>
        (trackOrder.get(a.clip.trackId) ?? 0) - (trackOrder.get(b.clip.trackId) ?? 0) ||
        (firstStart.get(a.clip.id) ?? Number.POSITIVE_INFINITY) -
          (firstStart.get(b.clip.id) ?? Number.POSITIVE_INFINITY) ||
        a.index - b.index,
    )
    .map(({ clip }) => clip);

  const scrubTrigger = (trigger: NoteTrigger): NoteTrigger =>
    trigger.kind === "pad"
      ? { kind: "pad", padId: ids.ref("pad", trigger.padId) }
      : { kind: "pitch", pitch: trigger.pitch };

  const scrubEvent = (event: NoteEvent): NoteEvent => ({
    id: ids.fresh("event"),
    trigger: scrubTrigger(event.trigger),
    startTicks: event.startTicks,
    durationTicks: event.durationTicks,
    velocity: event.velocity,
    probability: event.probability,
  });

  const scrubContent = (content: ClipContent): ClipContent =>
    content.kind === "notes"
      ? { kind: "notes", events: content.events.map(scrubEvent) }
      : {
          kind: "audioLoop",
          assetId: ids.ref("asset", content.assetId),
          sourceTempo: content.sourceTempo,
          startOffsetTicks: content.startOffsetTicks,
        };

  const clips: Clip[] = orderedClips.map((clip, index) => ({
    id: ids.mint("clip", clip.id),
    trackId: ids.ref("track", clip.trackId),
    name: rename("clip", clip.name, `Clip ${index + 1}`),
    color: clip.color,
    lengthTicks: clip.lengthTicks,
    content: scrubContent(clip.content),
  }));

  const placements: Placement[] = source.song.placements
    .filter((placement) => !dropped.has(placement.trackId))
    .map((placement) => ({
      id: ids.fresh("placement"),
      clipId: ids.ref("clip", placement.clipId),
      trackId: ids.ref("track", placement.trackId),
      startTicks: placement.startTicks,
      durationTicks: placement.durationTicks,
      clipOffsetTicks: placement.clipOffsetTicks,
      looped: placement.looped,
    }));

  const scrubTarget = (target: AutomationTarget): AutomationTarget => {
    switch (target.scope) {
      case "track":
        return {
          scope: "track",
          trackId: ids.ref("track", target.trackId),
          parameterId: target.parameterId,
        };
      case "trackDevice":
        return {
          scope: "trackDevice",
          trackId: ids.ref("track", target.trackId),
          deviceId: ids.ref("device", target.deviceId),
          parameterId: target.parameterId,
        };
      case "send":
        return {
          scope: "send",
          trackId: ids.ref("track", target.trackId),
          returnId: ids.ref("return", target.returnId),
          parameterId: target.parameterId,
        };
      case "return":
        return {
          scope: "return",
          returnId: ids.ref("return", target.returnId),
          parameterId: target.parameterId,
        };
      case "master":
        return { scope: "master", parameterId: target.parameterId };
    }
  };

  const automation: AutomationLane[] = source.song.automation
    .filter((lane) => {
      const trackId = targetTrackId(lane.target);
      return trackId === null || !dropped.has(trackId);
    })
    .map((lane) => ({
      id: ids.fresh("automation"),
      target: scrubTarget(lane.target),
      interpolation: lane.interpolation,
      points: lane.points.map((point) => ({ tick: point.tick, value: point.value })),
    }));

  const song: Song = {
    tempo: source.song.tempo,
    swing: source.song.swing,
    timeSignature: {
      numerator: source.song.timeSignature.numerator,
      denominator: source.song.timeSignature.denominator,
    },
    loop: {
      startTicks: source.song.loop.startTicks,
      endTicks: source.song.loop.endTicks,
      enabled: source.song.loop.enabled,
    },
    key: { root: source.song.key.root, scale: source.song.key.scale },
    tracks,
    returns,
    master,
    sections,
    placements,
    automation,
    assets,
  };

  const packDependencies = derivePackDependencies(song);
  const used = new Set(packDependencies.map((entry) => entry.packId as string));
  // The shelf keeps the factory packs a producer added, and every used pack.
  const addedPacks = [
    ...packDependencies,
    ...source.metadata.addedPacks
      .filter((entry) => !used.has(entry.packId) && catalog.hasPack(entry.packId))
      .map((entry) => ({ packId: entry.packId, version: entry.version })),
  ];

  const cleared: string[] = [];
  if (source.metadata.template !== null) cleared.push("template");
  if (source.metadata.genre !== null) cleared.push("genre");
  if (source.metadata.collaboratorIds.length > 0) cleared.push("collaborators");
  const presets = [
    ...source.song.tracks.flatMap((track) => track.devices),
    ...source.song.returns.flatMap((bus) => bus.devices),
    ...source.song.master.devices,
  ].filter((device) => device.preset !== null).length;
  if (presets > 0) cleared.push(`${presets} device preset${presets === 1 ? "" : "s"}`);

  const parsed = parseProject({
    metadata: {
      id: ids.fresh("project"),
      schemaVersion: source.metadata.schemaVersion,
      revision: 0,
      name: rename("project", source.metadata.name, FIXTURE_PROJECT_NAME),
      ownerId: FIXTURE_OWNER_ID,
      collaboratorIds: [],
      createdAt: 0,
      modifiedAt: 0,
      template: null,
      genre: null,
      packDependencies,
      addedPacks,
    },
    song,
    clips,
  });
  if (!parsed.ok) {
    return { ok: false, reason: "invalid", issues: parsed.issues.map(formatIssue) };
  }
  return {
    ok: true,
    project: parsed.value,
    renames,
    droppedTracks: affected.map(({ track }) => track.name),
    droppedAssets: unresolvable.size,
    cleared,
    summary: fixtureSummary(parsed.value),
  };
}

/** Tracks, clips, notes and devices: what the tool prints of a fixture. */
export function fixtureSummary(project: Project): FixtureSummary {
  return {
    tracks: project.song.tracks.length,
    clips: project.clips.length,
    notes: project.clips.reduce(
      (sum, clip) =>
        sum + (clip.content.kind === "notes" ? clip.content.events.length : 0),
      0,
    ),
    devices:
      project.song.tracks.reduce((sum, track) => sum + track.devices.length, 0) +
      project.song.returns.reduce((sum, bus) => sum + bus.devices.length, 0) +
      project.song.master.devices.length,
  };
}
