import * as Tone from "tone";
import type { Device, NoteTrigger } from "../domain/entities";
import type {
  AssetId,
  DeviceId,
  PadId,
  PlacementId,
  ReturnId,
  TrackId,
} from "../domain/ids";
import { SONG_TEMPO } from "../domain/parameters";
import { TICKS_PER_QUARTER } from "../domain/time";
import type {
  AudioAssetProjection,
  AudioClipProjection,
  AudioPlacementProjection,
  AudioSongProjection,
} from "../projection/audioProjection";
import {
  type AssetBufferLoader,
  AudioBufferCache,
  type AudioBufferCacheDiagnostics,
  type BufferLoadFailureListener,
  type BufferSubscription,
} from "./AudioBufferCache";
import type { AudioHost, AudioProjectScope } from "./AudioRuntime";
import { playAudioLoop } from "./audioLoopPlayer";
import type {
  DeviceMeterReading,
  DeviceNode,
  DeviceNodeFactory,
  SpectrumReading,
} from "./DeviceChain";
import { createDeviceNodeFactory } from "./devices";
import type { InstrumentNodeFactory } from "./InstrumentGraph";
import {
  type LatencyCompensationPlan,
  planLatencyCompensation,
} from "./latencyCompensation";
import type { LevelReading } from "./levels";
import { MasterAudioGraph } from "./MasterAudioGraph";
import { ReturnAudioGraph } from "./ReturnAudioGraph";
import type { ResourceHandle } from "./resourceRegistry";
import {
  audioLoopDurationSeconds,
  audioLoopOffsetSeconds,
  computePlacementSchedule,
  ticksToToneTime,
} from "./scheduling";
import { SummingBus } from "./summingBus";
import { TrackAudioGraph } from "./TrackAudioGraph";
import { toneBufferLoader } from "./toneBufferLoader";
import type { UnderrunMonitor } from "./underrun";
import { cachedPeaksOf } from "./waveformPeaks";

/**
 * The transport this graph schedules against. An interface rather than a
 * direct `Tone.getTransport()` reference so scheduling can be reconciled and
 * tested (owner-tracked handles, no leaked/duplicate schedules) without a
 * real Tone context (PRD AUD-03/AUD-08).
 */
export interface AudioTransport {
  bpm: { value: number };
  schedule(callback: (time: number) => void, time: string): number;
  clear(id: number): void;
  /**
   * Subscribe to the transport halting at `time` (audio-clock seconds), as
   * `Tone.Transport` emits `"stop"` and `"pause"`. Sounding loop players are
   * cut off at that time (issue #383). Optional so a test double that never
   * stops need not implement it; the live transport always does.
   */
  on?(event: TransportHaltEvent, callback: (time: number) => void): void;
  off?(event: TransportHaltEvent, callback: (time: number) => void): void;
}

/** The transport events after which no arrangement audio may keep sounding. */
export type TransportHaltEvent = "stop" | "pause";

const TRANSPORT_HALT_EVENTS: readonly TransportHaltEvent[] = ["stop", "pause"];

const liveTransport: AudioTransport = {
  get bpm() {
    return Tone.getTransport().bpm;
  },
  schedule(callback, time) {
    return Tone.getTransport().schedule(callback, time);
  },
  clear(id) {
    Tone.getTransport().clear(id);
  },
  on(event, callback) {
    Tone.getTransport().on(event, callback);
  },
  off(event, callback) {
    Tone.getTransport().off(event, callback);
  },
};

/**
 * The audio clock the underrun monitor compares a scheduled event's intended
 * time against: the context's *true* current time, not `Tone.now()`.
 *
 * This distinction is the whole measurement. `Tone.now()` is
 * `currentTime + lookAhead` (default 0.1s), and Tone's `Clock._loop` dispatches
 * every event whose time falls in `(lastUpdate, Tone.now()]` — so inside a
 * scheduled callback, `Tone.now() >= intendedTime` *always*, on perfectly
 * healthy playback. Comparing against it would count most events as drops and
 * turn `audio_underrun` into per-note telemetry, exactly what PRD OPS-02
 * forbids. `immediate()` is `currentTime`, which at dispatch sits a whole
 * lookahead window (50-100ms with Tone's defaults) *before* the intended time
 * and only passes it on a genuinely late dispatch.
 */
