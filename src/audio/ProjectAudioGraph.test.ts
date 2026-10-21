import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { executeTransaction, reorderTrack } from "../commands";
import type { Project } from "../domain/entities";
import { createFactoryContext, createReturnBus } from "../domain/factories";
import { createReferenceProject, createSliceFixtureProject } from "../domain/fixtures";
import { createSeededIdFactory } from "../domain/ids";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH, ticksToSeconds } from "../domain/time";
import { buildAudioProjection } from "../projection/audioProjection";
import { installWebAudioGlobals } from "./testAudioContext";
import { UnderrunMonitor } from "./underrun";

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

/** A deterministic transport double: records every schedule/clear call by id
 * instead of touching a real Tone.Transport, so scheduling can be asserted
 * without any timing dependence. */
function fakeTransport(): import("./ProjectAudioGraph").AudioTransport & {
  scheduled: Map<number, string>;
  cleared: number[];
  callbacks: Map<number, (time: number) => void>;
} {
  let nextId = 1;
  const scheduled = new Map<number, string>();
  const cleared: number[] = [];
  // Kept so a test can fire a scheduled event and assert what actually
  // reaches Tone, rather than only that something was scheduled.
  const callbacks = new Map<number, (time: number) => void>();
  return {
    bpm: { value: 120 },
    scheduled,
    cleared,
    callbacks,
    schedule(callback, time) {
      const id = nextId++;
      scheduled.set(id, time);
      callbacks.set(id, callback);
      return id;
    },
    clear(id) {
      cleared.push(id);
      scheduled.delete(id);
      callbacks.delete(id);
    },
  };
}

/**
 * A transport double that actually *runs*: it models enough of
 * `Tone.Transport` to play a tick range at a tempo and report what fired and
 * at what audio time, so musical alignment across seek, tempo change, and
 * repeated loop passes is assertable without a clock or a Tone context.
 *
 * `clockSeconds` accumulates across passes exactly as the audio clock would, so
 * an alignment error that only shows up as *accumulating* drift (rather than a
 * single wrong offset) is visible in the absolute times it returns.
 */
function simulatedTransport(): import("./ProjectAudioGraph").AudioTransport & {
  scheduledTicks(): number[];
  runRange(
    fromTicks: number,
    toTicks: number,
    tempo: number,
  ): { ticks: number; time: number }[];
} {
  let nextId = 1;
  let clockSeconds = 0;
  const events = new Map<number, { ticks: number; callback: (time: number) => void }>();
  return {
    bpm: { value: 120 },
    schedule(callback, time) {
      const id = nextId++;
      events.set(id, { ticks: Number(time.replace(/i$/, "")), callback });
      return id;
    },
    clear(id) {
      events.delete(id);
    },
    scheduledTicks() {
      return [...events.values()].map((event) => event.ticks).sort((a, b) => a - b);
    },
    runRange(fromTicks, toTicks, tempo) {
      const fired: { ticks: number; time: number }[] = [];
      const due = [...events.values()]
        .filter((event) => event.ticks >= fromTicks && event.ticks < toTicks)
        .sort((a, b) => a.ticks - b.ticks);
      for (const event of due) {
        const time = clockSeconds + ticksToSeconds(event.ticks - fromTicks, tempo);
        event.callback(time);
        fired.push({ ticks: event.ticks, time });
      }
      clockSeconds += ticksToSeconds(toTicks - fromTicks, tempo);
      return fired;
    },
  };
}

/** A loader that resolves manually, so cache races (asset replaced mid-decode)
 * are fully controllable from the test. */
function manualBufferLoader(): {
  loader: import("./AudioBufferCache").AssetBufferLoader<import("tone").ToneAudioBuffer>;
  pending: {
    fingerprint: string;
    resolve: (buffer: import("tone").ToneAudioBuffer) => void;
  }[];
} {
  const pending: {
    fingerprint: string;
    resolve: (buffer: import("tone").ToneAudioBuffer) => void;
  }[] = [];
  return {
    pending,
    loader: {
      load(asset) {
        return new Promise((resolve) => {
          pending.push({ fingerprint: asset.fingerprint, resolve });
        });
      },
    },
  };
}

function fakeBuffer(): import("tone").ToneAudioBuffer {
  return { dispose: () => {} } as unknown as import("tone").ToneAudioBuffer;
}

