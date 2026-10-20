/**
 * HARD-006 performance regression guard.
 *
 * The audio projection builder is on the per-edit hot path: `useProjectAudio`
 * rebuilds the audio projection on every project change, and the
 * PRD's section 9.3 acceptance requires "frame cost proportional primarily to
 * visible objects, not total project duration or total offscreen clips", and
 * section 10 targets a 50 ms pointer-edit response on the 50-track reference
 * project.
 *
 * Domain edits share structure (`src/commands/projectEdits.ts`: "a note edit
 * on a 50-track project leaves 49 track objects referentially identical"), so
 * an incremental rebuild after a one-entity edit should do fingerprint work
 * for *that* entity only. This test proves it: it counts `fingerprintOf` calls
 * across an incremental rebuild and asserts the count scales with the number
 * of *changed* entities, not the project size. Before the object-identity fast
 * path, every rebuild re-fingerprinted every track, clip, placement, section,
 * automation lane, return, and asset — so a one-note edit on the 50-track
 * reference project ran thousands of stable-stringify+hash passes it did not
 * need. This guard fails if that regresses.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let fingerprintCalls = 0;

vi.mock("./fingerprint", async () => {
  const actual = await vi.importActual<typeof import("./fingerprint")>("./fingerprint");
  return {
    ...actual,
    fingerprintOf: (value: unknown) => {
      fingerprintCalls += 1;
      return actual.fingerprintOf(value);
    },
  };
});

import type { Project, Track } from "../domain/entities";
import { createReferenceProject } from "../domain/fixtures";
import { buildAudioProjection } from "./audioProjection";

beforeEach(() => {
  fingerprintCalls = 0;
});

/**
 * The PRD 9.3 reference arrangement: 50 tracks, ten minutes, 2,500 placements,
 * 100 automation lanes. Built once — the point of these tests is what a rebuild
 * costs, and building it is not what we measure.
 */
function referenceProject(): Project {
  return createReferenceProject();
}

/**
 * Immutable edits with the same structural sharing the command layer produces
 * (`src/commands/projectEdits.ts`): a new object along the changed path, every
 * untouched object reused by reference. Written out by hand here rather than
 * with `solid-js/store`'s `produce`, which mutates a plain object in place and
 * so would not reproduce the identity-sharing the fast path relies on.
 */
function replaceTrack(project: Project, next: Track): Project {
  return {
    ...project,
    metadata: { ...project.metadata, revision: project.metadata.revision + 1 },
    song: {
      ...project.song,
      tracks: project.song.tracks.map((track) => (track.id === next.id ? next : track)),
    },
  };
}

describe("audio projection incremental rebuild", () => {
  it("re-fingerprints nothing when the project object is unchanged", () => {
    const project = referenceProject();
    const before = buildAudioProjection(project);
    fingerprintCalls = 0;

    // Same project object, same entity references throughout.
    const after = buildAudioProjection(project, before);

    expect(fingerprintCalls).toBe(0);
    expect(after.tracks).toEqual(before.tracks);
    // Every entry is reused by reference.
    for (let i = 0; i < after.tracks.length; i += 1) {
      expect(after.tracks[i]).toBe(before.tracks[i]);
    }
  });

  it("re-fingerprints only the one edited track, not the other 49", () => {
    const project = referenceProject();
    const before = buildAudioProjection(project);

    // Edit exactly one track's mixer, immutably — every other track keeps its
    // object reference (structural sharing).
    const target = project.song.tracks[10];
    const edited = replaceTrack(project, {
      ...target,
      mixer: { ...target.mixer, volume: -12 },
    });
    expect(edited.song.tracks[10]).not.toBe(target);
    expect(edited.song.tracks[0]).toBe(project.song.tracks[0]);

    fingerprintCalls = 0;
    const after = buildAudioProjection(edited, before);

    // One track fingerprints two shapes (full + topology). Nothing else does.
    expect(fingerprintCalls).toBe(2);

    // The edited track is a fresh entry; every other track is reused.
    const editedId = edited.song.tracks[10].id;
    expect(after.tracksById.get(editedId)).not.toBe(before.tracksById.get(editedId));
    for (const track of edited.song.tracks) {
      if (track.id === editedId) continue;
      expect(after.tracksById.get(track.id)).toBe(before.tracksById.get(track.id));
    }
  });
});