export function audioClockNow(): number {
  return Tone.getContext().immediate();
}

/** One instrument trigger, reported as it is scheduled (#447). */
export type TriggerWatcher = (
  trackId: TrackId,
  trigger: NoteTrigger,
  delaySeconds: number,
) => void;

export interface ProjectAudioGraphOptions {
  transport?: AudioTransport;
  bufferLoader?: AssetBufferLoader<Tone.ToneAudioBuffer>;
  createInstrument?: InstrumentNodeFactory;
  createDeviceNode?: DeviceNodeFactory;
  /**
   * Sampled scheduling-underrun monitor (PRD AUD-03/OPS-02). Each scheduled
   * callback reports its (intended, actual) audio time to this, so a late
   * dispatch is detected and sampled rather than emitting per-event telemetry.
   * Optional: without it, scheduling behaves identically but underruns are not
   * measured.
   */
  underrunMonitor?: UnderrunMonitor;
  /** The current audio time, in seconds. Defaults to {@link audioClockNow};
   * injectable for tests. */
  now?: () => number;
  /**
   * Called when a loop or sample asset fails to decode or is missing, so the
   * owner can emit `asset_load_failed` (PRD OPS-02, LOOP-006). Fired once per
   * failed load attempt; a stale-generation failure is never reported.
   */
  onAssetLoadFailure?: BufferLoadFailureListener;
  /**
   * Every track feeds only its sends: its direct output goes to a sink that
   * reaches nothing, so only the returns sound. A return's stem is rendered
   * this way (EXP-003); live playback never sets it.
   */
  tracksSendOnly?: boolean;
}

/** Everything scheduled for one placement, so a later reconcile pass can tell
 * whether it needs to be re-derived (placement, clip, or tempo changed) or
 * left alone, and can release exactly this placement's handles either way. */
interface PlacementScheduleEntry {
  placementRef: AudioPlacementProjection;
  clipRef: AudioClipProjection;
  tempo: number;
  swing: number;
  handles: ResourceHandle[];
}

/**
 * The audio engine's stable, ID-keyed project graph (PRD AUD-03, AUD-08;
 * section 9.7). Owns the master bus, return buses, track graphs, the asset
 * buffer cache, and the arrangement's transport schedule, all reconciled from
 * a read-only {@link AudioSongProjection} instead of rebuilt from a mutable
 * project object. Replacing this graph (e.g. opening a different project)
 * leaves the {@link AudioRuntime}'s shared context and transport intact.
 */
