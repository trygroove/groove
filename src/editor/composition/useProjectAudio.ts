import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import type { ErrorCode } from "../../analytics/errorCodes";
import type { BufferSubscription } from "../../audio/AudioBufferCache";
import { type AudioHost, getAudioRuntime } from "../../audio/AudioRuntime";
import type { DeviceMeterReading, SpectrumReading } from "../../audio/DeviceChain";
import { ProjectAudioGraph } from "../../audio/ProjectAudioGraph";
import {
  type LoopRange,
  liveTransportEngine,
  TransportController,
  TransportMetronome,
} from "../../audio/Transport";
import { createTriggerFeed } from "../../audio/triggerFeed";
import { UnderrunMonitor } from "../../audio/underrun";
import { webAudioAvailable } from "../../browser/capabilities";
import type { NoteTrigger, Project } from "../../domain/entities";
import type { AssetId, DeviceId, PadId, TrackId } from "../../domain/ids";
import { toLibrarySample } from "../../library/insertion";
import type { LibraryAsset } from "../../library/manifest";
import { audioContextStateKey } from "../../monitoring/errorContext";
import { CodedError, codeFor, reportError } from "../../monitoring/errorReporting";
import type { AudioAssetProjection } from "../../projection/audioProjection";
import {
  type AudioSongProjection,
  buildAudioProjection,
} from "../../projection/audioProjection";
import {
  applyPreviewOverride,
  type PreviewOverride,
  type PreviewSlot,
  previewAssetId,
} from "../../projection/previewOverride";
import { createDeviceMeters } from "../mixer/deviceMeters";
import {
  createMasterLevel,
  createTrackLevels,
  type TrackLevel,
} from "../tracks/trackLevels";
import { type LeakReportOptions, reportAudioLeaks } from "./leakReport";

/**
 * Maps an asset's library kind to the `asset_load_failed` `asset_type` value
 * (PRD OPS-02). A `loop` asset is a tempo-labelled loop; a `sample` or
 * `recording` plays as a pitched one-shot, so both report `one_shot`.
 */
function assetLoadFailureType(kind: string): "one_shot" | "loop" | "instrument_preset" {
  return kind === "loop" ? "loop" : "one_shot";
}

/**
 * The last time sound failed to start, for the editor to explain (#75). `attempt`
 * counts failures, so a second failure after the producer dismissed the first
 * is a new notice rather than the same dismissed one.
 */
export interface AudioStartFailure {
  readonly code: ErrorCode;
  readonly attempt: number;
}

/**
 * Sounds of this project that could not be loaded to play (GRV-55): missing,
 * unreachable or undecodable. `count` is how many distinct sounds; `attempt`
 * grows with each failure, so a notice the producer dismissed comes back for
 * the next one.
 */
export interface SoundLoadFailure {
  readonly count: number;
  readonly attempt: number;
}

