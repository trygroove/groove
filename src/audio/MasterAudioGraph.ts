import * as Tone from "tone";
import type { DeviceId } from "../domain/ids";
import type { AudioMasterProjection } from "../projection/audioProjection";
import type { AudioProjectScope } from "./AudioRuntime";
import { CompensationDelay } from "./compensationDelay";
import { DeviceChain, type DeviceNode, type DeviceNodeFactory } from "./DeviceChain";
import { type DeclaredLatency, dynamicsLookaheadFrames } from "./latency";
import { type LevelReading, loudestDb, peakDbOf } from "./levels";
import { SummingBus } from "./summingBus";

/**
 * The transparent safety limiter's threshold, in dBFS (PRD AUD-04). Only a
 * project made before the Limiter device (#937) runs it: a new project has a
 * visible Limiter on its master chain instead (`master.safetyLimiter`). It sits
 * just under 0 dBFS so ordinary, already-safe material passes through
 * unaffected while genuinely dangerous or clipped peaks are caught before they
 * reach the output device. It is deliberately *not* a creative or
 * loudness-normalizing stage — `DEC-004` requires export to preserve project
 * gain exactly, and this same limiter is all AUD-05/AUD-06 keep in the master
 * path for that reason.
 */
export const MASTER_LIMITER_THRESHOLD_DB = -0.5;

/** Samples per channel the master's peak tap holds: one frame's worth, as a track's. */
const MASTER_PEAK_WINDOW = 1024;

/**
 * How many frames the safety limiter delays everything by (EXP-001, #883).
 * `Tone.Limiter` is a `DynamicsCompressorNode`, so it holds the signal back by
 * the engine's compressor lookahead. Live that is an imperceptible lag behind
 * the playhead; an offline render drops it from the front, with the rest of
 * the song's latency (`latencyCompensation.ts`), so bar 1 is the file's first
 * frame. Declared, like every device's latency, not measured.
 */
export const masterLimiterLatencyFrames: DeclaredLatency = dynamicsLookaheadFrames;

/**
 * The master bus's audio subgraph (PRD AUD-08, section 9.7): an ordered
 * device chain, a volume stage, a metering tap, and — for a project whose
 * master keeps it (#937) — a transparent safety limiter (PRD AUD-04),
 * connected to the runtime's shared destination.
 *
 * The order depends on that choice. With the safety limiter, it is
 * `mix -> chain -> volume -> limiter`, exactly as every project made before
 * #937 has always sounded. Without it, the volume comes first,
 * `mix -> volume -> chain`: the chain's trailing Limiter is then the last
 * thing the signal meets, so raising the master fader (up to +6 dB) drives
 * into the Limiter rather than past it, and the Limiter's own loudness
 * readout is of what plays and exports.
 * There is exactly one of these per {@link ProjectAudioGraph} and it is never
 * rebuilt for a routine edit — only its device chain and volume are reconciled
 * in place, so a parameter edit never restarts the transport or reconstructs
 * the meter/limiter.
 */
export class MasterAudioGraph {
  /** Every track and return, summed in order (#867). */
  readonly mix: SummingBus;
  private readonly mixHandle: ReturnType<AudioProjectScope["register"]>;
  private readonly deviceChain: DeviceChain;
  /** Holds an auxiliary source (the metronome) back by the mix's plugin
   * delay compensation, so it stays on the beat the tracks are on (#883). */
  private readonly auxAlign: CompensationDelay;
  private readonly auxAlignHandle: ReturnType<AudioProjectScope["register"]>;
  private readonly volume: Tone.Volume;
  private readonly meter: Tone.Meter;
  /** The samples the meter hears, for the clip state (GRV-44), as a track's. */
  private readonly peakTap: Tone.Analyser;
  private readonly limiter: Tone.Limiter;
  private readonly volumeHandle: ReturnType<AudioProjectScope["register"]>;
  private readonly meterHandle: ReturnType<AudioProjectScope["register"]>;
  private readonly peakTapHandle: ReturnType<AudioProjectScope["register"]>;
  private readonly limiterHandle: ReturnType<AudioProjectScope["register"]>;
  private lastProjection: AudioMasterProjection | null = null;
  /** Whether the volume stage feeds the safety limiter or the output directly. */
  private limited = true;
  private readonly destination: Tone.ToneAudioNode;
  private disposed = false;

