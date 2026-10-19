import { cleanup, renderHook } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import type { AudioHost, AudioProjectScope } from "../audio/AudioRuntime";
import { installWebAudioGlobals } from "../audio/testAudioContext";
import { executeTransaction, setLoopEnabled, setLoopRange } from "../commands";
import { createDevice } from "../domain/devices";
import type { Project } from "../domain/entities";
import { bars } from "../domain/factories";
import { createReferenceProject, createSliceFixtureProject } from "../domain/fixtures";
import { type AssetId, createSeededIdFactory, type TrackId } from "../domain/ids";
import { TICKS_PER_BAR } from "../domain/time";
import type { LibraryAsset } from "../library/manifest";
import { expectNoContent, recordErrorReports } from "../testing/errorReports";
import { memoryStorage } from "../testing/storage";

installWebAudioGlobals();

let AudioRuntimeModule: typeof import("../audio/AudioRuntime");
let useProjectAudioModule: typeof import("./useProjectAudio");

beforeAll(async () => {
  AudioRuntimeModule = await import("../audio/AudioRuntime");
  useProjectAudioModule = await import("./useProjectAudio");
});

afterEach(async () => {
  cleanup();
  useProjectAudioModule.__resetFirstPlayInSessionForTests();
  try {
    await AudioRuntimeModule.getAudioRuntime().close();
  } catch {
    // already closed
  }
  AudioRuntimeModule.__resetAudioRuntimeForTests();
});

const libraryAssetFixture = {
  name: "Kick",
  type: "one-shot",
  packId: "pak_previewpreviewpreview",
  packVersion: "1.0.0",
  url: null,
  storageKey: null,
  licence: "solid-groove-owned",
  durationSeconds: 0.5,
  sampleRate: 48_000,
  channelCount: 1,
  bpm: null,
  bars: null,
} as unknown as LibraryAsset;

function fakeAnalytics() {
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });
  return { analytics, transport };
}

/**
 * A minimal `AudioHost` whose `getDestination`/`openProjectScope` are never
 * meant to be called — `play()`'s error path only reaches `resume()` before
 * `useProjectAudio`'s reconcile effect (the only caller of the other two)
 * would run, as long as the `project` accessor stays `null`.
 */
function unreachableAudioHost(resume: () => Promise<void>): AudioHost {
  return {
    getDestination: () => {
      throw new Error("not reachable in this test");
    },
    getSampleRate: () => {
      throw new Error("not reachable in this test");
    },
    resume,
    openProjectScope: (): AudioProjectScope => {
      throw new Error("not reachable in this test");
    },
  };
}