export interface ProjectAudioControls {
  readonly isPlaying: Accessor<boolean>;
  /**
   * Why the last attempt to start sound failed, or `null` once sound has
   * started. Set by the same failures that report `audio_start_failed`.
   */
  readonly startFailure: Accessor<AudioStartFailure | null>;
  /** The project's sounds that failed to load, or `null` while none has (GRV-55). */
  readonly loadFailure: Accessor<SoundLoadFailure | null>;
  /** The playhead position in ticks, updated per animation frame while playing. */
  readonly positionTicks: Accessor<number>;
  /**
   * The song's loop as the transport is currently obeying it. Read-only: the
   * loop is song state, changed only by the `loop.*` commands (see
   * `loopActions.ts`), and mirrored onto the transport on every project change.
   */
  readonly loopEnabled: Accessor<boolean>;
  readonly loop: Accessor<LoopRange | null>;
  readonly metronomeEnabled: Accessor<boolean>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  toggle(): Promise<void>;
  /** Resume from where playback last stopped (KEY-01 `transport.continue`). */
  continueFromStop(): Promise<void>;
  seekTicks(ticks: number): void;
  /**
   * A track's post-fader level, reactively, or `null` when it is not sounding
   * (PRD TRK-02, #447). Every track's meter is read once per frame while the
   * transport plays, in the same loop as the playhead, so a view's meters
   * cost no loop of their own; reading a meter emits no telemetry.
   */
  trackLevel(trackId: TrackId): TrackLevel | null;
  /**
   * The master's level, reactively, or `null` while nothing plays (GRV-44):
   * read in the same frame loop as the tracks', after everything on the
   * master, so its clip state says whether the mix itself went over.
   */
  readonly masterLevel: Accessor<TrackLevel | null>;
  toggleMetronome(): void;
  /**
   * Plays one drum pad immediately (a panel audition, PRD INS-01). It resumes
   * the shared audio context behind the click, so the first audition is a valid
   * user-gesture unlock just like `play()`.
   */
  auditionPad(trackId: TrackId, padId: PadId): Promise<void>;
  /**
   * Plays one note through a track's instrument for auditioning (PRD INS-01).
   * Resumes the shared context behind the calling user gesture, then triggers
   * the sound through the track's own chain. Resolves whether a note was
   * triggered; a browser-blocked unlock reports `audio_start_failed` and
   * resolves `false`, like `play()`.
   */
  auditionTrack(
    trackId: TrackId,
    trigger: NoteTrigger,
    durationTicks: number,
    velocity: number,
  ): Promise<boolean>;
  /**
   * Hot-swap audition (LIB-010): plays `sound` in place of `slot`'s own sample
   * (a sampler track, or one drum pad) inside the beat. Audio only: no
   * command, history entry, save or sync. A new sound replaces the previous
   * one and releases its buffer; repeating a call is a no-op. Returns `false`
   * (and drops any preview) for a sound a slot cannot play, such as a loop.
   * `owner`, when given, marks the override as that caller's, for
   * {@link clearPreview}.
   */
  previewInSlot(slot: PreviewSlot, sound: LibraryAsset, owner?: object): boolean;
  /**
   * Puts the slot's own sound back. Given an `owner`, only an override that
   * owner set is dropped, so the Library closing never clears a sound another
   * surface (the assistant's Try, GRV-23) has just put in the slot.
   */
  clearPreview(owner?: object): void;
  /**
   * Follows the waveform of one of the project's sounds for drawing it (#447):
   * `onPeaks` gets `buckets` peaks, 0..1, once the engine has decoded the sound
   * to play it, and again whenever it changes. Returns the way to stop. Safe to
   * call before the graph exists or the asset is in the song; it attaches as
   * soon as both are there.
   */
  watchAssetPeaks(
    assetId: AssetId,
    buckets: number,
    onPeaks: (peaks: Float32Array | null) => void,
  ): () => void;
  /**
   * Follows one track's instrument triggers as they are heard, scheduled or
   * auditioned, so a view can show what is playing (#447). Returns the way to
   * stop.
   */
  watchTriggers(trackId: TrackId, onTrigger: (trigger: NoteTrigger) => void): () => void;
  /**
   * The spectrum leaving one device now, for a panel that draws it behind its
   * controls (the EQ, LOOP-022), or `null` while the transport is stopped or
   * the device draws none. The panel polls it on its own frames, and only
   * while it is on screen and the transport plays.
   */
  readDeviceSpectrum(deviceId: DeviceId): SpectrumReading | null;
  /**
   * A metering device's readouts (the Limiter's gain reduction and loudness,
   * #937), reactively, or `null` for a device with none or before any play.
   */
  deviceMeter(deviceId: DeviceId): DeviceMeterReading | null;
}

