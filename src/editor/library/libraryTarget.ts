import type { Asset, Project, Track } from "../../domain/entities";
import type { PadId, TrackId } from "../../domain/ids";
import type { LibraryAssetType } from "../../library/manifest";

/**
 * What the Library view inserts into (`UI-002`): one sample slot, or a new
 * track when the arrangement asks for a loop.
 *
 * A slot is the sampler's sample, a drum pad's sample or a loop track's loop,
 * and it always belongs to the selected track: a track has one instrument, so
 * it has one slot, except a drum machine, whose slot is its selected pad's.
 * That is why the target needs no state of its own beyond the arrangement's
 * "new track": the last slot touched *is* the selected track's, because
 * touching a slot selects its track and, for a pad, its pad. The one other
 * aim is the Sequence view's [+ Pad] (#947): a pad the drum machine does not
 * have yet, which inserting adds.
 */
export type LibraryTarget =
  | { readonly kind: "new-track" }
  | { readonly kind: "sampler"; readonly trackId: TrackId }
  | { readonly kind: "pad"; readonly trackId: TrackId; readonly padId: PadId }
  | { readonly kind: "new-pad"; readonly trackId: TrackId }
  | { readonly kind: "loop"; readonly trackId: TrackId };

/** Where the Library is aimed: a target, or why there is none to aim at. */
export type LibraryAim =
  | { readonly kind: "target"; readonly target: LibraryTarget }
  | { readonly kind: "synth" }
  | { readonly kind: "no-slot" }
  | { readonly kind: "no-track" };

/**
 * The aim for the selected track. A synth plays no samples, a track with no
 * instrument or a kit with no pads has no slot, and an empty song has no
 * track: the Library says which, rather than refusing its key.
 */
export function libraryAim(
  track: Track | null,
  selectedPadId: PadId | null,
  newTrack: boolean,
  newPad = false,
): LibraryAim {
  if (newTrack) return { kind: "target", target: { kind: "new-track" } };
  if (!track) return { kind: "no-track" };
  if (newPad && track.instrument?.kind === "drumMachine") {
    return { kind: "target", target: { kind: "new-pad", trackId: track.id } };
  }
  if (track.type === "audio") {
    return { kind: "target", target: { kind: "loop", trackId: track.id } };
  }
  const instrument = track.instrument;
  if (instrument?.kind === "sampler") {
    return { kind: "target", target: { kind: "sampler", trackId: track.id } };
  }
  if (instrument?.kind === "drumMachine" && selectedPadId) {
    return {
      kind: "target",
      target: { kind: "pad", trackId: track.id, padId: selectedPadId },
    };
  }
  return instrument?.kind === "synth" ? { kind: "synth" } : { kind: "no-slot" };
}

/** What a target accepts: loops for a loop or a new track, one-shots otherwise. */
export function targetAssetTypes(target: LibraryTarget): readonly LibraryAssetType[] {
  return target.kind === "loop" || target.kind === "new-track" ? ["loop"] : ["one-shot"];
}

/** The sound a target's slot holds now, or null when it is empty or new. */
export function targetSound(project: Project, target: LibraryTarget): Asset | null {
  const asset = (id: string | null | undefined) =>
    project.song.assets.find((entry) => entry.id === id) ?? null;
  if (target.kind === "new-track" || target.kind === "new-pad") return null;
  if (target.kind === "loop") {
    const clip = project.clips.find(
      (entry) => entry.trackId === target.trackId && entry.content.kind === "audioLoop",
    );
    return asset(clip?.content.kind === "audioLoop" ? clip.content.assetId : null);
  }
  const instrument = project.song.tracks.find(
    (entry) => entry.id === target.trackId,
  )?.instrument;
  if (target.kind === "sampler") {
    return asset(instrument?.kind === "sampler" ? instrument.assetId : null);
  }
  const pad =
    instrument?.kind === "drumMachine"
      ? instrument.pads.find((entry) => entry.id === target.padId)
      : undefined;
  return asset(pad?.assetId);
}

/**
 * The target as a path, for the Library's header: the track, its instrument
 * and the slot, "BD › Drum machine › BD". The names are the user's own.
 */
export function targetPath(project: Project, target: LibraryTarget): string {
  if (target.kind === "new-track") return "a new track";
  const track = project.song.tracks.find((entry) => entry.id === target.trackId);
  const name = track?.name ?? "Track";
  if (target.kind === "loop") return `${name} › Loop`;
  if (target.kind === "sampler") return `${name} › Sampler › Sample`;
  if (target.kind === "new-pad") return `${name} › Drum machine › New pad`;
  const pads = track?.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
  const pad = pads.find((entry) => entry.id === target.padId);
  return `${name} › Drum machine › ${pad?.name ?? "Pad"}`;
}

/** Whether two targets are the same slot. */
export function sameTarget(a: LibraryTarget | null, b: LibraryTarget | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "new-track") return true;
  const other = b as typeof a;
  return (
    a.trackId === other.trackId &&
    (a.kind !== "pad" || a.padId === (other as typeof a).padId)
  );
}
