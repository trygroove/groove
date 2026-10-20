import * as Tone from "tone";
import { PPQ, TICKS_PER_BAR, TICKS_PER_QUARTER } from "../domain/time";
import type { AudioProjectScope } from "./AudioRuntime";
import type { LoopRange, SongLoopState } from "./loopRange";
import { ticksToToneTime } from "./scheduling";

export {
  barAlignedLoop,
  type LoopRange,
  loopOfBars,
  type SongLoopState,
} from "./loopRange";

/**
 * The transport layer (PRD AUD-01/AUD-02, section 9.7).
 *
 * Dependable play/pause/stop/seek, tempo, a bar-aligned arrangement loop, and
 * a metronome all sit on top of the one shared `Tone.Transport`. The transport
 * is *not* project state — it is a session-scoped playhead over the arrangement
 * `ProjectAudioGraph` schedules, in the same category as selection. Tempo and
 * the loop are the exceptions: they live in the song (`parameter.set` writes
 * `song.tempo`; `loop.setRange`/`loop.setEnabled` write `song.loop`), and this
 * layer only mirrors them onto the transport, so the schedule already keyed to
 * musical ticks plays at the right speed over the right range.
 *
 * Everything here is written against the injectable {@link TransportEngine}
 * interface rather than `Tone.getTransport()` directly, so seek alignment,
 * loop bar-snapping, and metronome scheduling are all provable without a real
 * audio context or any wall-clock timing (PRD AUD-03).
 */

/** The transport's coarse playback state, mirroring `Tone.PlaybackState`. */
export type TransportState = "stopped" | "started" | "paused";

/**
 * The minimum the transport depends on from `Tone.Transport`. An interface, so
 * tests can drive play/pause/stop/seek/loop and observe the exact ticks and
 * loop bounds written, and so the metronome's scheduling can be asserted
 * without a Tone context.
 */
export interface TransportEngine {
  bpm: { value: number };
  /** Absolute transport position, in ticks at {@link PPQ}. */
  ticks: number;
  readonly state: TransportState;
  loop: boolean;
  /** Loop start/end as Tone time strings ("<n>i" tick notation). */
  loopStart: string;
  loopEnd: string;
  start(): void;
  pause(): void;
  stop(): void;
  /** Schedule a callback to repeat every `intervalTicks`, starting at `startTicks`. */
  scheduleRepeat(
    callback: (time: number) => void,
    intervalTicks: number,
    startTicks: number,
  ): number;
  clear(id: number): void;
}

/**
 * The live engine backed by the one shared `Tone.Transport`. Constructed lazily
 * by {@link TransportController} so importing this module never touches Tone's
 * global transport.
 */
export const liveTransportEngine: TransportEngine = {
  get bpm() {
    return Tone.getTransport().bpm;
  },
  get ticks() {
    return Tone.getTransport().ticks;
  },
  set ticks(value: number) {
    Tone.getTransport().ticks = value;
  },
  get state(): TransportState {
    return Tone.getTransport().state as TransportState;
  },
  get loop() {
    return Tone.getTransport().loop;
  },
  set loop(value: boolean) {
    Tone.getTransport().loop = value;
  },
  get loopStart() {
    return String(Tone.getTransport().loopStart);
  },
  set loopStart(value: string) {
    Tone.getTransport().loopStart = value;
  },
  get loopEnd() {
    return String(Tone.getTransport().loopEnd);
  },
  set loopEnd(value: string) {
    Tone.getTransport().loopEnd = value;
  },
  start() {
    Tone.getTransport().start();
  },
  pause() {
    Tone.getTransport().pause();
  },
  stop() {
    Tone.getTransport().stop();
  },
  scheduleRepeat(callback, intervalTicks, startTicks) {
    return Tone.getTransport().scheduleRepeat(
      callback,
      ticksToToneTime(intervalTicks),
      ticksToToneTime(startTicks),
    );
  },
  clear(id) {
    Tone.getTransport().clear(id);
  },
};

/** The AUD-02 supported tempo range. The domain `song.tempo` parameter allows a
 * wider band for migration headroom; the transport surface clamps to the range
 * the product actually supports. */
export const MIN_TEMPO_BPM = 40;
export const MAX_TEMPO_BPM = 240;

/** Clamps a tempo to the AUD-02 supported 40-240 BPM range. */
export function clampTempo(bpm: number): number {
  if (!Number.isFinite(bpm)) return MIN_TEMPO_BPM;
  return Math.min(MAX_TEMPO_BPM, Math.max(MIN_TEMPO_BPM, bpm));
}

/**
 * The metronome click (PRD AUD-02). One reusable synth voice, scheduled once
 * as a bar-relative repeat on the transport so it stays aligned across seek,
 * tempo change, and loop boundaries exactly like every other scheduled event —
 * it is never dispatched from an animation frame. Toggling it on or off never
 * stops or restarts the transport.
 */