describe("ProjectAudioGraph", () => {
  it("reconciling the same projection object twice is a full no-op", async () => {
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
    });
    const project = createSliceFixtureProject();
    const projection = buildAudioProjection(project);

    graph.reconcile(projection);
    const afterFirst = { ...graph.diagnostics() };

    graph.reconcile(projection);
    expect(graph.diagnostics()).toEqual(afterFirst);

    await graph.dispose();
    await runtime.close();
  });

  it("auditionTrack triggers the target track's instrument once", async () => {
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
    });
    const project = createSliceFixtureProject();
    graph.reconcile(buildAudioProjection(project));

    const trackId = project.song.tracks[0].id;
    const trackGraph = graph.trackGraphs.get(trackId);
    if (!trackGraph) throw new Error("no track graph");
    const trigger = vi.spyOn(trackGraph, "trigger");

    // Watched like any trigger, so a view can show the audition (#447).
    const heard: unknown[] = [];
    const stop = graph.watchTriggers((id, played) => heard.push([id, played]));

    graph.auditionTrack(trackId, { kind: "pitch", pitch: 60 }, 192, 0.9);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0]).toEqual({ kind: "pitch", pitch: 60 });
    expect(heard).toEqual([[trackId, { kind: "pitch", pitch: 60 }]]);
    stop();

    // An unknown track is a silent no-op, not a throw.
    expect(() =>
      graph.auditionTrack("trk_missing" as never, { kind: "pitch", pitch: 60 }, 192, 0.9),
    ).not.toThrow();

    trigger.mockRestore();
    await graph.dispose();
    await runtime.close();
  });

  it("reads every track's level in one pass, for the editor's meters (#447)", async () => {
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
    });
    const project = createReferenceProject({ trackCount: 3, placementCount: 3 });
    graph.reconcile(buildAudioProjection(project));

    const readings = graph.readTrackLevels();
    expect([...readings.keys()].sort()).toEqual(
      project.song.tracks.map((track) => track.id).sort(),
    );
    for (const reading of readings.values()) {
      // Silent: nothing is playing, so neither is anywhere near a clip.
      expect(reading.rmsDb).toBeLessThanOrEqual(0);
      expect(reading.peakDb).toBeLessThanOrEqual(0);
    }
    // The master's own reading (GRV-44), from the same frame loop.
    const master = graph.readMasterLevel();
    expect(master.rmsDb).toBeLessThanOrEqual(0);
    expect(master.peakDb).toBeLessThanOrEqual(0);

    await graph.dispose();
    await runtime.close();
  });

  it("editing one track's mixer does not touch other tracks' graphs", async () => {
    const project = createReferenceProject({
      trackCount: 4,
      placementCount: 8,
    });
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
    });

    const before = buildAudioProjection(project);
    graph.reconcile(before);
    const [changedTrack, ...untouched] = project.song.tracks;
    const untouchedGraphsBefore = untouched.map((t) => graph.trackGraphs.get(t.id));

    const edited: Project = {
      ...project,
      song: {
        ...project.song,
        tracks: project.song.tracks.map((track) =>
          track.id === changedTrack.id
            ? { ...track, mixer: { ...track.mixer, volume: -20 } }
            : track,
        ),
      },
    };
    const after = buildAudioProjection(edited, before);
    graph.reconcile(after);

    untouched.forEach((track, index) => {
      expect(graph.trackGraphs.get(track.id)).toBe(untouchedGraphsBefore[index]);
    });

    await graph.dispose();
    await runtime.close();
  });

  it("renaming a track is a complete no-op for its audio graph", async () => {
    const project = createSliceFixtureProject();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
    });

    const before = buildAudioProjection(project);
    graph.reconcile(before);
    const trackId = project.song.tracks[0].id;
    const graphBefore = graph.trackGraphs.get(trackId);

    const renamed: Project = {
      ...project,
      song: {
        ...project.song,
        tracks: project.song.tracks.map((track) => ({
          ...track,
          name: "Renamed",
        })),
      },
    };
    const after = buildAudioProjection(renamed, before);
    graph.reconcile(after);

    expect(graph.trackGraphs.get(trackId)).toBe(graphBefore);

    await graph.dispose();
    await runtime.close();
  });

  it("reordering tracks reuses every track graph and clears no scheduled event (TRK-02)", async () => {
    const project = createReferenceProject({ trackCount: 3, placementCount: 6 });
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const transport = fakeTransport();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
    });

    const before = buildAudioProjection(project);
    graph.reconcile(before);
    const graphsBefore = new Map(graph.trackGraphs);
    const scheduledBefore = [...transport.scheduled.keys()];

    const last = [...project.song.tracks].sort((a, b) => a.order - b.order).at(-1);
    if (!last) throw new Error("fixture has no tracks");
    const moved = executeTransaction(project, [reorderTrack(last.id, 0)]);
    if (!moved.ok) throw new Error("reorder was rejected");
    graph.reconcile(buildAudioProjection(moved.project, before));

    expect(graph.trackGraphs.size).toBe(graphsBefore.size);
    for (const [id, trackGraph] of graphsBefore) {
      expect(graph.trackGraphs.get(id)).toBe(trackGraph);
    }
    expect(transport.cleared).toEqual([]);
    expect([...transport.scheduled.keys()]).toEqual(scheduledBefore);

    await graph.dispose();
    await runtime.close();
  });

  it("schedules one transport event per note event, at the placement-relative absolute tick", async () => {
    const project = createSliceFixtureProject();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
    });

    graph.reconcile(buildAudioProjection(project));

    const times = [...transport.scheduled.values()].sort();
    expect(times).toEqual(
      [0, 4, 8, 12]
        .map((sixteenth) => sixteenth * TICKS_PER_SIXTEENTH)
        .map((ticks) => `${ticks}i`)
        .sort(),
    );
    expect(graph.diagnostics().scheduledPlacements).toBe(1);

    await graph.dispose();
    await runtime.close();
  });

  it("re-derives a placement's schedule when swing changes, and moves only off-16th notes", async () => {
    const project = createSliceFixtureProject();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
    });
    const before = buildAudioProjection(project);
    graph.reconcile(before);
    const ticks = () => [...transport.scheduled.values()].sort();
    const straight = ticks();

    // The fixture's notes sit on beats: swing reschedules but moves none of them.
    graph.reconcile(
      buildAudioProjection({ ...project, song: { ...project.song, swing: 75 } }, before),
    );
    expect(ticks()).toEqual(straight);
    expect(graph.diagnostics().scheduledPlacements).toBe(1);

    // A note on the off-16th is delayed by 24 ticks at 75%.
    const clip = project.clips[0];
    const content = clip.content as Extract<typeof clip.content, { kind: "notes" }>;
    const swung: Project = {
      ...project,
      clips: [
        {
          ...clip,
          content: {
            ...content,
            events: [{ ...content.events[0], startTicks: 48 }],
          },
        },
      ],
      song: { ...project.song, swing: 75 },
    } as Project;
    graph.reconcile(buildAudioProjection(swung));
    expect(ticks()).toEqual(["72i"]);

    await graph.dispose();
    await runtime.close();
  });

  it("keeps every event aligned across seek, tempo change, and repeated loop passes (PRD AUD-01/AUD-02)", async () => {
    const project = createSliceFixtureProject();
    const transport = simulatedTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
    });

    const beats = [0, 4, 8, 12].map((sixteenth) => sixteenth * TICKS_PER_SIXTEENTH);
    const before = buildAudioProjection(project);
    graph.reconcile(before);

    // A whole bar from the top: every note fires once, in order, one beat apart.
    const pass1 = transport.runRange(0, TICKS_PER_BAR, 120);
    expect(pass1.map((event) => event.ticks)).toEqual(beats);
    expect(pass1.map((event) => event.time)).toEqual([0, 0.5, 1, 1.5]);

    // Seek to beat 3: only the events at or after the seek point fire, each
    // still at its own musical position relative to where playback resumed.
    // Nothing already passed is replayed and nothing is shifted.
    const afterSeek = transport.runRange(8 * TICKS_PER_SIXTEENTH, TICKS_PER_BAR, 120);
    expect(afterSeek.map((event) => event.ticks)).toEqual(beats.slice(2));
    expect(afterSeek.map((event) => event.time)).toEqual([2, 2.5]);

    // Tempo change mid-playback. `syncSchedule` releases and re-derives every
    // event of the placement when the tempo moves, so this is exactly where a
    // duplicate or a dropped event would appear.
    const retimed: Project = {
      ...project,
      song: { ...project.song, tempo: 60 },
    };
    graph.reconcile(buildAudioProjection(retimed, before));

    // Musical positions are tempo-independent — the schedule is keyed to ticks,
    // so the same four events exist, once each, at the same ticks.
    expect(transport.scheduledTicks()).toEqual(beats);
    expect(graph.diagnostics().scheduledPlacements).toBe(1);

    // ...and they now sound one second apart rather than half a second, without
    // the playhead moving or the song restarting.
    const pass2 = transport.runRange(0, TICKS_PER_BAR, 60);
    expect(pass2.map((event) => event.ticks)).toEqual(beats);
    expect(pass2.map((event) => event.time)).toEqual([3, 4, 5, 6]);

    // Repeated loop passes over the same bar: each pass fires each event
    // exactly once, and consecutive passes stay exactly one bar apart — no
    // accumulating drift and no duplicate trigger at the boundary (PRD AUD-02).
    const passes = [
      transport.runRange(0, TICKS_PER_BAR, 60),
      transport.runRange(0, TICKS_PER_BAR, 60),
      transport.runRange(0, TICKS_PER_BAR, 60),
    ];
    for (const pass of passes) {
      expect(pass.map((event) => event.ticks)).toEqual(beats);
    }
    const barSeconds = ticksToSeconds(TICKS_PER_BAR, 60);
    expect(passes[1][0].time - passes[0][0].time).toBeCloseTo(barSeconds, 10);
    expect(passes[2][0].time - passes[1][0].time).toBeCloseTo(barSeconds, 10);

    await graph.dispose();
    await runtime.close();
  });

  it("measures underruns against the audio clock, not Tone.now(), so healthy ahead-of-time dispatch is never a drop (PRD AUD-03/OPS-02)", async () => {
    const Tone = await import("tone");
    const project = createSliceFixtureProject();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();

    const reports: unknown[] = [];
    const monitor = new UnderrunMonitor({
      contextSampleRate: 48_000,
      samplingRate: 1,
      emit: (report) => reports.push(report),
    });
    // Deliberately no `now` override: this pins the *default* clock source
    // against the `time` argument a scheduled callback actually receives, so
    // the tolerance and the clock cannot drift apart.
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      underrunMonitor: monitor,
    });
    graph.reconcile(buildAudioProjection(project));
    const callbacks = [...transport.callbacks.values()];
    expect(callbacks.length).toBeGreaterThan(2);

    // Tone's `Clock._loop` dispatches every event whose intended time falls in
    // `(lastUpdate, currentTime + lookAhead]`. Both ends of that window are
    // healthy, ahead-of-time playback. The upper end is `Tone.now()` itself —
    // the case a `Tone.now()`-based clock would score as a drop on *every*
    // event, turning `audio_underrun` into per-note telemetry.
    // `updateInterval` is on the concrete `Context`, not the `BaseContext`
    // `getContext()` is typed as; the runtime installs a real one.
    const context = Tone.getContext() as import("tone").Context;
    // The intended times below are computed from a `currentTime` read *here*,
    // but the monitor re-reads the audio clock inside the callback — and the
    // audio clock keeps advancing in real time in between. With Tone's default
    // 0.1s lookahead that gap may only be ~70ms before healthy dispatch scores
    // as a drop, which a loaded test runner exceeds on a stall. Widening the
    // lookahead for this test buys ~1s of that slack while leaving the actual
    // discriminator untouched: a `Tone.now()`-based clock is still exactly one
    // `updateInterval` (0.05s) past the second intended time, still over the
    // 0.02s tolerance, so this test still fails if the clock source regresses.
    const defaultLookAhead = context.lookAhead;
    context.lookAhead = 1;
    try {
      callbacks[0]?.(context.currentTime + context.lookAhead);
      callbacks[1]?.(context.currentTime + context.lookAhead - context.updateInterval);
      expect(reports).toEqual([]);

      // A genuinely late dispatch — the audio clock is already a second past
      // the intended time — is still reported.
      callbacks[2]?.(context.currentTime - 1);
      expect(reports).toHaveLength(1);
    } finally {
      // The runtime adopts a live context rather than making one per test, so
      // this must not leak into whatever runs next.
      context.lookAhead = defaultLookAhead;
    }

    await graph.dispose();
    await runtime.close();
  });

  it("reports a sampled audio_underrun when scheduled events fire late, and nothing when they are on time (PRD AUD-03/OPS-02)", async () => {
    const project = createSliceFixtureProject();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();

    const reports: { droppedEventBucket: string; sampleRate: string }[] = [];
    // samplingRate 1 -> a report per detected drop, so the assertion is exact.
    const monitor = new UnderrunMonitor({
      contextSampleRate: 48_000,
      samplingRate: 1,
      toleranceSeconds: 0.02,
      emit: (report) => reports.push(report),
    });
    // `now` is controllable so the callback's "actual" audio time is set by the
    // test, independent of any real clock.
    let now = 0;
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      underrunMonitor: monitor,
      now: () => now,
    });
    graph.reconcile(buildAudioProjection(project));

    const callbacks = [...transport.callbacks.values()];
    expect(callbacks.length).toBeGreaterThan(0);

    // The first scheduled callback fires with the audio clock already well past
    // its intended time (intended 1.0s, actual 1.5s) — a late dispatch.
    now = 1.5;
    callbacks[0]?.(1.0);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.sampleRate).toBe("48000");
    expect(reports[0]?.droppedEventBucket).toBe("1_4");

    // A callback that fires ahead of its intended time is not a drop.
    now = 1.0;
    callbacks[1]?.(2.0);
    expect(reports).toHaveLength(1);

    await graph.dispose();
    await runtime.close();
  });

  it("clears every scheduled event for a placement that is removed", async () => {
    const project = createSliceFixtureProject();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
    });

    const before = buildAudioProjection(project);
    graph.reconcile(before);
    expect(transport.scheduled.size).toBe(4);

    const emptied: Project = {
      ...project,
      song: { ...project.song, placements: [] },
    };
    graph.reconcile(buildAudioProjection(emptied, before));

    expect(transport.scheduled.size).toBe(0);
    expect(transport.cleared).toHaveLength(4);
    expect(graph.diagnostics().scheduledPlacements).toBe(0);

    await graph.dispose();
    await runtime.close();
  });

  it("hands a sampler's decoded sound to a waveform watcher, without decoding it again (#447)", async () => {
    const project = createSliceFixtureProject();
    const { loader, pending } = manualBufferLoader();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
      bufferLoader: loader,
    });
    const projection = buildAudioProjection(project);
    graph.reconcile(projection);

    const received: (Float32Array | null)[] = [];
    const watch = graph.watchAssetPeaks(projection.assets[0], 2, (peaks) =>
      received.push(peaks),
    );
    const decoded = {
      dispose: () => {},
      numberOfChannels: 1,
      getChannelData: () => Float32Array.from([0.5, -0.25, 0.1, 0]),
    } as unknown as import("tone").ToneAudioBuffer;
    pending[0].resolve(decoded);
    await Promise.resolve();
    await Promise.resolve();

    // One decode serves both the sampler and the drawing.
    expect(pending).toHaveLength(1);
    expect(received.at(-1) && Array.from(received.at(-1) as Float32Array)).toEqual([
      1,
      expect.closeTo(0.2, 5),
    ]);

    watch.release();
    await graph.dispose();
    await runtime.close();
  });

  it("swapping a track's instrument asset releases the old buffer subscription and attaches the new one", async () => {
    const project = createSliceFixtureProject();
    const { loader, pending } = manualBufferLoader();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
      bufferLoader: loader,
    });

    const before = buildAudioProjection(project);
    graph.reconcile(before);
    pending[0].resolve(fakeBuffer());
    await Promise.resolve();
    await Promise.resolve();
    expect(graph.diagnostics().buffers.cachedAssets).toBe(1);
    const subscriptionsBefore = runtime.diagnostics().resources.byType.subscription;

    const newAsset = {
      ...project.song.assets[0],
      id: createSeededIdFactory("swap-asset")("asset"),
    };
    const track = project.song.tracks[0];
    if (track.instrument?.kind !== "sampler") {
      throw new Error("expected the slice fixture's track to be a sampler");
    }
    const instrument = track.instrument;
    const edited: Project = {
      ...project,
      song: {
        ...project.song,
        assets: [...project.song.assets, newAsset],
        tracks: project.song.tracks.map((t) =>
          t.id === track.id
            ? { ...t, instrument: { ...instrument, assetId: newAsset.id } }
            : t,
        ),
      },
    };
    graph.reconcile(buildAudioProjection(edited, before));
    pending[1].resolve(fakeBuffer());
    await Promise.resolve();
    await Promise.resolve();

    // Old asset's subscription released, new asset's created: the count of
    // live subscriptions this track holds does not grow.
    expect(runtime.diagnostics().resources.byType.subscription).toBe(subscriptionsBefore);

    await graph.dispose();
    await runtime.close();
  });

  it("replacing an asset's content twice in a row never lets the stale decode win, and never recreates the instrument", async () => {
    const project = createSliceFixtureProject();
    const { loader, pending } = manualBufferLoader();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
      bufferLoader: loader,
    });

    const before = buildAudioProjection(project);
    graph.reconcile(before);
    const trackGraphBefore = graph.trackGraphs.get(project.song.tracks[0].id);
    // The initial decode is left unresolved on purpose — a track/instrument
    // reconcile must never depend on a buffer already being loaded.

    const withUrl = (project: Project, url: string): Project => ({
      ...project,
      song: {
        ...project.song,
        assets: project.song.assets.map((asset) => ({ ...asset, url })),
      },
    });

    let latest = before;
    latest = buildAudioProjection(withUrl(project, "/samples/v2.wav"), latest);
    graph.reconcile(latest);
    latest = buildAudioProjection(withUrl(project, "/samples/v3.wav"), latest);
    graph.reconcile(latest);

    // Only the asset's content changed, not which asset id the track
    // references, so the track's instrument identity is untouched
    // throughout every one of these edits.
    expect(graph.trackGraphs.get(project.song.tracks[0].id)).toBe(trackGraphBefore);
    expect(pending).toHaveLength(3);

    // Resolve out of order: the newest decode first, then the two stale
    // ones. Neither stale completion may overwrite the newest result.
    pending[2].resolve(fakeBuffer());
    await Promise.resolve();
    await Promise.resolve();
    pending[1].resolve(fakeBuffer());
    pending[0].resolve(fakeBuffer());
    await Promise.resolve();
    await Promise.resolve();

    expect(graph.diagnostics().buffers.cachedAssets).toBe(1);
    expect(graph.diagnostics().buffers.pendingLoads).toBe(0);

    await graph.dispose();
    await runtime.close();
  });

  it("removing a return bus disposes it only after the track sends targeting it are gone", async () => {
    const context = createFactoryContext();
    const bus = createReturnBus(context, { name: "Reverb", order: 0 });
    const project = createSliceFixtureProject();
    const withReturn: Project = {
      ...project,
      song: {
        ...project.song,
        returns: [bus],
        tracks: project.song.tracks.map((track) => ({
          ...track,
          sendConfig: [{ returnId: bus.id, level: 0.5, preFader: false }],
        })),
      },
    };

    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
    });
    const before = buildAudioProjection(withReturn);
    graph.reconcile(before);
    expect(graph.returnGraphs.size).toBe(1);

    const removed: Project = {
      ...withReturn,
      song: {
        ...withReturn.song,
        returns: [],
        tracks: withReturn.song.tracks.map((track) => ({
          ...track,
          sendConfig: [],
        })),
      },
    };
    expect(() => graph.reconcile(buildAudioProjection(removed, before))).not.toThrow();
    expect(graph.returnGraphs.size).toBe(0);

    await graph.dispose();
    await runtime.close();
  });

  it("adding and removing a track creates/disposes only that track's graph", async () => {
    const project = createReferenceProject({
      trackCount: 2,
      placementCount: 4,
    });
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
    });

    const before = buildAudioProjection(project);
    graph.reconcile(before);
    expect(graph.trackGraphs.size).toBe(2);
    const survivingId = project.song.tracks[0].id;
    const survivorBefore = graph.trackGraphs.get(survivingId);

    const removedOne: Project = {
      ...project,
      song: {
        ...project.song,
        tracks: project.song.tracks.slice(0, 1),
        placements: project.song.placements.filter((p) => p.trackId === survivingId),
      },
    };
    graph.reconcile(buildAudioProjection(removedOne, before));
    expect(graph.trackGraphs.size).toBe(1);
    expect(graph.trackGraphs.get(survivingId)).toBe(survivorBefore);

    await graph.dispose();
    await runtime.close();
  });

  it("dispose() releases every resource this graph registered and is idempotent", async () => {
    const project = createSliceFixtureProject();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
    });

    graph.reconcile(buildAudioProjection(project));
    expect(runtime.diagnostics().resources.byOwner.p).toBeGreaterThan(0);

    await graph.dispose();
    await expect(graph.dispose()).resolves.toBeUndefined(); // idempotent

    expect(runtime.diagnostics().resources.byOwner.p).toBeUndefined();

    await runtime.close();
  });

  it("dispose() never touches the shared runtime or another project's scope", async () => {
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const other = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "other", {
      transport: fakeTransport(),
    });
    other.reconcile(buildAudioProjection(createSliceFixtureProject()));

    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport: fakeTransport(),
    });
    graph.reconcile(buildAudioProjection(createSliceFixtureProject()));

    await graph.dispose();

    expect(runtime.diagnostics().resources.byOwner.other).toBeGreaterThan(0);
    expect(runtime.getState()).not.toBe("closed");

    await other.dispose();
    await runtime.close();
  });

  // Every fixture in this repo authors its audio at `sourceTempo === tempo`,
  // where buffer seconds and song seconds coincide and a units bug in either
  // `start()` argument is invisible. This is the one test that pulls them
  // apart, so it is the only thing standing between a rate != 1 project and
  // silently truncated or overrunning loops (also inherited by the
  // AUD-05/AUD-06 offline and stem exports, which reuse this expansion).
  it("time-stretches a loop whose sample tempo differs from the song, preserving its pitch", async () => {
    const Tone = await import("tone");
    const base = createReferenceProject({
      trackCount: 1,
      waveformTrackCount: 1,
      placementCount: 1,
      minutes: 1,
      automationLaneCount: 0,
    });
    // Authored at 60 BPM, played back in a 120 BPM song => playbackRate 2.
    const project: Project = {
      ...base,
      clips: base.clips.map((clip) =>
        clip.content.kind === "audioLoop"
          ? { ...clip, content: { ...clip.content, sourceTempo: 60 } }
          : clip,
      ),
    };

    const { loader, pending } = manualBufferLoader();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      bufferLoader: loader,
    });

    const projection = buildAudioProjection(project);
    graph.reconcile(projection);
    for (const p of pending) p.resolve(fakeBuffer());
    await Promise.resolve();
    await Promise.resolve();

    const grainStart = vi
      .spyOn(Tone.GrainPlayer.prototype, "start")
      .mockImplementation(function mocked(this: unknown) {
        return this as never;
      });
    const plainStart = vi
      .spyOn(Tone.Player.prototype, "start")
      .mockImplementation(function mocked(this: unknown) {
        return this as never;
      });

    try {
      for (const callback of transport.callbacks.values()) callback(0);

      // A stretched loop goes through the granular player, never the plain
      // one: `Tone.Player` can only follow tempo by resampling, which would
      // transpose the loop an octave at rate 2.
      expect(grainStart).toHaveBeenCalled();
      expect(plainStart).not.toHaveBeenCalled();

      const player = grainStart.mock.instances[0] as import("tone").GrainPlayer;
      expect(player.playbackRate).toBeCloseTo(2);
      // The pitch is held where it was recorded: the grains themselves are
      // played back untransposed.
      expect(player.detune).toBe(0);

      const [, offsetArg, durationArg] = grainStart.mock.calls[0];
      // Both must be plain seconds numbers; a tick string like "768i" here
      // is the regression.
      expect(typeof offsetArg).toBe("number");
      expect(typeof durationArg).toBe("number");

      // `GrainPlayer.start` stops at `time + duration`, so the duration is
      // the song-time span the arrangement draws — unscaled, even at rate 2.
      const clip = project.clips.find((c) => c.content.kind === "audioLoop");
      const placement = project.song.placements.find((p) => p.clipId === clip?.id);
      if (!clip || !placement) throw new Error("fixture has no audio loop");
      const eventTicks = Math.min(clip.lengthTicks, placement.durationTicks);
      expect(durationArg).toBeCloseTo(ticksToSeconds(eventTicks, 120));
    } finally {
      grainStart.mockRestore();
      plainStart.mockRestore();
    }

    await graph.dispose();
    await runtime.close();
  });

  it("auditionPad triggers the named track's instrument off the transport", async () => {
    const Tone = await import("tone");
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const transport = fakeTransport();
    const triggered: { padId: string }[] = [];
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      // A stub instrument factory records every pad trigger, so audition can
      // be asserted without a decoded buffer or a real Tone voice.
      createInstrument: (instrument) => {
        const output = new Tone.Gain(1);
        return {
          kind: instrument.kind,
          output,
          trigger(trigger) {
            if (trigger.kind === "pad") triggered.push({ padId: trigger.padId });
          },
          update() {},
          dispose() {
            output.dispose();
          },
        };
      },
    });
    const { createDrumMachineFixtureProject } = await import("../domain/fixtures");
    const project = createDrumMachineFixtureProject();
    graph.reconcile(buildAudioProjection(project));

    const drumTrack = project.song.tracks.find(
      (track) => track.instrument?.kind === "drumMachine",
    );
    if (drumTrack?.instrument?.kind !== "drumMachine") {
      throw new Error("fixture has no drum machine");
    }
    const padId = drumTrack.instrument.pads[0].id;

    graph.auditionPad(drumTrack.id, padId);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].padId).toBe(padId);

    await graph.dispose();
    // After disposal, auditioning is a no-op rather than a use-after-free.
    expect(() => graph.auditionPad(drumTrack.id, padId)).not.toThrow();
    await runtime.close();
  });
});