export class ProjectAudioGraph {
  private readonly scope: AudioProjectScope;
  private readonly transport: AudioTransport;
  private readonly bufferCache: AudioBufferCache<Tone.ToneAudioBuffer>;
  private readonly master: MasterAudioGraph;
  /** Where every track's direct output goes: the master's mix, or with
   * `tracksSendOnly` a bus connected to nothing. */
  private readonly trackDestination: SummingBus;
  private readonly returns = new Map<ReturnId, ReturnAudioGraph>();
  private readonly tracks = new Map<TrackId, TrackAudioGraph>();
  private readonly placementSchedules = new Map<PlacementId, PlacementScheduleEntry>();
  private readonly createInstrument?: InstrumentNodeFactory;
  private readonly createDeviceNode?: DeviceNodeFactory;
  private readonly underrunMonitor?: UnderrunMonitor;
  private readonly now: () => number;
  /**
   * One persistent map, mutated in place every reconcile rather than
   * replaced. Track/instrument graphs are constructed once and capture a
   * reference to this same map; if it were rebuilt fresh each reconcile,
   * every already-constructed graph would keep looking up assets in a
   * stale, ever-older snapshot instead of the current asset list.
   */
  private readonly assetsById = new Map<AssetId, AudioAssetProjection>();
  private lastProjection: AudioSongProjection | null = null;
  private compensation: LatencyCompensationPlan | null = null;
  /**
   * The tempo of the projection currently being reconciled, set at the *top* of
   * `reconcile()` — before any child graph runs — so a device reading it during
   * `apply()` sees the tempo it is being reconciled *to*.
   *
   * Deliberately not derived from `lastProjection`: that is only assigned at the
   * end of `reconcile()`, so a device built or updated mid-pass would read the
   * *previous* pass's tempo, and the very first pass would read nothing at all
   * and fall back to the 120 BPM default — silently building every synced delay
   * in a 90 BPM project on a 120 BPM grid.
   */
  private currentTempo: number = SONG_TEMPO.defaultValue;
  /**
   * Loop players currently sounding (or scheduled to). A loop player is
   * started against the audio clock with its stop already scheduled at the end
   * of its event, so stopping the transport alone would let it play out the
   * rest of its span; the graph stops these itself when the transport halts.
   */
  private readonly activeLoopPlayers = new Set<Tone.Player | Tone.GrainPlayer>();
  private readonly onTransportHalt = (time: number): void => {
    for (const player of this.activeLoopPlayers) player.stop(time);
    this.activeLoopPlayers.clear();
  };
  private disposed = false;
  private readonly triggerWatchers = new Set<TriggerWatcher>();

  constructor(
    private readonly runtime: AudioHost,
    ownerId: string,
    options: ProjectAudioGraphOptions = {},
  ) {
    this.scope = runtime.openProjectScope(ownerId);
    this.transport = options.transport ?? liveTransport;
    this.bufferCache = new AudioBufferCache(options.bufferLoader ?? toneBufferLoader, {
      onLoadFailure: options.onAssetLoadFailure,
    });
    this.createInstrument = options.createInstrument;
    // The six core processing devices (PRD FX-01, LOOP-009). A test may
    // substitute its own factory; production always gets the real DSP. The
    // tempo reader returns the tempo of the projection being reconciled right
    // now (see `currentTempo`), and `reconcile` forces a device re-apply when
    // the tempo moved, so a tempo-synced delay follows a tempo change without
    // the graph rebuilding anything.
    this.createDeviceNode =
      options.createDeviceNode ??
      createDeviceNodeFactory({
        scope: this.scope,
        tempo: () => this.currentTempo,
      });
    this.underrunMonitor = options.underrunMonitor;
    this.now = options.now ?? audioClockNow;
    for (const event of TRANSPORT_HALT_EVENTS) {
      this.transport.on?.(event, this.onTransportHalt);
    }
    this.master = new MasterAudioGraph(
      this.scope,
      this.runtime.getDestination(),
      this.createDeviceNode,
    );
    if (options.tracksSendOnly) {
      const sink = new SummingBus();
      this.scope.register("node", () => {
        sink.dispose();
      });
      this.trackDestination = sink;
    } else {
      this.trackDestination = this.master.mix;
    }
  }

  /** Read access for tests and diagnostics; not part of the reconciliation contract. */
  get trackGraphs(): ReadonlyMap<TrackId, TrackAudioGraph> {
    return this.tracks;
  }

  /** The master bus's peak meter, for a level display (PRD AUD-04). */
  get masterMeter(): Tone.Meter {
    return this.master.levelMeter;
  }

  /**
   * A track's post-fader peak meter, or `undefined` if no such track is in the
   * graph (PRD TRK-02). The mixer polls this for a per-track level display.
   */
  trackMeter(trackId: TrackId): Tone.Meter | undefined {
    return this.tracks.get(trackId)?.levelMeter;
  }