export interface Metronome {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export interface MetronomeOptions {
  /** Injectable for tests; defaults to a real Tone voice on the shared output. */
  readonly createVoice?: () => MetronomeVoice;
}

/** The sound source the metronome triggers. Injectable so scheduling is testable. */
export interface MetronomeVoice {
  /** Trigger one click. `accent` marks the downbeat of a bar. */
  click(time: number, accent: boolean): void;
  dispose(): void;
}

/** A Tone-backed metronome voice: a short pitched blip, accented on the downbeat. */
function createToneMetronomeVoice(destination: Tone.ToneAudioNode): MetronomeVoice {
  const synth = new Tone.Synth({
    oscillator: { type: "square" },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 },
    volume: -8,
  });
  synth.connect(destination);
  return {
    click(time, accent) {
      synth.triggerAttackRelease(accent ? "C6" : "C5", 0.02, time);
    },
    dispose() {
      synth.dispose();
    },
  };
}

/**
 * Wires a metronome onto the transport. The click repeats every quarter note
 * from tick 0; the accent lands on beat 0 of each 4/4 bar. Scheduling once and
 * gating on `enabled` (rather than clearing/rescheduling on every toggle) keeps
 * the click phase locked to the transport regardless of when it was turned on.
 */
export class TransportMetronome implements Metronome {
  private readonly voice: MetronomeVoice;
  private readonly scheduleId: number;
  private readonly handle: ReturnType<AudioProjectScope["register"]>;
  private isEnabled = false;
  private disposed = false;

  constructor(
    private readonly engine: TransportEngine,
    private readonly scope: AudioProjectScope,
    destination: Tone.ToneAudioNode,
    options: MetronomeOptions = {},
  ) {
    this.voice = options.createVoice
      ? options.createVoice()
      : createToneMetronomeVoice(destination);
    this.scheduleId = this.engine.scheduleRepeat(
      (time) => {
        if (!this.isEnabled) return;
        // The scheduled tick is quarter-note aligned; the accent is the bar
        // downbeat. `engine.ticks` is the transport's position when the event
        // fires, which is exact at a quarter-note grid point.
        const accent = this.engine.ticks % TICKS_PER_BAR < TICKS_PER_QUARTER;
        this.voice.click(time, accent);
      },
      TICKS_PER_QUARTER,
      0,
    );
    this.handle = this.scope.register("schedule", () => {
      this.engine.clear(this.scheduleId);
    });
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.isEnabled = false;
    void this.scope.release(this.handle);
    this.voice.dispose();
  }
}

export interface TransportControllerOptions {
  readonly engine?: TransportEngine;
  readonly scope?: AudioProjectScope;
  readonly metronome?: Metronome;
}

/**
 * Owns the transport's play/pause/stop/seek, tempo, bar-aligned loop, and
 * metronome for one open project (PRD AUD-01/AUD-02). It never schedules the
 * arrangement itself — {@link ProjectAudioGraph} owns that — so a tempo change
 * or a loop toggle updates the transport in place without rebuilding a single
 * audio node or restarting playback.
 */
export class TransportController {
  private readonly engine: TransportEngine;
  private readonly metronome: Metronome | null;
  private loopRange: LoopRange | null = null;
  /**
   * A seek put the playhead past the loop end while looping (GRV-189): the
   * transport plays on from there until the loop catches it, so the readout
   * must not fold that position back into the loop as it does the lookahead
   * overshoot of a normal pass. Cleared once the playhead is inside the loop.
   */
  private seekedPastLoopEnd = false;
  /** Where the playhead was when `stop()` last ran, so `continueFromStop()`
   * can resume there rather than from the position `stop()` rewound to. */
  private stoppedAtTicks = 0;
  /**
   * Whether the playhead was explicitly put back at the top (a fresh
   * transport, `stop()`, or a seek to the start while stopped) and nothing has
   * played since. Deliberately not inferred from the position: a pause before
   * the transport advanced, or one that lands exactly on the loop start, sits
   * on the start tick too, and resuming from it is still the same programme.
   */
  private rewound = true;

  constructor(options: TransportControllerOptions = {}) {
    this.engine = options.engine ?? liveTransportEngine;
    this.metronome = options.metronome ?? null;
  }

  get state(): TransportState {
    return this.engine.state;
  }

  get isPlaying(): boolean {
    return this.engine.state === "started";
  }

  /** The current playhead position, in absolute ticks at {@link PPQ}. */
  /**
   * Where the playhead is, in ticks. While a loop is playing, a position past
   * the loop end is folded back into the loop: Tone reads its position a
   * lookahead ahead of the audio clock, so for a moment at every pass the raw
   * value has run past the end before the transport wraps it — and a readout
   * that flickers into the bar after the loop is a playhead that does not
   * follow what is heard (PRD AUD-01).
   */
  get positionTicks(): number {
    const ticks = Math.max(0, Math.round(this.engine.ticks));
    const loop = this.loopRange;
    if (loop && ticks < loop.endTicks) this.seekedPastLoopEnd = false;
    if (
      !loop ||
      !this.isPlaying ||
      !this.engine.loop ||
      ticks < loop.endTicks ||
      this.seekedPastLoopEnd
    ) {
      return ticks;
    }
    return (
      loop.startTicks + ((ticks - loop.endTicks) % (loop.endTicks - loop.startTicks))
    );
  }

