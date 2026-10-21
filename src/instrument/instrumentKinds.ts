import type { InstrumentTypeKey } from "../analytics/catalog";
import type { Asset, Instrument, Project } from "../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createSamplerInstrument,
  createSynthInstrument,
  type DomainFactoryContext,
} from "../domain/factories";
import type { ClipId, EventId, TrackId } from "../domain/ids";
import { createFactoryAsset, factoryLibraryEntry } from "../library/factoryLibrary";

/**
 * The instrument kinds the app offers, and what moving a track between them
 * costs (#224, #223).
 *
 * Two surfaces choose an instrument kind — creating a track (`trackCreation`)
 * and changing an existing track's (`InstrumentKindPicker`) — and they were
 * written in parallel, each with its own copy of these facts. That divergence
 * was visible: a track *created* as a drum machine opened with different pads
 * from one *switched* to a drum machine. So the kind, its label, the
 * `instrument_type` it reports, and the instrument it mints are declared once,
 * here, and both surfaces read them.
 *
 * Nothing here mutates a project. `createInstrumentOfKind` builds the
 * instrument an `instrument.change` (or `track.add`) payload carries, so the
 * command layer stays the one mutation path (PRD section 9.6).
 */

export type InstrumentKind = Instrument["kind"];

export interface InstrumentKindSpec {
  readonly kind: InstrumentKind;
  /** The control's visible text. */
  readonly label: string;
  /** This kind's `instrument_type` in the OPS-02 catalog. */
  readonly analyticsType: InstrumentTypeKey;
}

/**
 * Every kind, in the order both surfaces offer them. Sampler leads because it
 * is what the starter project arrives with and what a loop is usually built
 * from.
 */
export const INSTRUMENT_KINDS: readonly InstrumentKindSpec[] = [
  { kind: "sampler", label: "Sampler", analyticsType: "sampler" },
  { kind: "drumMachine", label: "Drum machine", analyticsType: "drum_machine" },
  { kind: "synth", label: "Synth", analyticsType: "synth" },
];

export function instrumentKindSpec(kind: InstrumentKind): InstrumentKindSpec {
  const spec = INSTRUMENT_KINDS.find((candidate) => candidate.kind === kind);
  if (!spec) throw new TypeError(`Unknown instrument kind "${kind}"`);
  return spec;
}

/** The `instrument_type` an existing track reports, or undefined if it has none. */
export function instrumentTypeKey(
  instrument: Instrument | null,
): InstrumentTypeKey | undefined {
  if (!instrument) return undefined;
  return INSTRUMENT_KINDS.find((spec) => spec.kind === instrument.kind)?.analyticsType;
}

/**
 * The lanes a new drum machine opens with: the four voices a beat is built
 * from, each loaded with a basic electronic factory sound so the machine plays
 * the moment it exists (#447). More are added from the drum panel's "Add pad"
 * button, and any pad's sound can be swapped from the library.
 *
 * `matches` is how a pad someone else named (the assistant's "Kick", "Closed
 * Hat") is recognised as one of these voices, so it takes the voice's sound
 * and keeps its own ID, which its notes name (GRV-192).
 */
const STARTER_KIT = [
  { name: "BD", sound: "starterKick", matches: /kick|\bbd\b|bass ?drum/i },
  { name: "SD", sound: "starterSnare", matches: /snare|\bsd\b/i },
  { name: "HH", sound: "starterHat", matches: /(?<!open[\s-]?)hat|\bhh\b|\bch\b/i },
  { name: "CP", sound: "starterClap", matches: /clap|\bcp\b/i },
] as const;

/**
 * Voices a beat may name that the kit does not open with, each with a factory
 * sound of its own. A pad named for one ("Rim", "Open Hat") takes that sound,
 * never another voice's: a rim pattern on a kick sample plays a second kick
 * (GRV-192).
 */
const OTHER_VOICES = [
  { sound: "starterRim", matches: /rim|side ?stick|\brs\b/i },
  { sound: "starterOpenHat", matches: /open|\boh\b/i },
  { sound: "starterTom", matches: /\btoms?\b|\b[lmh]t\b/i },
  { sound: "starterCymbal", matches: /cymbal|crash|ride|splash|china|\bcy\b/i },
  {
    sound: "starterPercussion",
    matches: /perc|conga|bongo|cowbell|shaker|tamb|clave|block|cabasa|guiro/i,
  },
] as const;

type KitSound =
  | (typeof STARTER_KIT)[number]["sound"]
  | (typeof OTHER_VOICES)[number]["sound"];

/**
 * A fresh instrument of `kind`, at its defaults. Every ID it needs is minted
 * here, so the command payload carries them explicitly and a replay, redo, or
 * assistant preview reproduces the same project.
 */