  /**
   * What is leaving one device now, wherever it sits — a track's inserts, a
   * return's or the master's — for a panel that draws it (the EQ, LOOP-022).
   * `null` when no device has that id, or the device draws no spectrum.
   */
  readDeviceSpectrum(deviceId: DeviceId): SpectrumReading | null {
    // Read every frame while the EQ is on screen, so it walks the owners in
    // place rather than building a list of them each time.
    let node = this.master.deviceNode(deviceId);
    for (const track of this.tracks.values()) node ??= track.deviceNode(deviceId);
    for (const bus of this.returns.values()) node ??= bus.deviceNode(deviceId);
    return node?.readSpectrum?.() ?? null;
  }

  /**
   * One frame of every metering device's readouts — the Limiter's gain
   * reduction and loudness (#937) — wherever it sits, keyed by device id.
   * The editor calls it from its frame loop while the transport plays, and
   * that is what feeds the loudness meters, so it is read in place.
   */
  sampleDeviceMeters(): Map<DeviceId, DeviceMeterReading> {
    const readings = new Map<DeviceId, DeviceMeterReading>();
    this.forEachDeviceNode((device, node) => {
      if (!node.sampleLoudness) return;
      readings.set(device.id, {
        ...node.sampleLoudness(),
        gainReductionDb: device.bypassed ? 0 : (node.gainReductionDb?.() ?? 0),
      });
    });
    return readings;
  }

  /** Starts every loudness meter's programme over, for a play from the top. */
  resetLoudness(): void {
    this.forEachDeviceNode((_device, node) => node.resetLoudness?.());
  }

  private forEachDeviceNode(visit: (device: Device, node: DeviceNode) => void): void {
    const projection = this.lastProjection;
    if (!projection) return;
    const walk = (
      devices: readonly Device[],
      find: (id: DeviceId) => DeviceNode | undefined,
    ) => {
      for (const device of devices) {
        const node = find(device.id);
        if (node) visit(device, node);
      }
    };
    walk(projection.master.devices, (id) => this.master.deviceNode(id));
    for (const track of projection.tracks) {
      walk(track.devices, (id) => this.tracks.get(track.id)?.deviceNode(id));
    }
    for (const bus of projection.returns) {
      walk(bus.devices, (id) => this.returns.get(bus.id)?.deviceNode(id));
    }
  }

  /** Every track's level now, for one frame of the editor's meters (#447). */
  readTrackLevels(): Map<TrackId, LevelReading> {
    const readings = new Map<TrackId, LevelReading>();
    for (const [trackId, track] of this.tracks) readings.set(trackId, track.readLevel());
    return readings;
  }

  /** The master's level now, for the Mixer's master meter (GRV-44). */
  readMasterLevel(): LevelReading {
    return this.master.readLevel();
  }

  /**
   * The project disposal scope, so a session-scoped companion (e.g. the
   * transport metronome) can register its resources under the same owner and
   * be torn down when the project graph is disposed.
   */
  get projectScope(): AudioProjectScope {
    return this.scope;
  }

  /** The master bus input — where an auxiliary source (the metronome) taps in
   * so it too passes through the safety limiter (PRD AUD-04). */
  get masterInput(): Tone.ToneAudioNode {
    return this.master.input;
  }

  /** The master bus's subgraph. For tests and diagnostics. */
  get masterGraph(): MasterAudioGraph {
    return this.master;
  }

  get returnGraphs(): ReadonlyMap<ReturnId, ReturnAudioGraph> {
    return this.returns;
  }