export interface UseProjectAudioOptions {
  /** Defaults to the application's single `AudioRuntime`; injectable for tests. */
  readonly runtime?: AudioHost;
  readonly analytics?: Analytics;
  /** Overrides the animation-frame scheduler used to advance the playhead. */
  readonly requestFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  /**
   * How long to wait for the user-gesture unlock before treating it as a
   * browser-blocked refusal (PRD OPS-02 / issue #43). Firefox under a blocked
   * autoplay policy never settles `Tone.start()`'s context resume, so without a
   * bound the play button would silently do nothing forever. Defaults to
   * {@link DEFAULT_RESUME_TIMEOUT_MS}; injectable so tests can drive the
   * never-settling path deterministically.
   */
  readonly resumeTimeoutMs?: number;
  /** Overrides the timer used to bound the unlock; injectable for tests. */
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (handle: number) => void;
  /**
   * Whether this browser has Web Audio at all (#75). Defaults to the feature
   * detection in `src/browser/capabilities.ts`. Without it no graph is built,
   * so the editor opens silent instead of failing on a missing
   * `AudioContext`, and a play gesture reports `not_supported`.
   */
  readonly webAudioAvailable?: boolean;
  /** The error-reporting boundary; tests inject a recorder (GRV-55). */
  readonly reportError?: typeof reportError;
  /** How a project's leaked audio resources are reported (GRV-55); tests pin sampling. */
  readonly leaks?: Pick<LeakReportOptions, "random" | "sampleRate" | "warn">;
}

/**
 * The unlock timeout. Long enough that a genuinely slow-but-succeeding resume
 * on a healthy browser still wins the race, short enough that a user staring at
 * a dead play button gets actionable feedback rather than an indefinite hang.
 */
export const DEFAULT_RESUME_TIMEOUT_MS = 5_000;

/**
 * True until the first play of the analytics session, across projects. Module
 * scope (not per-hook) so opening a second project in the same tab does not
 * reset `is_first_play_in_session` (PRD OPS-02).
 */
let firstPlayInSession = true;

/**
 * How many project graphs this page has built: the second half of each
 * graph's registry owner (GRV-55). Module-wide, not per hook, so an editor
 * that remounts on the same project never reuses the owner of the graph still
 * being disposed.
 */
let graphsBuilt = 0;

/** Test-only: reset the session-first-play flag between tests. */
export function __resetFirstPlayInSessionForTests(): void {
  firstPlayInSession = true;
}

/**
 * Wires one project onto the stable, ID-keyed audio graph, the single shared
 * `AudioRuntime`, and the transport (PRD AUD-01..AUD-04, AUD-07/AUD-08).
 *
 * `project()` changing reconciles the existing `ProjectAudioGraph` — an
 * unrelated edit never rebuilds nodes it did not touch — and only a change of
 * project *id* disposes the previous graph and opens a new scope. The song's
 * tempo is mirrored onto the transport on every reconcile, so a tempo command
 * re-times the schedule without restarting the song (PRD AUD-02).
 *
 * `play()` is the allowed user gesture that resumes the runtime's context and
 * emits `transport_play`; a browser refusal is reported as `audio_start_failed`
 * (PRD OPS-02). The playhead follows via animation frames, but every audible
 * event is scheduled ahead of time by the graph, and late dispatches are
 * sampled into `audio_underrun` — playback emits nothing per scheduled event or
 * per frame (PRD AUD-03/OPS-02).
 */