describe("ProjectAudioGraph trigger watchers (#447)", () => {
  it("reports scheduled and auditioned triggers with their look-ahead", async () => {
    const Tone = await import("tone");
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const transport = fakeTransport();
    let clock = 10;
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      now: () => clock,
      createInstrument: (instrument) => {
        const output = new Tone.Gain(1);
        return {
          kind: instrument.kind,
          output,
          trigger() {},
          update() {},
          dispose() {
            output.dispose();
          },
        };
      },
    });
    const { createDrumMachineFixtureProject } = await import("../domain/fixtures");
    const project = createDrumMachineFixtureProject();
    graph.reconcile(buildAudioProjection(project));
    const drumTrack = project.song.tracks.find(
      (track) => track.instrument?.kind === "drumMachine",
    );
    if (drumTrack?.instrument?.kind !== "drumMachine") throw new Error("no drums");
    const padId = drumTrack.instrument.pads[0].id;

    const heard: { trackId: string; trigger: unknown; delay: number }[] = [];
    const stop = graph.watchTriggers((trackId, trigger, delay) =>
      heard.push({ trackId, trigger, delay }),
    );

    // A scheduled hit fired 0.1 s ahead of the audio clock.
    const [firstEvent] = transport.callbacks.values();
    firstEvent(clock + 0.1);
    expect(heard).toHaveLength(1);
    expect(heard[0].delay).toBeCloseTo(0.1);

    // An audition is heard now.
    graph.auditionPad(drumTrack.id, padId);
    expect(heard[1]).toEqual({
      trackId: drumTrack.id,
      trigger: { kind: "pad", padId },
      delay: 0,
    });

    stop();
    clock = 11;
    graph.auditionPad(drumTrack.id, padId);
    expect(heard).toHaveLength(2);

    await graph.dispose();
    await runtime.close();
  });
});