  get loop(): LoopRange | null {
    return this.loopRange;
  }

  get loopEnabled(): boolean {
    return this.engine.loop;
  }

  get metronomeEnabled(): boolean {
    return this.metronome?.enabled ?? false;
  }

  /**
   * Whether the next `play()` plays from the top: the transport was stopped
   * (or freshly made, or seeked to the start while stopped) and has not
   * played since (#937: a loudness meter's integrated figure starts over
   * then). A pause is never the top, wherever its playhead happens to sit.
   */
  get atStart(): boolean {
    return this.rewound && !this.isPlaying;
  }

  /** The tick `stop()` rewinds to: the loop start when looping, else 0. */
  private get startTicks(): number {
    return this.engine.loop ? (this.loopRange?.startTicks ?? 0) : 0;
  }

  /** Start (or resume) playback from the current position. */
  play(): void {
    this.rewound = false;
    this.engine.start();
  }

  /** Pause, leaving the playhead where it is so `play()` resumes from there. */
  pause(): void {
    this.engine.pause();
  }

  /**
   * Stop and return the playhead to the loop start when looping, or to the
   * arrangement start otherwise (PRD AUD-01: "returns to the expected position
   * on stop"). The pre-rewind position is remembered for
   * {@link continueFromStop}.
   */
  stop(): void {
    this.stoppedAtTicks = this.positionTicks;
    this.engine.stop();
    this.engine.ticks = this.startTicks;
    this.seekedPastLoopEnd = false;
    this.rewound = true;
  }

  /**
   * Resume from where playback last stopped — the KEY-01 `transport.continue`
   * mapping (Shift+Space), which is what distinguishes it from play/stop.
   * After `stop()` rewound the playhead, this returns it to the remembered
   * position; after `pause()` (which never moved it) it simply resumes in
   * place. Already-running playback is left alone.
   */
  continueFromStop(): void {
    if (this.isPlaying) return;
    if (this.engine.state === "stopped") {
      this.engine.ticks = this.stoppedAtTicks;
    }
    this.rewound = false;
    this.engine.start();
  }

  /** Move the playhead without changing whether the transport is running. A
   * tempo change is a mirror, not a seek — see {@link setTempo}. */
  seekTicks(ticks: number): void {
    const target = Math.max(0, Math.round(ticks));
    this.engine.ticks = target;
    this.seekedPastLoopEnd =
      this.engine.loop &&
      target >= (this.loopRange?.endTicks ?? Number.POSITIVE_INFINITY);
    // Only a seek made while stopped or paused can put the next play at the
    // top; one made mid-play is part of the running programme.
    if (!this.isPlaying) this.rewound = target === this.startTicks;
  }

  /**
   * Mirror the song's tempo onto the transport. Because the arrangement
   * schedule is keyed to musical ticks, changing the BPM re-times every event
   * without moving the playhead or restarting the song (PRD AUD-02: "Tempo
   * changes during playback do not restart the song").
   */
  setTempo(bpm: number): void {
    this.engine.bpm.value = clampTempo(bpm);
  }

  /**
   * Mirror the song's loop (`song.loop`, LOOP-017) onto the transport. The
   * loop is project state, written only by the `loop.setRange` and
   * `loop.setEnabled` commands; this layer never owns one of its own, exactly
   * like tempo.
   *
   * It updates the running transport in place — no stop, no start, no seek,
   * no node rebuild — so a range dragged during playback takes effect on the
   * transport's next pass through the loop end (PRD AUD-02). An unchanged
   * value is not rewritten, so a reconcile for an unrelated edit touches
   * nothing here. When both points move, the one that keeps the engine's
   * range non-inverted is written first, so the transport never sees an end
   * before its start, even for the instant between the two writes.
   */
  mirrorLoop(loop: SongLoopState): void {
    const next: LoopRange = { startTicks: loop.startTicks, endTicks: loop.endTicks };
    const current = this.loopRange;
    if (current?.startTicks !== next.startTicks || current.endTicks !== next.endTicks) {
      const writeStart = () => {
        this.engine.loopStart = ticksToToneTime(next.startTicks);
      };
      const writeEnd = () => {
        this.engine.loopEnd = ticksToToneTime(next.endTicks);
      };
      if (current && next.startTicks >= current.endTicks) {
        writeEnd();
        writeStart();
      } else {
        writeStart();
        writeEnd();
      }
      this.loopRange = next;
    }
    if (this.engine.loop !== loop.enabled) {
      this.engine.loop = loop.enabled;
    }
  }

  /** Turn the metronome click on or off without stopping playback. */
  setMetronomeEnabled(enabled: boolean): void {
    this.metronome?.setEnabled(enabled);
  }

  toggleMetronome(): void {
    this.setMetronomeEnabled(!this.metronomeEnabled);
  }
}
