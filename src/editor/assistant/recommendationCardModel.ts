/**
 * What a recommended pack's card shows and where it tries a sound (GRV-23):
 * the pack and sounds a recommendation names, read back from the library the
 * turn was sent with, and the sample slot **Try on ‹slot›** plays one through.
 * Pure functions of the project, the selection and the library, so the card's
 * words and its slot are testable without rendering it.
 */
import type { ValidRecommendation } from "../../assistant/recommendation";
import {
  CONTROL_PARTS,
  type ControlAddress,
  controlAddress,
} from "../../commands/controlAddress";
import type { RawCommandInput } from "../../commands/types";
import type { Project, Track } from "../../domain/entities";
import type { PadId, TrackId } from "../../domain/ids";
import type { LibraryAsset, LibraryPackSummary } from "../../library/manifest";
import { type LibraryTarget, libraryAim } from "../library/libraryTarget";
import { type PadSelection, selectedPadOf } from "../sequence/padSelection";
import type { AssistantLibraryCatalog } from "./assistantLibrary";

/** A recommendation, as the library holds it. */
export interface ResolvedRecommendation {
  readonly pack: LibraryPackSummary;
  /** Every sound of the pack the library lists, for its cover and its demo. */
  readonly packSounds: readonly LibraryAsset[];
  /** How many sounds the library shows for the pack. */
  readonly soundCount: number;
  /** The sounds it suggests, best first. */
  readonly sounds: readonly LibraryAsset[];
  readonly reason: string;
  readonly trackId: string | null;
  readonly padId: string | null;
}

/**
 * The pack and sounds of a validated recommendation, from the library it was
 * validated against. Null when the library no longer lists them, which only a
 * library that changed in between can cause.
 */
export function resolveRecommendation(
  recommendation: ValidRecommendation,
  catalog: AssistantLibraryCatalog,
): ResolvedRecommendation | null {
  const entry = catalog.packs.find(({ pack }) => pack.id === recommendation.pack.id);
  if (!entry) return null;
  const sounds = recommendation.sounds.map((sound) =>
    entry.sounds.find((asset) => asset.id === sound.id),
  );
  if (sounds.some((sound) => sound === undefined)) return null;
  return {
    pack: entry.pack,
    packSounds: entry.sounds,
    soundCount: entry.soundCount,
    sounds: sounds as LibraryAsset[],
    reason: recommendation.reason,
    trackId: recommendation.trackId,
    padId: recommendation.padId,
  };
}

/**
 * The sample slot a recommendation tries its sound in: a drum pad or a
 * sampler's sample, the slots the library's hot-swap plays a one-shot through.
 */
export interface RecommendationSlot {
  readonly target: Extract<LibraryTarget, { kind: "pad" | "sampler" }>;
  /** What the card calls it: the pad's name, or the sampler's track's. */
  readonly label: string;
  /**
   * What the card's header names it (GRV-129): "track · pad" on a drum
   * machine, the track's name on a sampler.
   */
  readonly heading: string;
  /** The slot as a control, for its outline and for showing it. */
  readonly address: ControlAddress;
  /** Where the audio override plays. */
  readonly preview: { readonly trackId: TrackId; readonly padId?: PadId };
}

/**
 * A recommendation names a track or pad the song does not have (GRV-129):
 * not the selected one in its place, and nothing to try.
 */
export const MISSING_SLOT = "missing";

/** Where a recommendation is aimed: a slot, a named target that is missing, or nowhere. */
export type RecommendationAim = RecommendationSlot | typeof MISSING_SLOT | null;

/**
 * The slot a recommendation for `trackId` and `padId` tries its sounds in,
 * read against `project` as it stands now. A recommendation that names no
 * track is for the selected one, and one that names no pad, on a drum
 * machine, for the pad the track has selected, as the Library would aim. A
 * pad named with no track is on whichever track has it. A named track or pad
 * the song does not have is {@link MISSING_SLOT}, never the selection in its
 * place (GRV-129): a pad a proposal adds is found once it is applied. Null
 * when the track has no slot a one-shot can play through (a synth, a loop
 * track, an empty kit) or there is no track at all.
 */