  constructor(
    private readonly scope: AudioProjectScope,
    destination: Tone.ToneAudioNode,
    createDeviceNode?: DeviceNodeFactory,
  ) {
    this.destination = destination;
    this.mix = new SummingBus();
    this.mixHandle = scope.register("node", () => {
      this.mix.dispose();
    });
    this.deviceChain = new DeviceChain(scope, createDeviceNode);
    this.auxAlign = new CompensationDelay();
    this.auxAlignHandle = scope.register("node", () => {
      this.auxAlign.dispose();
    });
    this.volume = new Tone.Volume(0);
    this.volumeHandle = scope.register("node", () => {
      this.volume.dispose();
    });
    // A peak meter, so a browser test or diagnostic can observe output level
    // without adding a per-frame analytics event (PRD AUD-04/OPS-02).
    this.meter = new Tone.Meter();
    this.meterHandle = scope.register("node", () => {
      this.meter.dispose();
    });
    // The master meter's clip state (GRV-44) reads the samples themselves, as a
    // track's does (#447): an RMS meter smooths the peaks a clip is made of.
    this.peakTap = new Tone.Analyser({
      type: "waveform",
      size: MASTER_PEAK_WINDOW,
      channels: 2,
    });
    this.peakTapHandle = scope.register("node", () => {
      this.peakTap.dispose();
    });
    // The transparent safety limiter is the last stage before the shared
    // destination, so nothing after it can push a dangerous peak to the
    // hardware (PRD AUD-04).
    this.limiter = new Tone.Limiter(MASTER_LIMITER_THRESHOLD_DB);
    this.limiterHandle = scope.register("node", () => {
      this.limiter.dispose();
    });

    // mix -> deviceChain -> volume -> limiter -> destination, with the meter
    // tapping the limited signal (a fan-out, not an insert, so it cannot
    // colour it). Without the safety limiter, see `routeLimiter`.
    this.mix.output.connect(this.deviceChain.input);
    this.auxAlign.node.connect(this.deviceChain.input);
    this.deviceChain.output.connect(this.volume);
    this.volume.connect(this.limiter);
    this.limiter.connect(this.meter);
    this.limiter.connect(this.peakTap);
    this.limiter.connect(destination);
  }

  /**
   * Puts the safety limiter in the path or takes it out (#937). The nodes
   * live either way, so this is a reconnection, never a rebuild; in practice
   * a project's choice never changes while it is open.
   *
   * Without it the volume moves ahead of the device chain
   * (`mix -> volume -> chain -> meter/destination`), so nothing after the
   * chain's last device can lift a peak past that device's ceiling. Neither
   * stage adds latency, so the order changes nothing about compensation.
   */
  private routeLimiter(limited: boolean): void {
    if (limited === this.limited) return;
    this.limited = limited;
    const sources = [this.mix.output, this.auxAlign.node];
    if (limited) {
      for (const source of sources) source.disconnect(this.volume);
      this.volume.disconnect(this.deviceChain.input);
      this.deviceChain.output.disconnect(this.meter);
      this.deviceChain.output.disconnect(this.peakTap);
      this.deviceChain.output.disconnect(this.destination);
      for (const source of sources) source.connect(this.deviceChain.input);
      this.deviceChain.output.connect(this.volume);
      this.volume.connect(this.limiter);
    } else {
      for (const source of sources) source.disconnect(this.deviceChain.input);
      this.deviceChain.output.disconnect(this.volume);
      this.volume.disconnect(this.limiter);
      for (const source of sources) source.connect(this.volume);
      this.volume.connect(this.deviceChain.input);
      this.deviceChain.output.connect(this.meter);
      this.deviceChain.output.connect(this.peakTap);
      this.deviceChain.output.connect(this.destination);
    }
  }

  /** Whether the safety limiter is in the master path. For tests and diagnostics. */
  get safetyLimited(): boolean {
    return this.limited;
  }

  /** Where an auxiliary source (the metronome) connects, beside {@link mix}
   * and delayed to match it: a track or a return joins the mix instead. */
  get input(): Tone.ToneAudioNode {
    return this.auxAlign.node;
  }

  /** Delays the auxiliary input by the frames every compensated path takes to
   * reach the mix (`LatencyCompensationPlan.mixFrames`). */
  setLatencyCompensation(mixFrames: number): void {
    this.auxAlign.set(mixFrames);
  }

  /** The frames the auxiliary input is held back by. For tests and diagnostics. */
  get latencyCompensationFrames(): number {
    return this.auxAlign.compensationFrames;
  }

  /**
   * The master peak meter. Callers poll it for a level display; it is never
   * the source of an analytics event, so metering adds no per-frame telemetry.
   */
  get levelMeter(): Tone.Meter {
    return this.meter;
  }

  /**
   * What the master meter on the Mixer shows (GRV-44): the mix's RMS now and
   * its latest peak, read where the mix leaves for the speakers, after
   * everything on the master. As a track's reading, it is polled by the
   * editor's frame loop and never sources an analytics event.
   */
  readLevel(): LevelReading {
    const samples = this.peakTap.getValue();
    return {
      rmsDb: loudestDb(this.meter.getValue()),
      peakDb: peakDbOf(Array.isArray(samples) ? samples : [samples]),
    };
  }

  /**
   * `reapplyDevices` reports that state outside the master projection moved
   * (the song tempo, which a synced delay resolves against) and so must survive
   * the reference short-circuit — otherwise a tempo-only edit, which leaves this
   * projection reference-identical, would never reach the device chain.
   */
  reconcile(next: AudioMasterProjection, reapplyDevices = false): void {
    if (this.lastProjection === next) {
      if (reapplyDevices) this.deviceChain.reconcile(next.devices, true);
      return;
    }
    this.deviceChain.reconcile(next.devices, reapplyDevices);
    this.volume.volume.rampTo(next.volume, 0.02);
    this.routeLimiter(next.safetyLimiter);
    this.lastProjection = next;
  }

  /** The live node for one of this bus's devices, for a panel readout. */
  deviceNode(id: DeviceId): DeviceNode | undefined {
    return this.deviceChain.deviceNode(id);
  }

  /** Tears down every node the master bus owns. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.scope.release(this.mixHandle);
    this.deviceChain.dispose();
    void this.scope.release(this.auxAlignHandle);
    void this.scope.release(this.volumeHandle);
    void this.scope.release(this.meterHandle);
    void this.scope.release(this.peakTapHandle);
    void this.scope.release(this.limiterHandle);
  }
}