describe("useProjectAudio", () => {
  it("logs audio_start_failed and never throws when resume() is rejected", async () => {
    const { analytics, transport } = fakeAnalytics();
    const runtime = unreachableAudioHost(() =>
      Promise.reject(new Error("NotAllowedError: blocked")),
    );

    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime,
          analytics,
        }),
      {},
    );

    await expect(result.play()).resolves.toBeUndefined();

    expect(result.isPlaying()).toBe(false);
    const events = transport.named("audio_start_failed");
    expect(events).toHaveLength(1);
    expect(events[0]?.params.error_code).toBeDefined();
  });

  it("reports a failed start to monitoring with the context's state, scrubbed (GRV-55)", async () => {
    const { analytics, transport } = fakeAnalytics();
    const recorded = recordErrorReports();
    const blocked = new Error("The play() request on My Song was blocked");
    blocked.name = "NotAllowedError";
    const runtime: AudioHost = {
      ...unreachableAudioHost(() => Promise.reject(blocked)),
      contextState: () => "suspended",
    };

    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime,
          analytics,
          reportError: recorded.report,
        }),
      {},
    );
    await result.play();

    expect(recorded.reports).toHaveLength(1);
    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({
      area: "audio",
      error_code: "autoplay_blocked",
      fatal: false,
      audio_context_state: "suspended",
    });
    expect(transport.named("audio_start_failed")).toHaveLength(1);
    expect(result.startFailure()?.code).toBe("autoplay_blocked");
  });

  it("reports a browser with no Web Audio as unavailable (GRV-55)", async () => {
    const { analytics } = fakeAnalytics();
    const recorded = recordErrorReports();
    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime: unreachableAudioHost(() => Promise.resolve()),
          analytics,
          webAudioAvailable: false,
          reportError: recorded.report,
        }),
      {},
    );
    await result.play();

    expect(recorded.payloads()[0]?.tags).toMatchObject({
      error_code: "not_supported",
      audio_context_state: "unavailable",
    });
  });

  it("toggle() plays then stops without a runtime that ever rejects", async () => {
    const { analytics } = fakeAnalytics();
    let resumed = 0;
    const runtime = unreachableAudioHost(() => {
      resumed += 1;
      return Promise.resolve();
    });

    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime,
          analytics,
        }),
      {},
    );

    await result.toggle();
    expect(result.isPlaying()).toBe(true);
    expect(resumed).toBe(1);

    await result.toggle();
    expect(result.isPlaying()).toBe(false);
    // stop() never calls resume() again.
    expect(resumed).toBe(1);
  });

  it("emits transport_play exactly once per play, with is_first_play_in_session true only the first time", async () => {
    const { analytics, transport } = fakeAnalytics();
    const runtime = unreachableAudioHost(() => Promise.resolve());

    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime,
          analytics,
        }),
      {},
    );

    await result.play();
    result.stop();
    await result.play();

    const events = transport.named("transport_play");
    expect(events).toHaveLength(2);
    expect(events[0]?.params.is_first_play_in_session).toBe(true);
    expect(events[1]?.params.is_first_play_in_session).toBe(false);
    // The surface is attached automatically (PRD OPS-02), not passed per event.
    expect(events[0]?.params.surface).toBeDefined();
  });

  it("does not emit transport_play when the context cannot unlock", async () => {
    const { analytics, transport } = fakeAnalytics();
    const runtime = unreachableAudioHost(() =>
      Promise.reject(new Error("NotAllowedError: blocked")),
    );

    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime,
          analytics,
        }),
      {},
    );

    await result.play();

    // A blocked unlock is reported as audio_start_failed, never transport_play.
    expect(transport.named("transport_play")).toHaveLength(0);
    expect(transport.named("audio_start_failed")).toHaveLength(1);
    expect(
      transport.named("audio_start_failed")[0]?.params.was_browser_blocked,
    ).toBeDefined();
  });

  it("treats a never-settling resume() as a browser-blocked unlock (issue #43)", async () => {
    const { analytics, transport } = fakeAnalytics();
    // Firefox under a blocked autoplay policy resolves neither way — the
    // resume promise never settles. Model that exactly.
    const runtime = unreachableAudioHost(() => new Promise<void>(() => {}));

    // A synchronous timer fires the timeout immediately, so the never-settling
    // resume loses the race deterministically without waiting on wall clock.
    let fired = 0;
    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime,
          analytics,
          resumeTimeoutMs: 5_000,
          setTimer: (callback) => {
            fired += 1;
            callback();
            return 0;
          },
          clearTimer: () => {},
        }),
      {},
    );

    await expect(result.play()).resolves.toBeUndefined();

    expect(fired).toBe(1);
    // The play button does not silently hang: exactly one browser-blocked
    // failure is surfaced, and playback never claims to have started.
    expect(result.isPlaying()).toBe(false);
    const failures = transport.named("audio_start_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.params.was_browser_blocked).toBe(true);
    expect(failures[0]?.params.error_code).toBe("autoplay_blocked");
    // A blocked unlock is never reported as a play.
    expect(transport.named("transport_play")).toHaveLength(0);
  });

  it("continueFromStop goes through the same bounded unlock and reports one play", async () => {
    const { analytics, transport } = fakeAnalytics();
    let resumed = 0;
    const runtime = unreachableAudioHost(() => {
      resumed += 1;
      return Promise.resolve();
    });

    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime,
          analytics,
        }),
      {},
    );

    await result.play();
    result.stop();
    // Shift+Space is a start-playback gesture too, so it unlocks the context
    // and reports exactly like Space does — one resume, one transport_play.
    await result.continueFromStop();

    expect(resumed).toBe(2);
    expect(result.isPlaying()).toBe(true);
    expect(transport.named("transport_play")).toHaveLength(2);
  });

  it("builds a real audio graph for the loaded project and disposes it without leaking resources when the owner unmounts", async () => {
    const runtime = AudioRuntimeModule.getAudioRuntime();
    const project = createSliceFixtureProject();

    const { result, cleanup: cleanupHook } = renderHook(
      () => useProjectAudioModule.useProjectAudio(() => project),
      {},
    );
    // Force the reconcile effect to run before asserting.
    void result.isPlaying();
    await Promise.resolve();
    await Promise.resolve();

    const afterMount = runtime.diagnostics().resources;
    expect(afterMount.byType.node ?? 0).toBeGreaterThan(0);
    expect(afterMount.byOwner[project.metadata.id]).toBeGreaterThan(0);

    cleanupHook();
    await Promise.resolve();
    await Promise.resolve();

    const afterDispose = runtime.diagnostics().resources;
    // The graph's own resources (nodes, schedules, subscriptions, buffers)
    // are all released; only the shared context — which this project graph
    // never owned and disposal must never touch (PRD AUD-07) — remains.
    expect(afterDispose.byOwner[project.metadata.id]).toBeUndefined();
    expect(afterDispose.byType.node ?? 0).toBe(0);
    expect(afterDispose.byType.schedule ?? 0).toBe(0);
    expect(afterDispose.byType.subscription ?? 0).toBe(0);
  });

  it("reads an EQ's spectrum only while the transport plays (LOOP-022)", async () => {
    const base = createSliceFixtureProject();
    const ids = createSeededIdFactory("spectrum");
    const eqId = ids("device");
    const filterId = ids("device");
    const project: Project = {
      ...base,
      song: {
        ...base.song,
        master: {
          ...base.song.master,
          devices: [createDevice(eqId, "eq", 0), createDevice(filterId, "filter", 1)],
        },
      },
    };
    // The real runtime's graph, behind a resume that settles: a test context
    // never unlocks on its own.
    const real = AudioRuntimeModule.getAudioRuntime();
    const runtime: AudioHost = {
      getDestination: () => real.getDestination(),
      getSampleRate: () => real.getSampleRate(),
      resume: () => Promise.resolve(),
      openProjectScope: (owner) => real.openProjectScope(owner),
    };
    const { result } = renderHook(
      () => useProjectAudioModule.useProjectAudio(() => project, { runtime }),
      {},
    );
    void result.isPlaying();
    await Promise.resolve();
    await Promise.resolve();

    // Stopped, there is nothing to draw and nothing is read.
    expect(result.readDeviceSpectrum(eqId)).toBeNull();

    await result.play();
    expect(result.isPlaying()).toBe(true);
    const reading = result.readDeviceSpectrum(eqId);
    expect(reading?.db).toHaveLength(1024);
    expect(reading?.binHz).toBeGreaterThan(0);
    // A device that draws no spectrum, and one that is not in the song.
    expect(result.readDeviceSpectrum(filterId)).toBeNull();
    expect(result.readDeviceSpectrum(ids("device"))).toBeNull();

    result.stop();
    expect(result.readDeviceSpectrum(eqId)).toBeNull();
  });

  it("starts the loudness programme over only on a play from the top (#937)", async () => {
    const { ProjectAudioGraph } = await import("../audio/ProjectAudioGraph");
    const project = createSliceFixtureProject();
    const real = AudioRuntimeModule.getAudioRuntime();
    const runtime: AudioHost = {
      getDestination: () => real.getDestination(),
      getSampleRate: () => real.getSampleRate(),
      resume: () => Promise.resolve(),
      openProjectScope: (owner) => real.openProjectScope(owner),
    };
    const reset = vi.spyOn(ProjectAudioGraph.prototype, "resetLoudness");
    try {
      const { result } = renderHook(
        () => useProjectAudioModule.useProjectAudio(() => project, { runtime }),
        {},
      );
      void result.isPlaying();
      await Promise.resolve();
      await Promise.resolve();

      await result.play();
      expect(reset).toHaveBeenCalledTimes(1);
      // A pause before the transport has advanced still sits on tick 0, but
      // resuming from it carries on with the same programme.
      result.pause();
      await result.play();
      expect(reset).toHaveBeenCalledTimes(1);
      // So does a resume from a pause further in.
      result.seekTicks(2 * TICKS_PER_BAR);
      result.pause();
      await result.play();
      expect(reset).toHaveBeenCalledTimes(1);
      result.stop();
      await result.play();
      expect(reset).toHaveBeenCalledTimes(2);
      result.stop();
    } finally {
      reset.mockRestore();
    }
  });

  it("previews a library sound in a slot without touching the project, and clears back (LIB-010)", async () => {
    const runtime = AudioRuntimeModule.getAudioRuntime();
    const project = createSliceFixtureProject();
    const before = structuredClone(project);
    const { result } = renderHook(
      () => useProjectAudioModule.useProjectAudio(() => project),
      {},
    );
    void result.isPlaying();
    await Promise.resolve();
    await Promise.resolve();
    const baseline = runtime.diagnostics().resources.byType.subscription ?? 0;
    const slot = { trackId: project.song.tracks[0].id };
    const library = (name: string, type: "one-shot" | "loop" = "one-shot") => ({
      ...libraryAssetFixture,
      id: name,
      type,
      storageKey: `${name}.wav`,
      url: `/library/audio/${name}.wav`,
    });

    expect(result.previewInSlot(slot, library("a"))).toBe(true);
    expect(result.previewInSlot(slot, library("a"))).toBe(true);
    expect(result.previewInSlot(slot, library("b"))).toBe(true);
    expect(runtime.diagnostics().resources.byType.subscription ?? 0).toBe(baseline);
    expect(result.previewInSlot(slot, library("l", "loop"))).toBe(false);
    result.clearPreview();
    expect(runtime.diagnostics().resources.byType.subscription ?? 0).toBe(baseline);
    expect(project).toEqual(before);
  });

  it("attaches a waveform watcher once the project's graph carries the asset (#447)", async () => {
    const { ProjectAudioGraph } = await import("../audio/ProjectAudioGraph");
    const release = vi.fn();
    const watch = vi
      .spyOn(ProjectAudioGraph.prototype, "watchAssetPeaks")
      .mockImplementation(() => ({ release }));
    const fixture = createSliceFixtureProject();
    const [project, setProject] = createSignal<Project>(fixture);
    // A sound the song does not carry yet, as when one is being added.
    const added = { ...fixture.song.assets[0], id: "ast_added" as AssetId };

    const { result } = renderHook(
      () => useProjectAudioModule.useProjectAudio(project),
      {},
    );
    flush();
    const stop = result.watchAssetPeaks(added.id, 64, () => {});
    // Asked for before the graph carries it: it waits rather than failing.
    expect(watch).not.toHaveBeenCalled();

    setProject({
      ...fixture,
      song: { ...fixture.song, assets: [...fixture.song.assets, added] },
    });
    flush();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0][0].id).toBe(added.id);
    expect(watch.mock.calls[0][1]).toBe(64);

    // A later edit does not attach it twice.
    setProject({ ...project(), song: { ...project().song, tempo: 99 } });
    flush();
    expect(watch).toHaveBeenCalledTimes(1);

    stop();
    expect(release).toHaveBeenCalledTimes(1);
    watch.mockRestore();
  });

  it("lets a waveform watcher go when its sound leaves the song, and rejoins it (#447)", async () => {
    const { ProjectAudioGraph } = await import("../audio/ProjectAudioGraph");
    const release = vi.fn();
    const watch = vi
      .spyOn(ProjectAudioGraph.prototype, "watchAssetPeaks")
      .mockImplementation(() => ({ release }));
    const fixture = createSliceFixtureProject();
    const added = { ...fixture.song.assets[0], id: "ast_added" as AssetId };
    const withAdded = {
      ...fixture,
      song: { ...fixture.song, assets: [...fixture.song.assets, added] },
    };
    const [project, setProject] = createSignal<Project>(withAdded);
    const { result } = renderHook(
      () => useProjectAudioModule.useProjectAudio(project),
      {},
    );
    flush();
    const stop = result.watchAssetPeaks(added.id, 64, () => {});
    expect(watch).toHaveBeenCalledTimes(1);

    // The sound leaves the song: its buffer is not held for the drawing.
    setProject(fixture);
    flush();
    expect(release).toHaveBeenCalledTimes(1);

    // And comes back: the drawing follows it again.
    setProject(withAdded);
    flush();
    expect(watch).toHaveBeenCalledTimes(2);

    stop();
    expect(release).toHaveBeenCalledTimes(2);
    watch.mockRestore();
  });

  it("hands a track's triggers to its watchers once they are heard (#447)", async () => {
    vi.useFakeTimers();
    try {
      const { ProjectAudioGraph } = await import("../audio/ProjectAudioGraph");
      let report: Parameters<InstanceType<typeof ProjectAudioGraph>["watchTriggers"]>[0] =
        () => {};
      const watch = vi
        .spyOn(ProjectAudioGraph.prototype, "watchTriggers")
        .mockImplementation((watcher) => {
          report = watcher;
          return () => {};
        });
      const fixture = createSliceFixtureProject();
      const [project] = createSignal<Project>(fixture);
      const { result } = renderHook(
        () => useProjectAudioModule.useProjectAudio(project),
        {},
      );
      flush();
      expect(watch).toHaveBeenCalledTimes(1);

      const [track, other] = [fixture.song.tracks[0].id, "trk_other" as TrackId];
      const heard: unknown[] = [];
      const stop = result.watchTriggers(track, (trigger) => heard.push(trigger));
      const trigger = { kind: "pitch", pitch: 60 } as const;
      report(track, trigger, 0.1);
      report(other, trigger, 0);
      // Not yet: the trigger was scheduled a look-ahead before it sounds.
      expect(heard).toHaveLength(0);
      vi.advanceTimersByTime(100);
      expect(heard).toEqual([trigger]);

      stop();
      report(track, trigger, 0);
      vi.advanceTimersByTime(1);
      expect(heard).toHaveLength(1);
      watch.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("mirrors song.loop onto the transport, and follows a loop edit in place (LOOP-017)", async () => {
    const Tone = await import("tone");
    const runtime = AudioRuntimeModule.getAudioRuntime();
    const [project, setProject] = createSignal<Project>(createSliceFixtureProject());
    const toneTicks = (time: unknown) => Math.round(Tone.Time(time as number).toTicks());

    const { result, cleanup: cleanupHook } = renderHook(
      () => useProjectAudioModule.useProjectAudio(project),
      {},
    );
    void result.isPlaying();
    await Promise.resolve();
    await Promise.resolve();

    // A new project's loop is one bar from tick 0, on — and the transport
    // obeys it from the first reconcile, not from a hard-coded session value.
    const tone = Tone.getTransport();
    expect(result.loopEnabled()).toBe(true);
    expect(result.loop()).toEqual({ startTicks: 0, endTicks: TICKS_PER_BAR });
    expect(tone.loop).toBe(true);
    expect(toneTicks(tone.loopEnd)).toBe(TICKS_PER_BAR);
    const nodesBefore = runtime.diagnostics().resources.byType.node;

    const edited = executeTransaction(project(), [
      setLoopRange(bars(2), bars(4)),
      setLoopEnabled(false),
    ]);
    if (!edited.ok) throw new Error(edited.issues[0].message);
    setProject(edited.project);
    flush();

    expect(result.loop()).toEqual({ startTicks: bars(2), endTicks: bars(4) });
    expect(result.loopEnabled()).toBe(false);
    expect(tone.loop).toBe(false);
    expect(toneTicks(tone.loopStart)).toBe(bars(2));
    expect(toneTicks(tone.loopEnd)).toBe(bars(4));
    // Updated in place: no audio node was created or disposed for it.
    expect(runtime.diagnostics().resources.byType.node).toBe(nodesBefore);

    cleanupHook();
  });

  // LOOP-006 / INS-02 analytics: a project with a tempo-labelled loop reports
  // `audio_loop` first-use, and a loop that cannot be decoded reports
  // `asset_load_failed`.
  describe("audio-loop analytics", () => {
    /** A one-track project whose only content is an audio loop. */
    function loopProject(): Project {
      return createReferenceProject({
        trackCount: 1,
        waveformTrackCount: 1,
        placementCount: 1,
        minutes: 1,
        automationLaneCount: 0,
      });
    }

    it("fires feature_first_use(audio_loop) once for a project with a loop clip", async () => {
      const { analytics, transport } = fakeAnalytics();
      const runtime = AudioRuntimeModule.getAudioRuntime();
      const project = loopProject();

      const { cleanup: cleanupHook } = renderHook(
        () =>
          useProjectAudioModule.useProjectAudio(() => project, {
            runtime,
            analytics,
          }),
        {},
      );
      await Promise.resolve();
      await Promise.resolve();

      const events = transport.named("feature_first_use");
      expect(events).toHaveLength(1);
      expect(events[0]?.params.feature).toBe("audio_loop");

      cleanupHook();
    });

    it("emits asset_load_failed with asset_type=loop when a loop asset cannot be decoded", async () => {
      const { analytics, transport } = fakeAnalytics();
      const runtime = AudioRuntimeModule.getAudioRuntime();
      const base = loopProject();
      // Strip the loop asset's URL: the production tone loader rejects an
      // asset with no URL to decode, the same missing-asset outcome the
      // event exists to count.
      const project: Project = {
        ...base,
        song: {
          ...base.song,
          assets: base.song.assets.map((asset) =>
            asset.kind === "loop" ? { ...asset, url: null } : asset,
          ),
        },
      };

      const { cleanup: cleanupHook } = renderHook(
        () =>
          useProjectAudioModule.useProjectAudio(() => project, {
            runtime,
            analytics,
          }),
        {},
      );
      // Let the reconcile effect run and the rejected decode settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const events = transport.named("asset_load_failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.params.asset_type).toBe("loop");
      expect(events[0]?.params.error_code).toBeDefined();

      cleanupHook();
    });

    it("reports a sound that cannot load to monitoring, scrubbed, and says how many are silent (GRV-55)", async () => {
      const { analytics, transport } = fakeAnalytics();
      const recorded = recordErrorReports();
      const runtime = AudioRuntimeModule.getAudioRuntime();
      const base = loopProject();
      const project: Project = {
        ...base,
        song: {
          ...base.song,
          assets: base.song.assets.map((asset) =>
            asset.kind === "loop" ? { ...asset, url: null } : asset,
          ),
        },
      };
      const loop = project.song.assets.find((asset) => asset.kind === "loop");
      if (!loop) throw new Error("expected a loop asset");

      const { result, cleanup: cleanupHook } = renderHook(
        () =>
          useProjectAudioModule.useProjectAudio(() => project, {
            runtime,
            analytics,
            reportError: recorded.report,
          }),
        {},
      );
      await vi.waitFor(() => expect(recorded.reports).toHaveLength(1));

      const [payload] = recorded.payloads();
      expect(payload.tags).toMatchObject({ area: "audio", fatal: false });
      expect(payload.tags?.error_code).toBe(
        transport.named("asset_load_failed")[0]?.params.error_code,
      );
      expect(payload.tags?.audio_context_state).toBeDefined();
      expectNoContent(payload, [
        project.metadata.name,
        loop.name,
        loop.storageRef ?? "storage-ref",
        ...project.song.tracks.map((track) => track.name),
        ...base.song.assets.flatMap((asset) => (asset.url ? [asset.url] : [])),
      ]);
      expect(result.loadFailure()).toEqual({ count: 1, attempt: 1 });

      cleanupHook();
    });
  });

  it("auditionTrack unlocks the context and resolves true on a loaded project", async () => {
    const { analytics } = fakeAnalytics();
    let resumed = 0;
    const runtime = unreachableAudioHost(() => {
      resumed += 1;
      return Promise.resolve();
    });
    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime,
          analytics,
        }),
      {},
    );

    const played = await result.auditionTrack(
      "trk_any" as never,
      { kind: "pitch", pitch: 60 },
      192,
      0.9,
    );
    // The audition is a user gesture: it resumes the shared context exactly once
    // and reports success even when the graph has no such track (a no-op play).
    expect(played).toBe(true);
    expect(resumed).toBe(1);
  });

  it("auditionTrack reports audio_start_failed and resolves false when blocked", async () => {
    const { analytics, transport } = fakeAnalytics();
    const runtime = unreachableAudioHost(() =>
      Promise.reject(new Error("NotAllowedError: blocked")),
    );
    const { result } = renderHook(
      () =>
        useProjectAudioModule.useProjectAudio(() => null, {
          runtime,
          analytics,
        }),
      {},
    );

    const played = await result.auditionTrack(
      "trk_any" as never,
      { kind: "pitch", pitch: 60 },
      192,
      0.9,
    );
    expect(played).toBe(false);
    expect(transport.named("audio_start_failed")).toHaveLength(1);
  });
});