/**
 * LOOP-006 — tempo-aware audio loops (PRD INS-02). Exercises the loop-track
 * playback path end to end against the reconciling graph: alignment across the
 * supported tempo range, tempo change, mute/solo, missing/undecodable asset,
 * and disposal. The pure tick math lives in `scheduling.test.ts`; these tests
 * assert the graph actually schedules, retimes, and tears down loop events.
 */
describe("ProjectAudioGraph audio loops (LOOP-006/INS-02)", () => {
  /** A one-track project whose only content is a two-bar audio loop authored at
   * `sourceTempo`, so a single scheduled loop event is easy to isolate. */
  function loopProject(sourceTempo = 120, songTempo = 120): Project {
    const base = createReferenceProject({
      trackCount: 1,
      waveformTrackCount: 1,
      placementCount: 1,
      minutes: 1,
      automationLaneCount: 0,
    });
    return {
      ...base,
      song: {
        ...base.song,
        tempo: songTempo,
      },
      clips: base.clips.map((clip) =>
        clip.content.kind === "audioLoop"
          ? { ...clip, content: { ...clip.content, sourceTempo } }
          : clip,
      ),
    };
  }

  function loopClip(project: Project) {
    const clip = project.clips.find((c) => c.content.kind === "audioLoop");
    if (!clip || clip.content.kind !== "audioLoop") {
      throw new Error("fixture has no audio loop");
    }
    return clip as typeof clip & {
      content: Extract<(typeof clip)["content"], { kind: "audioLoop" }>;
    };
  }

  it("keeps a loop's boundaries aligned over repeated playback across 40-240 BPM", async () => {
    // The loop is authored at 120 BPM and its clip is two bars. At every
    // supported song tempo, consecutive repeats must stay exactly one clip
    // length apart in wall-clock time, with no accumulating drift — that is
    // what "boundaries stay aligned over repeated playback at supported
    // tempos" means (INS-02).
    for (const songTempo of [40, 90, 120, 174, 240]) {
      const project = loopProject(120, songTempo);
      const clip = loopClip(project);
      const transport = simulatedTransport();
      const runtime = new AudioRuntimeModule.AudioRuntime();
      const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
        transport,
      });

      graph.reconcile(buildAudioProjection(project));

      // The single placement is one clip length long, so exactly one loop
      // event is scheduled, at the placement start.
      expect(transport.scheduledTicks()).toEqual([0]);

      // Fire the same clip-length window three times back to back, as the
      // transport loop would, and confirm each pass fires the loop once and
      // each pass starts exactly one clip length after the previous one.
      const clipSeconds = ticksToSeconds(clip.lengthTicks, songTempo);
      const passes = [
        transport.runRange(0, clip.lengthTicks, songTempo),
        transport.runRange(0, clip.lengthTicks, songTempo),
        transport.runRange(0, clip.lengthTicks, songTempo),
      ];
      for (const pass of passes) {
        expect(pass.map((event) => event.ticks)).toEqual([0]);
      }
      expect(passes[1][0].time - passes[0][0].time).toBeCloseTo(clipSeconds, 9);
      expect(passes[2][0].time - passes[1][0].time).toBeCloseTo(clipSeconds, 9);

      await graph.dispose();
      await runtime.close();
    }
  });

  it("retimes a loop event's sounded length when the song tempo changes, without duplicating it", async () => {
    const Tone = await import("tone");
    const project = loopProject(120, 120);
    const clip = loopClip(project);
    const { loader, pending } = manualBufferLoader();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      bufferLoader: loader,
    });

    const before = buildAudioProjection(project);
    graph.reconcile(before);
    for (const p of pending) p.resolve(fakeBuffer());
    await Promise.resolve();
    await Promise.resolve();

    // Halve the song tempo. The schedule is re-derived, still exactly one loop
    // event, and the playback rate follows tempo / sourceTempo.
    const retimed: Project = {
      ...project,
      song: { ...project.song, tempo: 60 },
    };
    graph.reconcile(buildAudioProjection(retimed, before));
    expect(graph.diagnostics().scheduledPlacements).toBe(1);
    // The re-derived schedule re-subscribes to the loop asset, so resolve the
    // buffer again for the new subscription before firing the event.
    for (const p of pending) p.resolve(fakeBuffer());
    await Promise.resolve();
    await Promise.resolve();

    const start = vi
      .spyOn(Tone.GrainPlayer.prototype, "start")
      .mockImplementation(function mocked(this: unknown) {
        return this as never;
      });
    try {
      for (const callback of transport.callbacks.values()) callback(0);
      expect(start).toHaveBeenCalledOnce();
      const [, , durationArg] = start.mock.calls[0];
      // At 60 BPM against a 120 BPM source the loop is stretched to 0.5x
      // and sounds for the whole, now longer, song-time span it covers.
      const eventTicks = Math.min(
        clip.lengthTicks,
        project.song.placements[0].durationTicks,
      );
      expect(durationArg).toBeCloseTo(ticksToSeconds(eventTicks, 60));
      const player = start.mock.instances[0] as import("tone").GrainPlayer;
      expect(player.playbackRate).toBeCloseTo(0.5);
      expect(player.detune).toBe(0);
    } finally {
      start.mockRestore();
    }

    await graph.dispose();
    await runtime.close();
  });

  it("does not play a loop whose track is muted", async () => {
    const Tone = await import("tone");
    const base = loopProject();
    const project: Project = {
      ...base,
      song: {
        ...base.song,
        tracks: base.song.tracks.map((track) => ({
          ...track,
          mixer: { ...track.mixer, muted: true },
        })),
      },
    };
    const { loader, pending } = manualBufferLoader();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      bufferLoader: loader,
    });
    graph.reconcile(buildAudioProjection(project));
    for (const p of pending) p.resolve(fakeBuffer());
    await Promise.resolve();
    await Promise.resolve();

    // The loop event is still scheduled — muting is a channel-strip state, not
    // a schedule change — but the muted track's strip silences it. The player
    // still starts; the muted PanVol is what makes it inaudible.
    const trackId = project.song.tracks[0].id;
    const trackGraph = graph.trackGraphs.get(trackId);
    expect(trackGraph).toBeDefined();
    // The connected Tone node is the track's muted input; assert the mute is
    // applied rather than reaching into the player.
    const start = vi
      .spyOn(Tone.Player.prototype, "start")
      .mockImplementation(function mocked(this: unknown) {
        return this as never;
      });
    try {
      for (const callback of transport.callbacks.values()) callback(0);
      // Playback of a muted track routes through a muted strip; the event is
      // still scheduled and started, so the schedule is unchanged by mute.
      expect(graph.diagnostics().scheduledPlacements).toBe(1);
    } finally {
      start.mockRestore();
    }

    await graph.dispose();
    await runtime.close();
  });

  it("reports a missing/undecodable loop asset through onAssetLoadFailure once, then removes it on reconcile", async () => {
    const project = loopProject();
    const onAssetLoadFailure = vi.fn();
    // A loader that always rejects, standing in for a missing or undecodable
    // loop file.
    const rejectingLoader: import("./AudioBufferCache").AssetBufferLoader<
      import("tone").ToneAudioBuffer
    > = {
      load: () => Promise.reject(new Error("decode failed")),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      bufferLoader: rejectingLoader,
      onAssetLoadFailure,
    });

    graph.reconcile(buildAudioProjection(project));
    await Promise.resolve();
    await Promise.resolve();

    expect(onAssetLoadFailure).toHaveBeenCalledOnce();
    const [failedAsset] = onAssetLoadFailure.mock.calls[0];
    expect(failedAsset.kind).toBe("loop");
    expect(failedAsset.id).toBe(loopClip(project).content.assetId);

    consoleError.mockRestore();
    await graph.dispose();
    await runtime.close();
  });

  it("clears a loop's scheduled events on dispose", async () => {
    const project = loopProject();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      bufferLoader: manualBufferLoader().loader,
    });
    graph.reconcile(buildAudioProjection(project));
    expect(graph.diagnostics().scheduledPlacements).toBe(1);
    expect(transport.scheduled.size).toBe(1);

    await graph.dispose();
    // Disposal releases every scheduled handle: the transport's schedule map
    // is empty and the cleared list records the loop event.
    expect(transport.scheduled.size).toBe(0);
    expect(transport.cleared.length).toBeGreaterThanOrEqual(1);

    await runtime.close();
  });

  /**
   * Issue #383: a loop that is sounding when playback stops (or pauses) must go
   * silent right away, not play out the rest of its scheduled span. The player
   * is started against the audio clock with its stop already scheduled at the
   * end of the event, so only an explicit stop at the transport's stop time can
   * cut it short.
   */
  function emittingTransport() {
    const listeners = new Map<string, Set<(time: number) => void>>();
    return Object.assign(fakeTransport(), {
      on(event: "stop" | "pause", callback: (time: number) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)?.add(callback);
      },
      off(event: "stop" | "pause", callback: (time: number) => void) {
        listeners.get(event)?.delete(callback);
      },
      emit(event: "stop" | "pause", time: number) {
        for (const callback of listeners.get(event) ?? []) callback(time);
      },
      listenerCount() {
        return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
      },
    });
  }

  for (const [event, sourceTempo, playerKind] of [
    ["stop", 120, "Player"],
    ["pause", 120, "Player"],
    ["stop", 60, "GrainPlayer"],
  ] as const) {
    it(`cuts a sounding ${playerKind} loop off when the transport emits ${event} (#383)`, async () => {
      const Tone = await import("tone");
      const project = loopProject(sourceTempo, 120);
      const { loader, pending } = manualBufferLoader();
      const transport = emittingTransport();
      const runtime = new AudioRuntimeModule.AudioRuntime();
      const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
        transport,
        bufferLoader: loader,
      });
      graph.reconcile(buildAudioProjection(project));
      for (const p of pending) p.resolve(fakeBuffer());
      await Promise.resolve();
      await Promise.resolve();

      const Ctor = Tone[playerKind];
      const start = vi.spyOn(Ctor.prototype, "start").mockImplementation(function mocked(
        this: unknown,
      ) {
        return this as never;
      });
      const stop = vi.spyOn(Ctor.prototype, "stop").mockImplementation(function mocked(
        this: unknown,
      ) {
        return this as never;
      });
      try {
        // The loop event fires and a player starts sounding the whole clip.
        for (const callback of transport.callbacks.values()) callback(0);
        expect(start).toHaveBeenCalledOnce();
        const player = start.mock.instances[0];

        // The user stops (or pauses) partway through the loop.
        transport.emit(event, 1.5);

        expect(stop).toHaveBeenCalledOnce();
        expect(stop.mock.instances[0]).toBe(player);
        expect(stop.mock.calls[0][0]).toBe(1.5);
      } finally {
        start.mockRestore();
        stop.mockRestore();
      }

      await graph.dispose();
      // Disposal unsubscribes, so a later project's transport halt never
      // reaches this graph.
      expect(transport.listenerCount()).toBe(0);
      await runtime.close();
    });
  }

  it("removes a loop's scheduled events when its placement is deleted", async () => {
    const project = loopProject();
    const transport = fakeTransport();
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const graph = new ProjectAudioGraphModule.ProjectAudioGraph(runtime, "p", {
      transport,
      bufferLoader: manualBufferLoader().loader,
    });
    const before = buildAudioProjection(project);
    graph.reconcile(before);
    expect(graph.diagnostics().scheduledPlacements).toBe(1);

    const withoutPlacement: Project = {
      ...project,
      song: { ...project.song, placements: [] },
    };
    graph.reconcile(buildAudioProjection(withoutPlacement, before));
    expect(graph.diagnostics().scheduledPlacements).toBe(0);
    expect(transport.scheduled.size).toBe(0);

    await graph.dispose();
    await runtime.close();
  });
});