export function recommendationSlot(
  project: Project,
  trackId: string | null,
  padId: string | null,
  selected: Track | null,
  padSelection: PadSelection,
): RecommendationAim {
  const tracks = project.song.tracks;
  const named = trackId === null ? null : tracks.find((track) => track.id === trackId);
  if (named === undefined) return MISSING_SLOT;
  const track = named ?? (padId === null ? selected : trackWithPad(tracks, padId));
  if (!track) return padId === null ? null : MISSING_SLOT;
  const kit = track.instrument?.kind === "drumMachine" ? track.instrument : null;
  const namedPad = padId === null ? null : kit?.pads.find((pad) => pad.id === padId);
  // A pad named on a kit that has pads but not that one is missing; a pad
  // named on a sampler, or on a kit with none, is ignored as the editor does.
  if (namedPad === undefined && kit && kit.pads.length > 0) return MISSING_SLOT;
  const aim = libraryAim(
    track,
    namedPad?.id ?? selectedPadOf(padSelection, track),
    false,
  );
  if (aim.kind !== "target") return null;
  const { target } = aim;
  if (target.kind === "pad") {
    const pad = kit?.pads.find((entry) => entry.id === target.padId);
    const label = pad?.name ?? track.name;
    return {
      target,
      label,
      heading: `${track.name} · ${label}`,
      address: controlAddress(target.padId, CONTROL_PARTS.sample),
      preview: { trackId: target.trackId, padId: target.padId },
    };
  }
  if (target.kind === "sampler") {
    return {
      target,
      label: track.name,
      heading: track.name,
      address: controlAddress(target.trackId, CONTROL_PARTS.sample),
      preview: { trackId: target.trackId },
    };
  }
  return null;
}

/** The track whose drum machine has pad `padId`, if any. */
function trackWithPad(tracks: readonly Track[], padId: string): Track | null {
  return (
    tracks.find(
      (track) =>
        track.instrument?.kind === "drumMachine" &&
        track.instrument.pads.some((pad) => pad.id === padId),
    ) ?? null
  );
}

/** Whether `slot` is still in the song: its track, and for a pad, the pad. */
export function slotExists(project: Project, slot: RecommendationSlot): boolean {
  const track = project.song.tracks.find((entry) => entry.id === slot.target.trackId);
  if (!track) return false;
  if (slot.target.kind === "sampler") return track.instrument?.kind === "sampler";
  const padId = slot.target.padId;
  return (
    track.instrument?.kind === "drumMachine" &&
    track.instrument.pads.some((pad) => pad.id === padId)
  );
}

/** The sound Try plays: the first suggested one-shot, which a slot can hold. */
export function soundToTry(sounds: readonly LibraryAsset[]): LibraryAsset | null {
  return sounds.find((sound) => sound.type === "one-shot") ?? null;
}

/**
 * Whether an edit changed the slot a sound is being tried in: anything on the
 * pad (its sound, level, pitch, name, mute…), or the sampler's sound and its
 * instrument's parameters. A track's own mixer is not the slot. `touched` is
 * what the edit's commands touch (`controlsTouchedBy`).
 */
export function editTouchesSlot(
  slot: RecommendationSlot,
  touched: readonly ControlAddress[],
  commands: readonly RawCommandInput[],
): boolean {
  const { target } = slot;
  if (target.kind === "pad") {
    return touched.some((address) => address.entity === target.padId);
  }
  const ownPart = touched.some(
    (address) =>
      address.entity === target.trackId &&
      (address.param === CONTROL_PARTS.sample ||
        address.param === CONTROL_PARTS.instrument),
  );
  return ownPart || commands.some((command) => setsInstrumentOf(command, target.trackId));
}

/** Whether a command is a `parameter.set` on `trackId`'s instrument. */
function setsInstrumentOf(command: RawCommandInput, trackId: string): boolean {
  if (command.type !== "parameter.set") return false;
  const payload = command.payload as { target?: { scope?: unknown; trackId?: unknown } };
  return payload.target?.scope === "instrument" && payload.target.trackId === trackId;
}