export function createInstrumentOfKind(
  context: DomainFactoryContext,
  kind: InstrumentKind,
): Instrument {
  switch (kind) {
    case "sampler":
      // No sample yet: one is loaded from the library or the sampler panel.
      return createSamplerInstrument();
    case "drumMachine":
      return createDrumMachineInstrument(
        STARTER_KIT.map(({ name }) => createDrumPad(context, { name })),
      );
    case "synth":
      return createSynthInstrument();
  }
}

/** An instrument to put on a track in `project`, and the assets it needs added. */
export interface NewInstrument {
  readonly instrument: Instrument;
  /** Assets the instrument refers to that the project does not carry yet. */
  readonly assets: readonly Asset[];
}

/**
 * What every path that creates an instrument uses, the UI's surfaces and the
 * assistant's proposals alike: `createInstrumentOfKind`, except that a drum
 * machine arrives with its starter kit loaded (see {@link loadStarterKit}).
 */
export function newInstrumentOfKind(
  context: DomainFactoryContext,
  kind: InstrumentKind,
  project: Project,
): NewInstrument {
  if (kind !== "drumMachine") {
    return { instrument: createInstrumentOfKind(context, kind), assets: [] };
  }
  return loadStarterKit(
    context,
    { kind: "drumMachine", pads: [], parameters: {} },
    project,
  );
}

/**
 * `instrument`, a drum machine about to be created, with the starter kit
 * loaded into it (#447, GRV-192). Every voice of the kit is there, in the
 * kit's order: a pad `instrument` already has that matches a voice by name
 * stands in for it, keeping its ID and taking the voice's sound unless it has
 * one of its own; a voice no pad matches gets a fresh pad. The pads that match
 * no kit voice follow, and one with no sound takes the sound of the voice its
 * name says ({@link OTHER_VOICES}). One whose name says no voice is left
 * without a sound rather than given another voice's. A sound the project
 * already carries is reused rather than added twice; the rest come back in
 * `assets`.
 */
export function loadStarterKit(
  context: DomainFactoryContext,
  instrument: Extract<Instrument, { kind: "drumMachine" }>,
  project: Project,
): NewInstrument {
  const added: Asset[] = [];
  const kitAsset = (sound: KitSound) => {
    const { storageRef } = factoryLibraryEntry(sound);
    let asset = [...project.song.assets, ...added].find(
      (candidate) => candidate.storageRef === storageRef,
    );
    if (!asset) {
      asset = createFactoryAsset(context, sound);
      added.push(asset);
    }
    return asset.id;
  };
  const unmatched = [...instrument.pads];
  const voices = STARTER_KIT.map(({ name, sound, matches }) => {
    const index = unmatched.findIndex((pad) => matches.test(pad.name));
    const [pad] = index < 0 ? [] : unmatched.splice(index, 1);
    if (pad?.assetId) return pad;
    const assetId = kitAsset(sound);
    return pad ? { ...pad, assetId } : createDrumPad(context, { name, assetId });
  });
  const others = unmatched.map((pad) => {
    if (pad.assetId) return pad;
    const voice = OTHER_VOICES.find(({ matches }) => matches.test(pad.name));
    return voice ? { ...pad, assetId: kitAsset(voice.sound) } : pad;
  });
  return { instrument: { ...instrument, pads: [...voices, ...others] }, assets: added };
}

/** Notes in one clip that trigger a pad rather than a pitch. */
export interface PadTriggeredHits {
  readonly clipId: ClipId;
  readonly eventIds: readonly EventId[];
}

/**
 * Every pad-triggered note in a track's clips.
 *
 * A note may only name a pad its own track owns (the domain's pad-trigger
 * invariant), so leaving a drum machine strands exactly these notes: the
 * transaction would be rejected whole and the switch would silently do
 * nothing. They are what the picker warns about and removes in the same
 * transaction, so undo restores the hits and the machine together.
 */
export function padTriggeredHits(
  project: Project | null,
  trackId: TrackId,
): readonly PadTriggeredHits[] {
  if (!project) return [];
  return project.clips.flatMap((clip) => {
    if (clip.trackId !== trackId || clip.content.kind !== "notes") return [];
    const eventIds = clip.content.events
      .filter((event) => event.trigger.kind === "pad")
      .map((event) => event.id);
    return eventIds.length > 0 ? [{ clipId: clip.id, eventIds }] : [];
  });
}

/** How many notes {@link padTriggeredHits} found, across every clip. */
export function countPadTriggeredHits(hits: readonly PadTriggeredHits[]): number {
  return hits.reduce((total, hit) => total + hit.eventIds.length, 0);
}
