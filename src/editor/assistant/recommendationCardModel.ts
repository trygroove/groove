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
import type { Project, Track } from "../../domain/entities";
import type { PadId, TrackId } from "../../domain/ids";
import type { LibraryAsset, LibraryPackSummary } from "../../library/manifest";
import { type LibraryTarget, libraryAim } from "../libraryTarget";
import { type PadSelection, selectedPadOf } from "../padSelection";
import type { AssistantLibraryCatalog } from "./assistantLibrary";

/** A recommendation, as the library holds it. */
export interface ResolvedRecommendation {
  readonly pack: LibraryPackSummary;
  /** Every sound of the pack the library lists, for its cover and its demo. */
  readonly packSounds: readonly LibraryAsset[];
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
  /** The slot as a control, for its outline and for showing it. */
  readonly address: ControlAddress;
  /** Where the audio override plays. */
  readonly preview: { readonly trackId: TrackId; readonly padId?: PadId };
}

/**
 * The slot a recommendation for `trackId` tries its sounds in: that track's,
 * or the selected track's when it names none or one the song does not have.
 * On a drum machine it is the pad the recommendation names, so a kick goes on
 * the kick's pad whichever pad is selected; when it names none, or one the kit
 * does not have, it is the selected pad, as the Library would aim. Null when
 * that track has no slot a one-shot can play through (a synth, a loop track,
 * an empty kit) or there is no track at all.
 */
export function recommendationSlot(
  project: Project,
  trackId: string | null,
  padId: string | null,
  selected: Track | null,
  padSelection: PadSelection,
): RecommendationSlot | null {
  const named = project.song.tracks.find((track) => track.id === trackId);
  const track = named ?? selected;
  if (!track) return null;
  const namedPad =
    track.instrument?.kind === "drumMachine"
      ? track.instrument.pads.find((pad) => pad.id === padId)
      : undefined;
  const aim = libraryAim(
    track,
    namedPad?.id ?? selectedPadOf(padSelection, track),
    false,
  );
  if (aim.kind !== "target") return null;
  const { target } = aim;
  if (target.kind === "pad") {
    const pads = track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
    const pad = pads.find((entry) => entry.id === target.padId);
    return {
      target,
      label: pad?.name ?? track.name,
      address: controlAddress(target.padId, CONTROL_PARTS.sample),
      preview: { trackId: target.trackId, padId: target.padId },
    };
  }
  if (target.kind === "sampler") {
    return {
      target,
      label: track.name,
      address: controlAddress(target.trackId, CONTROL_PARTS.sample),
      preview: { trackId: target.trackId },
    };
  }
  return null;
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
