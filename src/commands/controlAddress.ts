import { bareParameterId } from "../domain/parameters";
import type { DeviceChainTarget } from "./definitions/deviceChains";

/**
 * Where a value lives on screen, named by the domain rather than the DOM
 * (`UI-004`, #850).
 *
 * A `ControlAddress` is the owning entity's ID plus a key: a bare parameter key
 * from `src/domain/parameters.ts` (`volume`, `swing`, `filterCutoff`) for a
 * numeric control, or one of the {@link CONTROL_PARTS} for a value that is not
 * a single number (a clip's notes, a track's header, a device chain). It never
 * names a component or an element, so a proposal, a reveal and an outline can
 * all find "BD's volume fader" without knowing which surface draws it.
 *
 * `controlsTouchedBy(command)` (`./controls.ts`) derives these from a command;
 * the editor's control registry (`src/controls`) is what turns one back into
 * the element that shows it. Addresses are UI vocabulary and are never stored
 * in a project.
 */
export interface ControlAddress {
  /**
   * An entity ID (`trk_…`, `pad_…`, `dev_…`, `clp_…`, `plc_…`, `ret_…`), or
   * one of the {@link GLOBAL_CONTROL_ENTITIES} for the song and the master bus,
   * which have no ID of their own.
   */
  readonly entity: string;
  /** A bare parameter key, or one of the {@link CONTROL_PARTS}. */
  readonly param: string;
}

/** The song: tempo, swing, loop, key, the project's name, its track list. */
export const SONG_ENTITY = "song";
/** The master bus: its volume and its own device chain. */
export const MASTER_ENTITY = "master";
export const GLOBAL_CONTROL_ENTITIES = [SONG_ENTITY, MASTER_ENTITY] as const;

/**
 * The keys an address may carry that are not a numeric parameter. Each names
 * one thing a user can see and point at, so a structural command has somewhere
 * to land: what it creates, moves or changes, or — for a delete — the parent
 * the deleted thing was listed in.
 */
export const CONTROL_PARTS = {
  /** A clip's content: its notes, steps or loop. */
  notes: "notes",
  /** A track's header, wherever tracks are listed, or a return bus's strip. */
  header: "header",
  /** A clip on the arrangement. */
  placement: "placement",
  /** A device's faceplate in its chain. */
  faceplate: "faceplate",
  /** A drum pad's row. */
  lane: "lane",
  /** The song's track list: the parent of a deleted track. */
  tracks: "tracks",
  /** The song's return buses: the parent of a deleted return (#386). */
  returns: "returns",
  /** A track's sends: the parent of a removed send (#386). */
  sends: "sends",
  /** A chain's devices: the parent of a removed device. */
  devices: "devices",
  /** A drum machine's pads: the parent of a removed pad. */
  pads: "pads",
  /** A track's lane on the arrangement: the parent of a deleted clip or placement. */
  arrangement: "arrangement",
  /** A track's instrument as a whole: its kind. */
  instrument: "instrument",
  /** The sound a sampler or a pad plays. */
  sample: "sample",
  /** A user-authored name: a project's, a clip's, a pad's, a return's. */
  name: "name",
  /** A clip's colour. */
  color: "color",
  /** A clip's length. */
  length: "length",
  /** Mute and solo, on a track or a pad. */
  muted: "muted",
  soloed: "soloed",
  /** A pad's choke group. */
  choke: "choke",
  /** A device's bypass switch. */
  bypassed: "bypassed",
  /** The song's loop brace. */
  loop: "loop",
  /** The song's key. */
  key: "key",
  /** The transport's Play button, which a lesson points at (GRV-190). */
  play: "play",
  /** The header's Export button, which a lesson points at (GRV-190). */
  export: "export",
  /** The project's packs and assets: library bookkeeping with no control of its own. */
  packs: "packs",
  assets: "assets",
} as const;
export type ControlPart = (typeof CONTROL_PARTS)[keyof typeof CONTROL_PARTS];

/** Builds an address. */
export function controlAddress(entity: string, param: string): ControlAddress {
  return { entity, param };
}

/**
 * The address of a registered parameter on an entity: `track.volume` on a
 * track is `{ entity: "trk_…", param: "volume" }`.
 */
export function parameterControl(entity: string, parameterId: string): ControlAddress {
  return { entity, param: bareParameterId(parameterId) };
}

/**
 * A view's tile in the dock (GRV-190): where a lesson's tour points. Views
 * are the editor's, so the name is a plain string here.
 */
export function viewControl(view: string): ControlAddress {
  return { entity: SONG_ENTITY, param: `view.${view}` };
}

/** The transport's Play button (GRV-190). */
export function playControl(): ControlAddress {
  return { entity: SONG_ENTITY, param: CONTROL_PARTS.play };
}

/** The header's Export button (GRV-190). */
export function exportControl(): ControlAddress {
  return { entity: SONG_ENTITY, param: CONTROL_PARTS.export };
}

/** A track's send level to one return bus: one fader per return. */
export function sendControl(trackId: string, returnId: string): ControlAddress {
  return { entity: trackId, param: `sendLevel.${returnId}` };
}

/** The entity a device chain belongs to: its track, its return, or the master. */
export function chainEntity(target: DeviceChainTarget): string {
  switch (target.chain) {
    case "insert":
      return target.trackId;
    case "return":
      return target.returnId;
    case "master":
      return MASTER_ENTITY;
  }
}

/**
 * One string per address, for a map key or a DOM attribute. `:` never appears
 * in an entity ID or a parameter key, so the key is unambiguous.
 */
export function controlKey(address: ControlAddress): string {
  return `${address.entity}:${address.param}`;
}

export function sameControl(a: ControlAddress, b: ControlAddress): boolean {
  return a.entity === b.entity && a.param === b.param;
}

/** Drops repeats, keeping first-seen order. */
export function uniqueControls(addresses: readonly ControlAddress[]): ControlAddress[] {
  const seen = new Set<string>();
  const unique: ControlAddress[] = [];
  for (const address of addresses) {
    const key = controlKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
  }
  return unique;
}

/**
 * A track's lane on the arrangement, where its clips and placements sit: the
 * parent a deleted clip or placement reveals. The song's arrangement when the
 * track cannot be found, so the address still lands on the timeline.
 */
export function arrangementControl(trackId: string | undefined): ControlAddress {
  return { entity: trackId ?? SONG_ENTITY, param: CONTROL_PARTS.arrangement };
}
