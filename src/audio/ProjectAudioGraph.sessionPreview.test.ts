import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setParameter } from "../commands";
import { createReferenceProject } from "../domain/fixtures";
import type { TrackId } from "../domain/ids";
import { TRACK_VOLUME } from "../domain/parameters";
import { EditorSession } from "../editor/composition/EditorSession";
import { createInMemoryProjectRepository } from "../persistence/inMemoryProjectRepository";
import {
  type AudioSongProjection,
  type AudioTrackProjection,
  buildAudioProjection,
} from "../projection/audioProjection";
import { memoryStorage } from "../testing/storage";
import { installWebAudioGlobals } from "./testAudioContext";

installWebAudioGlobals();

let AudioRuntimeModule: typeof import("./AudioRuntime");
let ProjectAudioGraphModule: typeof import("./ProjectAudioGraph");

beforeAll(async () => {
  AudioRuntimeModule = await import("./AudioRuntime");
  ProjectAudioGraphModule = await import("./ProjectAudioGraph");
});

afterEach(async () => {
  try {
    await AudioRuntimeModule.getAudioRuntime().close();
  } catch {
    // already closed
  }
  AudioRuntimeModule.__resetAudioRuntimeForTests();
});

/** Counts every schedule and clear, so a reconcile that reschedules shows. */
function countingTransport() {
  let nextId = 1;
  const counts = { schedule: 0, clear: 0 };
  return {
    counts,
    bpm: { value: 120 },
    schedule: () => {
      counts.schedule += 1;
      return nextId++;
    },
    clear: () => {
      counts.clear += 1;
    },
  };
}

/**
 * UI-005 (#851): a preview flows into the audio graph the way
 * `useProjectAudio` wires any project change — `buildAudioProjection(project,
 * previous)`, then `reconcile` — so entering and leaving a preview must only
 * touch the entities the previewed commands changed.
 */
describe("ProjectAudioGraph under an editor-session preview", () => {
  it("reconciles only the previewed track, on entering and on leaving the preview", async () => {
    const project = createReferenceProject({ trackCount: 4, placementCount: 8 });
    const repository = createInMemoryProjectRepository();
    const created = await repository.createProject(project);
    if (!created.ok) throw new Error("fixture project failed to create");
    const session = new EditorSession({
      repository,
      project,
      deviceStorage: memoryStorage(),
    });

    const runtime = new AudioRuntimeModule.AudioRuntime();
    const transport = countingTransport();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
    });

    // The `useProjectAudio` wiring, driven by the session's own notifications.
    let projection: AudioSongProjection = buildAudioProjection(session.project);
    graph.reconcile(projection);
    session.subscribe((snapshot) => {
      projection = buildAudioProjection(snapshot.project, projection);
      graph.reconcile(projection);
    });

    const graphsBefore = new Map(graph.trackGraphs);
    const reconciled = new Map<TrackId, AudioTrackProjection[]>();
    for (const [trackId, trackGraph] of graph.trackGraphs) {
      vi.spyOn(trackGraph, "reconcile").mockImplementation(function (
        this: unknown,
        next: AudioTrackProjection,
        ...rest: [boolean, boolean?]
      ) {
        reconciled.set(trackId, [...(reconciled.get(trackId) ?? []), next]);
        return (
          Object.getPrototypeOf(trackGraph) as {
            reconcile: (this: unknown, ...args: unknown[]) => void;
          }
        ).reconcile.call(this, next, ...rest);
      });
    }
    const projectionOf = (trackId: TrackId) =>
      projection.tracks.find((track) => track.id === trackId);

    const [previewed, ...untouched] = project.song.tracks;
    const committedProjections = new Map(
      project.song.tracks.map((track) => [track.id, projectionOf(track.id)]),
    );
    const scheduledBefore = { ...transport.counts };

    // Entering: only the previewed track sees a new projection.
    const started = session.beginPreview(
      setParameter(
        { scope: "track", trackId: previewed.id, parameterId: TRACK_VOLUME.id },
        -18,
      ),
    );
    if (!started.ok) throw new Error("expected the preview to open");
    expectOnlyPreviewedChanged();
    const previewedProjection = projectionOf(previewed.id);
    expect(previewedProjection?.mixer.volume).toBe(-18);

    // Leaving: the committed project comes back, and again only the
    // previewed track is reconciled to something new.
    reconciled.clear();
    started.preview.cancel();
    expect(session.project).toBe(project);
    expectOnlyPreviewedChanged();
    expect(projectionOf(previewed.id)?.mixer.volume).toBe(
      committedProjections.get(previewed.id)?.mixer.volume,
    );

    // A mixer-only preview never reschedules the arrangement.
    expect(transport.counts).toEqual(scheduledBefore);

    function expectOnlyPreviewedChanged(): void {
      for (const track of untouched) {
        // Same graph object, and handed the very same projection it already
        // held, so its own reference short-circuit makes it a no-op.
        expect(graph.trackGraphs.get(track.id)).toBe(graphsBefore.get(track.id));
        for (const passed of reconciled.get(track.id) ?? []) {
          expect(passed).toBe(committedProjections.get(track.id));
        }
      }
      expect(graph.trackGraphs.get(previewed.id)).toBe(graphsBefore.get(previewed.id));
      const passed = reconciled.get(previewed.id) ?? [];
      expect(passed.length).toBeGreaterThan(0);
      expect(passed.at(-1)).not.toBe(committedProjections.get(previewed.id));
      expect(passed.at(-1)).toBe(projectionOf(previewed.id));
    }

    session.dispose();
    await graph.dispose();
    await runtime.close();
  });
});