  /**
   * Plays one note through a track's instrument right now, for auditioning a
   * sound while editing it (PRD INS-01). It routes through the track's own
   * device chain and channel strip, so what a user hears is what the track
   * sounds like — it is not a bypassed preview. A no-op for an unknown track or
   * one with nothing loaded. The caller resumes the shared context first (the
   * audition button is a user gesture); this only schedules the trigger.
   */
  auditionTrack(
    trackId: TrackId,
    trigger: NoteTrigger,
    durationTicks: number,
    velocity: number,
  ): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    const now = this.now();
    track.trigger(trigger, now, ticksToToneTime(durationTicks), velocity);
    this.reportTrigger(trackId, trigger, now);
  }

  diagnostics(): {
    tracks: number;
    returns: number;
    scheduledPlacements: number;
    buffers: AudioBufferCacheDiagnostics;
  } {
    return {
      tracks: this.tracks.size,
      returns: this.returns.size,
      scheduledPlacements: this.placementSchedules.size,
      buffers: this.bufferCache.diagnostics(),
    };
  }

  /**
   * Reconciles this graph against `next`. Passing the exact projection
   * object the audio projection handed back last time is a complete no-op —
   * every entry within it that is itself unchanged (by reference) is
   * likewise skipped, so an edit to one track, return, or placement never
   * touches any other entity's nodes or schedule.
   */
  reconcile(next: AudioSongProjection): void {
    if (this.lastProjection === next) return;

    this.assetsById.clear();
    for (const asset of next.assets) {
      this.assetsById.set(asset.id, asset);
      this.bufferCache.refresh(asset);
    }

    this.transport.bpm.value = next.tempo;

    // Tempo must be visible to every device built or updated below *before*
    // any of them run, and a tempo change has to survive the per-entity
    // reference short-circuits: a tempo-only edit leaves every track, return,
    // and master projection reference-identical, so nothing else in this pass
    // would reach a synced delay's `apply()` (PRD FX-01).
    const tempoChanged =
      this.lastProjection !== null && this.lastProjection.tempo !== next.tempo;
    this.currentTempo = next.tempo;

    this.master.reconcile(next.master, tempoChanged);
    this.syncReturns(next, tempoChanged);

    const anySolo = next.tracks.some((track) => track.mixer.soloed);
    this.syncTracks(next, anySolo, tempoChanged);

    // Returns no longer referenced are only safe to dispose once no track
    // send still targets them — i.e. after `syncTracks` above.
    this.pruneReturns(next);

    this.applyLatencyCompensation(next);

    this.syncSchedule(next);

    this.lastProjection = next;
  }

  /**
   * The plugin delay compensation this graph last applied (#883): how far
   * each path is held back, and how late the whole song reaches the output.
   * The offline renderer plans the same figures from the same projection to
   * drop that lateness from a file's front.
   */
  get latencyCompensation(): LatencyCompensationPlan | null {
    return this.compensation;
  }

  /**
   * Re-aligns every path to the slowest (see `latencyCompensation.ts`). Each
   * path's delay only moves when its own figure does, and moves by a ramp, so
   * adding a compressor to one track glides the others into step without a
   * click and without rebuilding or reconnecting any of them.
   */
  private applyLatencyCompensation(next: AudioSongProjection): void {
    const plan = planLatencyCompensation(next, this.runtime.getSampleRate());
    for (const [id, graph] of this.tracks) {
      graph.setLatencyCompensation(plan.tracks.get(id) ?? 0, plan.trackOutputFrames);
    }
    for (const [id, graph] of this.returns) {
      graph.setLatencyCompensation(plan.returns.get(id) ?? 0);
    }
    this.master.setLatencyCompensation(plan.mixFrames);
    this.compensation = plan;
  }

  /**
   * Plays one pad on a track right now, off the transport — the audition a
   * drum-machine panel fires when the user clicks a pad (PRD INS-01). It reuses
   * the same instrument node the arrangement drives, so choke groups,
   * mute/solo, pitch, pan, and envelope behave exactly as they will in
   * playback. A no-op if the track has no instrument or the pad's sample has
   * not decoded yet.
   */
  auditionPad(trackId: TrackId, padId: PadId, velocity = 0.9): void {
    if (this.disposed) return;
    const track = this.tracks.get(trackId);
    if (!track) return;
    const now = this.now();
    track.trigger(
      { kind: "pad", padId },
      now,
      ticksToToneTime(TICKS_PER_QUARTER),
      velocity,
    );
    this.reportTrigger(trackId, { kind: "pad", padId }, now);
  }

  /**
   * Follows every trigger the graph sends an instrument, scheduled or
   * auditioned, so the editor can show what is playing (#447). `delaySeconds`
   * is how far ahead of the audio clock the trigger was scheduled: a watcher
   * that waits that long before drawing lights up as the sound is heard, not
   * a look-ahead early. Returns the way to stop.
   */
  watchTriggers(watcher: TriggerWatcher): () => void {
    this.triggerWatchers.add(watcher);
    return () => this.triggerWatchers.delete(watcher);
  }

  private reportTrigger(trackId: TrackId, trigger: NoteTrigger, time: number): void {
    if (this.triggerWatchers.size === 0) return;
    const delaySeconds = Math.max(0, time - this.now());
    for (const watcher of this.triggerWatchers) watcher(trackId, trigger, delaySeconds);
  }

  private syncReturns(next: AudioSongProjection, tempoChanged: boolean): void {
    for (const returnProjection of next.returns) {
      let graph = this.returns.get(returnProjection.id);
      if (!graph) {
        graph = new ReturnAudioGraph(
          returnProjection.id,
          this.scope,
          this.master.mix,
          this.createDeviceNode,
        );
        this.returns.set(returnProjection.id, graph);
      }
      graph.reconcile(returnProjection, tempoChanged);
    }
  }

  private pruneReturns(next: AudioSongProjection): void {
    for (const [id, graph] of this.returns) {
      if (!next.returnsById.has(id)) {
        graph.dispose();
        this.returns.delete(id);
      }
    }
  }

  private syncTracks(
    next: AudioSongProjection,
    anySolo: boolean,
    tempoChanged: boolean,
  ): void {
    for (const [id, graph] of this.tracks) {
      if (!next.tracksById.has(id)) {
        graph.dispose();
        this.tracks.delete(id);
      }
    }

    for (const trackProjection of next.tracks) {
      let graph = this.tracks.get(trackProjection.id);
      if (!graph) {
        graph = new TrackAudioGraph(
          trackProjection.id,
          {
            scope: this.scope,
            assetsById: this.assetsById,
            bufferCache: this.bufferCache,
            getReturnInput: (returnId) => this.returns.get(returnId)?.input,
            createInstrument: this.createInstrument,
            createDeviceNode: this.createDeviceNode,
          },
          this.trackDestination,
        );
        this.tracks.set(trackProjection.id, graph);
      }
      const effectiveMuted =
        trackProjection.mixer.muted || (anySolo && !trackProjection.mixer.soloed);
      graph.reconcile(trackProjection, effectiveMuted, tempoChanged);
    }
  }

  private syncSchedule(next: AudioSongProjection): void {
    const nextIds = new Set(next.placements.map((placement) => placement.id));

    for (const [id, entry] of this.placementSchedules) {
      if (!nextIds.has(id)) {
        this.releaseSchedule(entry);
        this.placementSchedules.delete(id);
      }
    }

    for (const placement of next.placements) {
      const clip = next.clipsById.get(placement.clipId);
      if (!clip) continue; // domain invariants forbid a dangling clip reference; defensive only

      const existing = this.placementSchedules.get(placement.id);
      if (
        existing &&
        existing.placementRef === placement &&
        existing.clipRef === clip &&
        existing.tempo === next.tempo &&
        existing.swing === next.swing
      ) {
        continue;
      }
      if (existing) this.releaseSchedule(existing);

      const entry: PlacementScheduleEntry = {
        placementRef: placement,
        clipRef: clip,
        tempo: next.tempo,
        swing: next.swing,
        handles: [],
      };
      this.scheduleNotesAndLoops(placement, clip, next.tempo, next.swing, entry);
      this.placementSchedules.set(placement.id, entry);
    }
  }

  private scheduleNotesAndLoops(
    placement: AudioPlacementProjection,
    clip: AudioClipProjection,
    tempo: number,
    swing: number,
    entry: PlacementScheduleEntry,
  ): void {
    const { notes, audioLoops } = computePlacementSchedule(placement, clip, tempo, swing);

    for (const note of notes) {
      const scheduleId = this.transport.schedule((time) => {
        this.underrunMonitor?.observe(time, this.now());
        this.tracks
          .get(note.trackId)
          ?.trigger(
            note.trigger,
            time,
            ticksToToneTime(note.durationTicks),
            note.velocity,
          );
        this.reportTrigger(note.trackId, note.trigger, time);
      }, ticksToToneTime(note.absoluteTicks));
      entry.handles.push(
        this.scope.register("schedule", () => this.transport.clear(scheduleId)),
      );
    }

    for (const loop of audioLoops) {
      const bufferBox: { current: Tone.ToneAudioBuffer | null } = {
        current: null,
      };
      const asset = this.assetsById.get(loop.assetId);
      if (asset) {
        entry.handles.push(this.subscribeAudioLoopAsset(asset, bufferBox));
      }
      const offsetSeconds = audioLoopOffsetSeconds(loop, tempo);
      const durationSeconds = audioLoopDurationSeconds(loop, tempo);
      const scheduleId = this.transport.schedule((time) => {
        this.underrunMonitor?.observe(time, this.now());
        const track = this.tracks.get(loop.trackId);
        if (track && bufferBox.current) {
          const player = playAudioLoop(bufferBox.current, {
            destination: track.audioInput,
            time,
            durationSeconds,
            playbackRate: loop.playbackRate,
            offsetSeconds,
          });
          if (player) this.trackLoopPlayer(player);
        }
      }, ticksToToneTime(loop.absoluteTicks));
      entry.handles.push(
        this.scope.register("schedule", () => this.transport.clear(scheduleId)),
      );
    }
  }

  /** Holds a started loop player until it stops, so a transport halt can cut it. */
  private trackLoopPlayer(player: Tone.Player | Tone.GrainPlayer): void {
    this.activeLoopPlayers.add(player);
    const disposeOnStop = player.onstop;
    player.onstop = (source) => {
      this.activeLoopPlayers.delete(player);
      disposeOnStop(source);
    };
  }

  private subscribeAudioLoopAsset(
    asset: AudioAssetProjection,
    bufferBox: { current: Tone.ToneAudioBuffer | null },
  ): ResourceHandle {
    const subscription: BufferSubscription = this.bufferCache.subscribe(
      asset,
      (buffer) => {
        bufferBox.current = buffer;
      },
    );
    return this.scope.register("subscription", () => subscription.release());
  }

  /**
   * Follows the waveform of one asset for a drawing (#447): `onPeaks` gets its
   * peaks each time the buffer this graph decoded for it arrives or changes,
   * and `null` while there is none. It shares the graph's buffer cache, so a
   * sound already loaded to play is not decoded again to be drawn.
   */
  watchAssetPeaks(
    asset: AudioAssetProjection,
    buckets: number,
    onPeaks: (peaks: Float32Array | null) => void,
  ): BufferSubscription {
    return this.bufferCache.subscribe(asset, (buffer) =>
      onPeaks(buffer ? cachedPeaksOf(buffer, buckets) : null),
    );
  }

  private releaseSchedule(entry: PlacementScheduleEntry): void {
    for (const handle of entry.handles) void this.scope.release(handle);
  }

  /**
   * Tears down every track, return, and the master bus, clears the
   * arrangement schedule, and releases the buffer cache. Safe to call more
   * than once; the runtime/context and any other project graph are
   * untouched (PRD AUD-07).
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.triggerWatchers.clear();

    for (const event of TRANSPORT_HALT_EVENTS) {
      this.transport.off?.(event, this.onTransportHalt);
    }
    this.onTransportHalt(this.now());

    for (const [, entry] of this.placementSchedules) {
      this.releaseSchedule(entry);
    }
    this.placementSchedules.clear();

    for (const [, graph] of this.tracks) graph.dispose();
    this.tracks.clear();

    for (const [, graph] of this.returns) graph.dispose();
    this.returns.clear();

    this.master.dispose();
    this.bufferCache.dispose();

    await this.scope.dispose();
  }
}