// #75: a browser that cannot start sound is explained, not left silent, and a
// browser with no Web Audio at all still opens the editor.
describe("useProjectAudio start failures", () => {
  it("keeps the last start failure, counts attempts, and clears it once sound starts", async () => {
    const { analytics } = fakeAnalytics();
    let refuse = true;
    const runtime = unreachableAudioHost(() =>
      refuse
        ? Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }))
        : Promise.resolve(),
    );
    const { result } = renderHook(() =>
      useProjectAudioModule.useProjectAudio(() => null, { runtime, analytics }),
    );

    expect(result.startFailure()).toBeNull();
    await result.play();
    const first = result.startFailure();
    expect(first?.attempt).toBe(1);
    await result.play();
    expect(result.startFailure()?.attempt).toBe(2);
    expect(result.startFailure()?.code).toBe(first?.code);

    refuse = false;
    await result.play();
    expect(result.isPlaying()).toBe(true);
    expect(result.startFailure()).toBeNull();
  });

  it("reports a failed audition but leaves explaining it to Play", async () => {
    const { analytics, transport } = fakeAnalytics();
    const runtime = unreachableAudioHost(() =>
      Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" })),
    );
    const { result } = renderHook(() =>
      useProjectAudioModule.useProjectAudio(() => null, { runtime, analytics }),
    );

    await expect(
      result.auditionTrack(
        "trk_x" as TrackId,
        { kind: "pitch", pitch: 60 } as never,
        48,
        100,
      ),
    ).resolves.toBe(false);
    expect(transport.named("audio_start_failed")).toHaveLength(1);
    expect(result.startFailure()).toBeNull();
  });

  it("opens a project with no Web Audio without building a graph, and explains a play", async () => {
    const { analytics, transport } = fakeAnalytics();
    let resumed = 0;
    // Every graph-building call throws, so reaching one fails the test.
    const runtime = unreachableAudioHost(() => {
      resumed += 1;
      return Promise.resolve();
    });
    const project = createSliceFixtureProject();

    const { result } = renderHook(() =>
      useProjectAudioModule.useProjectAudio(() => project, {
        runtime,
        analytics,
        webAudioAvailable: false,
      }),
    );
    flush();

    expect(result.loopEnabled()).toBe(project.song.loop.enabled);
    await expect(result.play()).resolves.toBeUndefined();
    expect(result.isPlaying()).toBe(false);
    expect(resumed).toBe(0);
    expect(result.startFailure()?.code).toBe("not_supported");
    expect(transport.named("audio_start_failed").map((event) => event.params)).toEqual([
      expect.objectContaining({
        error_code: "not_supported",
        was_browser_blocked: false,
      }),
    ]);
    expect(transport.named("transport_play")).toHaveLength(0);
  });
});
