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
 *
 * Two halves. The audio half (`buildAudioProjection`) takes a `previous`
 * projection and reuses entries, so it counts fingerprint calls. The live
 * arrangement builder (`src/arrangement/projection.ts`) has no `previous`
 * reuse argument: it rebuilds every time and leans on object-identity
 * `revisionOf` counters for downstream caches. Its guard is therefore a time
 * budget on the 50-track reference project plus revision stability: untouched
 * placements keep their revision after a one-placement edit with structural
 * sharing, and the edited one changes.
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

import type { RowMetrics } from "../arrangement/geometry";
import { buildArrangementProjection } from "../arrangement/projection";
import { revisionOf } from "../arrangement/revision";
import type { Placement, Project, Track } from "../domain/entities";
import { createReferenceProject } from "../domain/fixtures";
import { toTicks } from "../domain/time";
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

const rowMetrics: RowMetrics = { trackHeightPx: 32, headerHeightPx: 32 };

/** Replaces one placement the way the command layer does: new song, new array, one new element. */
function replacePlacement(project: Project, next: Placement): Project {
  return {
    ...project,
    metadata: { ...project.metadata, revision: project.metadata.revision + 1 },
    song: {
      ...project.song,
      placements: project.song.placements.map((p) => (p.id === next.id ? next : p)),
    },
  };
}

describe("arrangement projection on the reference project", () => {
  it("builds inside a generous time budget", () => {
    const project = referenceProject();
    expect(project.song.tracks).toHaveLength(50);
    expect(project.song.placements).toHaveLength(2500);

    // PRD section 10 targets 50 ms for a pointer edit. Wall-clock time on a
    // shared CI runner is noisy, so warm up, take the best of several runs
    // (noise only ever adds time), and assert 10x the target. That still
    // catches an accidental quadratic walk (seconds), not a slow neighbour.
    buildArrangementProjection(project, rowMetrics);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run += 1) {
      const start = performance.now();
      buildArrangementProjection(project, rowMetrics);
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(500);
  });

  it("keeps revisions of untouched placements stable after a one-placement edit", () => {
    const project = referenceProject();
    const before = buildArrangementProjection(project, rowMetrics);

    const target = project.song.placements[1200];
    const edited = replacePlacement(project, {
      ...target,
      startTicks: toTicks(target.startTicks + 192),
    });
    expect(edited.song.placements[0]).toBe(project.song.placements[0]);

    expect(revisionOf(edited.song.placements[1200])).not.toBe(revisionOf(target));
    for (let i = 0; i < project.song.placements.length; i += 1) {
      if (i === 1200) continue;
      expect(revisionOf(edited.song.placements[i])).toBe(
        revisionOf(project.song.placements[i]),
      );
    }
    for (let i = 0; i < project.song.tracks.length; i += 1) {
      expect(revisionOf(edited.song.tracks[i])).toBe(revisionOf(project.song.tracks[i]));
    }

    const after = buildArrangementProjection(edited, rowMetrics);
    expect(after.placementsById.get(target.id)?.revision).not.toBe(
      before.placementsById.get(target.id)?.revision,
    );
    for (const [id, geometry] of before.placementsById) {
      if (id === target.id) continue;
      expect(after.placementsById.get(id)?.revision).toBe(geometry.revision);
    }
  });
});