export function useProjectAudio(
  project: Accessor<Project | null>,
  options: UseProjectAudioOptions = {},
): ProjectAudioControls {
  const runtime = options.runtime ?? getAudioRuntime();
  const analytics = options.analytics ?? defaultAnalytics;
  const requestFrame =
    options.requestFrame ??
    ((callback) =>
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => callback())
        : (setTimeout(callback, 16) as unknown as number));
  const cancelFrame =
    options.cancelFrame ??
    ((handle) => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
      else clearTimeout(handle);
    });
  const resumeTimeoutMs = options.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS;
  const setTimer =
    options.setTimer ??
    ((callback, delayMs) => setTimeout(callback, delayMs) as unknown as number);
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const audioAvailable = options.webAudioAvailable ?? webAudioAvailable();
  const report = options.reportError ?? reportError;
  /** The context's state for a report: what the browser says, or why there is none. */
  const audioContextState = () =>
    audioAvailable ? audioContextStateKey(runtime.contextState?.()) : "unavailable";

  const [isPlaying, setIsPlaying] = createSignal(false);
  const [startFailure, setStartFailure] = createSignal<AudioStartFailure | null>(null);
  let startFailures = 0;
  const [loadFailure, setLoadFailure] = createSignal<SoundLoadFailure | null>(null);
  /** The sounds of the open project that failed to load, and how many failures. */
  const failedAssets = new Set<string>();
  let loadFailures = 0;
  const [positionTicks, setPositionTicks] = createSignal(0);
  const [loopEnabled, setLoopEnabled] = createSignal(false);
  const [loop, setLoop] = createSignal<LoopRange | null>(null);
  const [metronomeEnabled, setMetronomeEnabled] = createSignal(false);
  const levels = createTrackLevels();
  const masterLevel = createMasterLevel();
  const meters = createDeviceMeters();

  let graph: ProjectAudioGraph | null = null;
  let transport: TransportController | null = null;
  let metronome: TransportMetronome | null = null;
  let ownerId: string | null = null;
  /**
   * The registry owner of the current graph: the project's ID and which
   * graph this is for it, so a graph built again for the same project (the
   * hook remounting, or the project reopened) never has its resources
   * counted as the last one's leaks.
   */
  let graphOwner: string | null = null;
  /** Stops listening for the browser closing the context, once listening. */
  let stopWatchingClose: (() => void) | null = null;
  /** Whether a closed context has been reported: it is one failure, however many presses of Play meet it. */
  let closeReported = false;
  let lastProjection: AudioSongProjection | undefined;
  let frameHandle: number | null = null;
  let preview: PreviewOverride | null = null;
  let previewOwner: object | undefined;

  function reconcileGraph(): void {
    if (!graph || !lastProjection) return;
    graph.reconcile(applyPreviewOverride(lastProjection, preview));
  }

  function setPreview(next: PreviewOverride | null): void {
    preview = next;
    reconcileGraph();
  }
  function previewInSlot(
    slot: PreviewSlot,
    asset: LibraryAsset,
    owner?: object,
  ): boolean {
    const sample = asset.type === "loop" ? null : toLibrarySample(asset);
    if (!sample) {
      clearPreview();
      return false;
    }
    if (
      preview &&
      preview.slot.trackId === slot.trackId &&
      preview.slot.padId === slot.padId &&
      previewAssetId(preview.sound) === previewAssetId(sample)
    ) {
      previewOwner = owner;
      return true;
    }
    previewOwner = owner;
    setPreview({ slot, sound: sample });
    return true;
  }

  function clearPreview(owner?: object): void {
    if (!preview) return;
    if (owner !== undefined && previewOwner !== owner) return;
    previewOwner = undefined;
    setPreview(null);
  }

  function underrunMonitor(): UnderrunMonitor {
    return new UnderrunMonitor({
      contextSampleRate: runtime.getSampleRate(),
      emit: (report) => {
        analytics.log("audio_underrun", {
          dropped_event_bucket: report.droppedEventBucket,
          sample_rate: report.sampleRate,
        });
      },
    });
  }

  /**
   * A loop or sample the graph needed could not be decoded or is missing
   * (PRD OPS-02, LOOP-006). Emitted once per failed load attempt by the buffer
   * cache; the error is classified into an actionable code and the asset's
   * library kind into an `asset_type`. Carries no URL, storage ref, or asset
   * name — those are project/content strings the OPS-02 catalog keeps out of
   * telemetry.
   */
  function reportAssetLoadFailure(asset: AudioAssetProjection, error: unknown): void {
    const code = codeFor(error);
    analytics.log("asset_load_failed", {
      asset_type: assetLoadFailureType(asset.kind),
      error_code: code,
    });
    // Monitoring gets the code and the context's state, never the loader's
    // own error: its message can carry the sound's URL or storage path.
    report(new CodedError(code, "A sound could not be loaded"), {
      area: "audio",
      fatal: false,
      code,
      context: { audio_context_state: audioContextState() },
    });
    failedAssets.add(asset.id);
    loadFailures += 1;
    setLoadFailure({ count: failedAssets.size, attempt: loadFailures });
  }

  interface PeakWatcher {
    readonly assetId: AssetId;
    readonly buckets: number;
    readonly onPeaks: (peaks: Float32Array | null) => void;
    subscription?: BufferSubscription;
    /** The projection entry the subscription follows, while it has one. */
    asset?: AudioAssetProjection;
  }
  const peakWatchers = new Set<PeakWatcher>();

  /**
   * Points every peak watcher at the sound the graph carries now: a watcher
   * whose sound arrived attaches, one whose sound changed follows the new
   * entry, and one whose sound left the song lets its buffer go until it
   * returns. The projection shares unchanged entries, so identity is change.
   */
  function attachPeakWatchers(): void {
    if (!graph || !lastProjection) return;
    const assets = new Map(lastProjection.assets.map((entry) => [entry.id, entry]));
    for (const watcher of peakWatchers) {
      const asset = assets.get(watcher.assetId);
      if (asset === watcher.asset) continue;
      watcher.subscription?.release();
      watcher.subscription = asset
        ? graph.watchAssetPeaks(asset, watcher.buckets, watcher.onPeaks)
        : undefined;
      watcher.asset = asset;
    }
  }

  function watchAssetPeaks(
    assetId: AssetId,
    buckets: number,
    onPeaks: (peaks: Float32Array | null) => void,
  ): () => void {
    const watcher: PeakWatcher = { assetId, buckets, onPeaks };
    peakWatchers.add(watcher);
    attachPeakWatchers();
    return () => {
      peakWatchers.delete(watcher);
      watcher.subscription?.release();
    };
  }

  // What is playing, for the views that show it (#447). The feed outlives any
  // one graph: a view's subscription survives a project switch, and only the
  // deliveries still waiting on the old graph are dropped with it.
  const triggers = createTriggerFeed();
  let stopGraphTriggers: (() => void) | null = null;

  function watchTriggers(
    trackId: TrackId,
    onTrigger: (trigger: NoteTrigger) => void,
  ): () => void {
    return triggers.subscribe(trackId, onTrigger);
  }

  function tearDown(): void {
    stopGraphTriggers?.();
    stopGraphTriggers = null;
    triggers.cancelPending();
    // The graph's buffer cache goes with it; watchers reattach to the next one.
    for (const watcher of peakWatchers) {
      watcher.subscription?.release();
      watcher.subscription = undefined;
      watcher.asset = undefined;
    }
    stopFrameLoop();
    metronome?.dispose();
    metronome = null;
    transport = null;
    const closing = graph;
    const closingOwner = graphOwner;
    graph = null;
    if (closing && closingOwner) {
      // Once the project's scope is disposed, anything still registered under
      // it is a leak (GRV-55).
      void closing.dispose().then(() =>
        reportAudioLeaks(runtime.ownedResources?.(closingOwner) ?? [], {
          ...options.leaks,
          analytics,
          report,
        }),
      );
    }
    preview = null;
    // A new project starts with none of the last one's failed sounds.
    failedAssets.clear();
    setLoadFailure(null);
  }

  // Split effect. `project()` is the effect's only reactive read, so the
  // compute half is exactly that read and the whole body below moves to the
  // apply half — which is also where it belongs, because it writes the
  // loop/metronome signals and Solid 2 throws on a write inside a tracking
  // scope.
  //
  // `lastProjection` stays a closure variable of the hook, not of the apply
  // function, so each run still hands the *previous* projection back to
  // `buildAudioProjection` and an unrelated edit reuses every entry it did not
  // touch (PRD AUD-08).
  createEffect(
    () => project(),
    (current) => {
      if (!current) return;
      if (!audioAvailable) {
        // No Web Audio, so nothing to build a graph on (#75). The loop is
        // still song state the transport bar shows, so it is mirrored anyway.
        setLoopEnabled(current.song.loop.enabled);
        return;
      }
      if (!graph || ownerId !== current.metadata.id) {
        tearDown();
        ownerId = current.metadata.id;
        graphsBuilt += 1;
        graphOwner = `${ownerId}/${graphsBuilt}`;
        graph = new ProjectAudioGraph(runtime, graphOwner, {
          underrunMonitor: underrunMonitor(),
          onAssetLoadFailure: reportAssetLoadFailure,
        });
        stopWatchingClose ??= runtime.onContextClosed?.(handleContextClosed) ?? null;
        stopGraphTriggers = graph.watchTriggers(triggers.publish);
        metronome = new TransportMetronome(
          liveTransportEngine,
          graph.projectScope,
          graph.masterInput,
        );
        transport = new TransportController({ metronome });
        setMetronomeEnabled(false);
        lastProjection = undefined;
      }
      lastProjection = buildAudioProjection(current, lastProjection);
      reconcileGraph();
      attachPeakWatchers();
      // Mirror the song tempo and loop onto the transport without restarting
      // it: a tempo, range, or toggle edit re-times or re-bounds the running
      // transport in place (PRD AUD-02, LOOP-017).
      transport?.setTempo(current.song.tempo);
      transport?.mirrorLoop(current.song.loop);
      setLoop(transport?.loop ?? null);
      setLoopEnabled(current.song.loop.enabled);

      // `audio_loop` first-use (PRD OPS-02, INS-02): the first time a project
      // with a tempo-labelled loop clip is wired onto the audio graph. Fired
      // via `logFeatureFirstUse`, so it lands at most once per account per
      // browser even though the effect re-runs on every edit.
      if (current.clips.some((clip) => clip.content.kind === "audioLoop")) {
        analytics.logFeatureFirstUse("audio_loop");
      }
    },
  );

  /**
   * The browser closed the context under the editor (GRV-55): the output
   * device went away. Nothing can resume it, so playback stops here and the
   * producer is told at once, not on the next press of Play.
   */
  function handleContextClosed(): void {
    stop();
    const error = new Error("The audio context was closed by the browser.");
    error.name = "InvalidStateError";
    reportStartFailure(error);
    explainStartFailure(error);
  }

  onCleanup(() => {
    stopWatchingClose?.();
    stopWatchingClose = null;
    tearDown();
    triggers.dispose();
  });

  function startFrameLoop(): void {
    if (frameHandle !== null) return;
    const tick = (): void => {
      if (!transport) return;
      setPositionTicks(transport.positionTicks);
      levels.sample(graph?.readTrackLevels() ?? new Map());
      if (graph) masterLevel.sample(graph.readMasterLevel());
      meters.sample(graph?.sampleDeviceMeters() ?? new Map());
      if (transport.isPlaying) {
        frameHandle = requestFrame(tick);
      } else {
        frameHandle = null;
        levels.clear();
        masterLevel.clear();
        meters.rest();
      }
    };
    frameHandle = requestFrame(tick);
  }

  function stopFrameLoop(): void {
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
    levels.clear();
    masterLevel.clear();
    meters.rest();
  }

  /**
   * Awaits the runtime unlock, but rejects with an `autoplay_blocked`-coded
   * error if it does not settle within `resumeTimeoutMs`. Firefox under a
   * blocked autoplay policy never settles `Tone.start()`'s underlying
   * `context.resume()` (issue #43), so a bare `await runtime.resume()` would
   * hang forever: the `catch` below would never run, no `audio_start_failed`
   * would fire, and `setIsPlaying(true)` would never be reached — a dead play
   * button with no feedback. Racing a timeout turns that hang into the same
   * browser-blocked outcome a rejecting resume produces.
   */
  function resumeWithinTimeout(): Promise<void> {
    if (!audioAvailable) {
      return Promise.reject(
        new CodedError("not_supported", "This browser does not provide Web Audio."),
      );
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        reject(
          new CodedError(
            "autoplay_blocked",
            "Audio unlock timed out; the browser likely blocked autoplay.",
          ),
        );
      }, resumeTimeoutMs);
      runtime.resume().then(
        () => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          resolve();
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * The one start path, shared by `play()` and `continueFromStop()`: unlock the
   * context behind the user gesture, start the transport the caller asked for,
   * then report it. Both mappings are a "start playback" gesture, so both must
   * unlock and both emit exactly one `transport_play`.
   */
  async function startPlayback(
    startTransport: (controller: TransportController) => void,
  ): Promise<void> {
    try {
      // Resuming the shared context is the runtime's job; this call site is
      // the allowed user gesture that permits it (PRD AUD-07). The unlock is
      // bounded: a browser that never settles the resume is treated as a
      // blocked autoplay, not left to hang the play button forever (#43).
      await resumeWithinTimeout();
      if (transport) startTransport(transport);
      analytics.log("transport_play", {
        is_first_play_in_session: firstPlayInSession,
      });
      firstPlayInSession = false;
      setStartFailure(null);
      setIsPlaying(true);
      startFrameLoop();
    } catch (error) {
      reportStartFailure(error);
      explainStartFailure(error);
      setIsPlaying(false);
    }
  }

  /** One failed start, reported as `audio_start_failed` and to monitoring. */
  function reportStartFailure(error: unknown): void {
    const code = codeFor(error);
    // A closed context stays closed until the page reloads: one report, not
    // one per press of Play.
    if (code === "context_closed") {
      if (closeReported) return;
      closeReported = true;
    }
    analytics.log("audio_start_failed", {
      error_code: code,
      was_browser_blocked: code === "autoplay_blocked",
    });
    // The code, never the browser's own error: its message can name what
    // was playing, so monitoring gets a fixed one.
    report(new CodedError(code, "Audio could not start"), {
      area: "audio",
      fatal: false,
      code,
      context: { audio_context_state: audioContextState() },
    });
  }

  /**
   * Keeps a failed *playback* start for the editor to explain (#75). Only
   * Play and Continue do: an audition fails behind a click on a note or a pad,
   * mid-edit, and a notice arriving then would move the grid under the
   * pointer. The next press of Play explains it instead.
   */
  function explainStartFailure(error: unknown): void {
    startFailures += 1;
    setStartFailure({ code: codeFor(error), attempt: startFailures });
  }

  function play(): Promise<void> {
    return startPlayback((controller) => {
      // A play from the top starts the loudness programme over (#937).
      if (controller.atStart) {
        graph?.resetLoudness();
        meters.reset();
      }
      controller.play();
    });
  }

  function continueFromStop(): Promise<void> {
    return startPlayback((controller) => controller.continueFromStop());
  }

  function pause(): void {
    transport?.pause();
    setIsPlaying(false);
    stopFrameLoop();
  }

  function stop(): void {
    transport?.stop();
    setIsPlaying(false);
    stopFrameLoop();
    setPositionTicks(transport?.positionTicks ?? 0);
  }

  async function toggle(): Promise<void> {
    if (isPlaying()) {
      stop();
    } else {
      await play();
    }
  }

  function seekTicks(ticks: number): void {
    transport?.seekTicks(ticks);
    setPositionTicks(transport?.positionTicks ?? 0);
  }

  function toggleMetronome(): void {
    transport?.toggleMetronome();
    setMetronomeEnabled(transport?.metronomeEnabled ?? false);
  }

  async function auditionPad(trackId: TrackId, padId: PadId): Promise<void> {
    if (!graph) return;
    try {
      // The click is the allowed gesture to unlock the shared context; a
      // blocked/never-settling resume is swallowed rather than throwing into
      // the panel (a failed audition must never break editing — PRD OPS-02).
      await resumeWithinTimeout();
    } catch {
      return;
    }
    graph?.auditionPad(trackId, padId);
  }

  async function auditionTrack(
    trackId: TrackId,
    trigger: NoteTrigger,
    durationTicks: number,
    velocity: number,
  ): Promise<boolean> {
    try {
      await resumeWithinTimeout();
      graph?.auditionTrack(trackId, trigger, durationTicks, velocity);
      setStartFailure(null);
      return true;
    } catch (error) {
      reportStartFailure(error);
      return false;
    }
  }

  return {
    isPlaying,
    startFailure,
    loadFailure,
    positionTicks,
    loopEnabled,
    loop,
    metronomeEnabled,
    play,
    pause,
    stop,
    toggle,
    continueFromStop,
    seekTicks,
    trackLevel: levels.level,
    masterLevel: masterLevel.level,
    toggleMetronome,
    auditionPad,
    auditionTrack,
    previewInSlot,
    clearPreview,
    watchAssetPeaks,
    watchTriggers,
    readDeviceSpectrum: (deviceId) =>
      transport?.isPlaying ? (graph?.readDeviceSpectrum(deviceId) ?? null) : null,
    deviceMeter: meters.meter,
  };
}
