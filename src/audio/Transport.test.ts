import { beforeAll, describe, expect, it, vi } from "vitest";
import { TICKS_PER_BAR, TICKS_PER_QUARTER } from "../domain/time";
import type { AudioProjectScope } from "./AudioRuntime";
import type { MetronomeVoice, TransportEngine, TransportState } from "./Transport";
import { installWebAudioGlobals } from "./testAudioContext";

// Transport.ts imports Tone at module scope; install the Web Audio globals
// before importing it so the import does not throw under Node.
installWebAudioGlobals();

let TransportModule: typeof import("./Transport");

beforeAll(async () => {
  TransportModule = await import("./Transport");
});

/**
 * A deterministic transport double that records every write and lets a test
 * fire the scheduled repeat callback at a chosen tick. No Tone, no wall clock.
 */
function fakeEngine(): TransportEngine & {
  fireRepeat(atTicks: number, time: number): void;
  advance(by: number): void;
  scheduled: { intervalTicks: number; startTicks: number } | null;
  startCalls: number;
  pauseCalls: number;
  stopCalls: number;
} {
  let repeatCallback: ((time: number) => void) | null = null;
  const engine = {
    bpm: { value: 120 },
    ticks: 0,
    _state: "stopped" as TransportState,
    loop: false,
    loopStart: "0i",
    loopEnd: "0i",
    startCalls: 0,
    pauseCalls: 0,
    stopCalls: 0,
    scheduled: null as { intervalTicks: number; startTicks: number } | null,
    get state(): TransportState {
      return this._state;
    },
    start() {
      this.startCalls += 1;
      this._state = "started";
    },
    pause() {
      this.pauseCalls += 1;
      this._state = "paused";
    },
    stop() {
      this.stopCalls += 1;
      this._state = "stopped";
    },
    scheduleRepeat(
      callback: (time: number) => void,
      intervalTicks: number,
      startTicks: number,
    ) {
      repeatCallback = callback;
      this.scheduled = { intervalTicks, startTicks };
      return 1;
    },
    clear() {
      repeatCallback = null;
      this.scheduled = null;
    },
    /** Run the clock `by` ticks the way Tone's transport does: on the first
     * tick at or past the loop end, with the loop on, wrap to the loop start. */
    advance(by: number) {
      if (this._state !== "started") return;
      for (let i = 0; i < by; i += 1) {
        this.ticks += 1;
        if (this.loop && this.ticks >= Number.parseInt(this.loopEnd, 10)) {
          this.ticks = Number.parseInt(this.loopStart, 10);
        }
      }
    },
    fireRepeat(atTicks: number, time: number) {
      this.ticks = atTicks;
      repeatCallback?.(time);
    },
  };
  return engine;
}

function fakeScope(): AudioProjectScope {
  return {
    ownerId: "test",
    register: (_type, _dispose) => ({ id: 1 }),
    release: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

describe("barAlignedLoop (PRD AUD-02)", () => {
  it("snaps the start down and the end up to whole bars", () => {
    const range = TransportModule.barAlignedLoop(
      TICKS_PER_BAR + 10,
      2 * TICKS_PER_BAR + 5,
    );
    expect(range.startTicks).toBe(TICKS_PER_BAR);
    expect(range.endTicks).toBe(3 * TICKS_PER_BAR);
  });

  it("always encloses at least one bar, even for an empty range", () => {
    const range = TransportModule.barAlignedLoop(100, 100);
    expect(range.endTicks - range.startTicks).toBe(TICKS_PER_BAR);
  });

  it("loopOfBars produces a bar-aligned range of the requested length", () => {
    const range = TransportModule.loopOfBars(2, 4);
    expect(range.startTicks).toBe(2 * TICKS_PER_BAR);
    expect(range.endTicks).toBe(6 * TICKS_PER_BAR);
  });
});

describe("clampTempo (PRD AUD-02)", () => {
  it("clamps to the supported 40-240 BPM range", () => {
    expect(TransportModule.clampTempo(20)).toBe(40);
    expect(TransportModule.clampTempo(300)).toBe(240);
    expect(TransportModule.clampTempo(128)).toBe(128);
    expect(TransportModule.clampTempo(Number.NaN)).toBe(40);
  });
});

describe("TransportController (PRD AUD-01/AUD-02)", () => {
  it("play/pause leaves the playhead in place; stop returns it to the start", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });

    transport.play();
    expect(engine.startCalls).toBe(1);
    expect(transport.isPlaying).toBe(true);

    engine.ticks = 5 * TICKS_PER_QUARTER;
    transport.pause();
    expect(engine.pauseCalls).toBe(1);
    // Pause does not move the playhead.
    expect(transport.positionTicks).toBe(5 * TICKS_PER_QUARTER);

    transport.stop();
    expect(engine.stopCalls).toBe(1);
    expect(transport.positionTicks).toBe(0);
  });

  it("stop returns to the loop start when looping is enabled", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    transport.mirrorLoop({
      startTicks: 2 * TICKS_PER_BAR,
      endTicks: 4 * TICKS_PER_BAR,
      enabled: true,
    });
    engine.ticks = 3 * TICKS_PER_BAR;

    transport.stop();
    expect(transport.positionTicks).toBe(2 * TICKS_PER_BAR);
  });

  it("stop ignores a brace while looping is off (GRV-189)", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    transport.mirrorLoop({
      startTicks: 2 * TICKS_PER_BAR,
      endTicks: 4 * TICKS_PER_BAR,
      enabled: false,
    });
    engine.ticks = 3 * TICKS_PER_BAR;

    transport.stop();
    expect(transport.positionTicks).toBe(0);
  });

  it("a seek outside the loop is not clamped, while playing or stopped (GRV-189)", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    transport.mirrorLoop({ startTicks: 0, endTicks: TICKS_PER_BAR, enabled: true });
    transport.play();

    transport.seekTicks(5 * TICKS_PER_BAR);
    expect(transport.positionTicks).toBe(5 * TICKS_PER_BAR);
    expect(transport.isPlaying).toBe(true);
    expect(engine.stopCalls).toBe(0);

    transport.pause();
    transport.seekTicks(7 * TICKS_PER_BAR);
    expect(transport.positionTicks).toBe(7 * TICKS_PER_BAR);
  });

  describe("a seek relative to the loop while looping (GRV-189)", () => {
    const loop = {
      startTicks: TICKS_PER_BAR,
      endTicks: 2 * TICKS_PER_BAR,
      enabled: true,
    };

    it("plays on past the loop end without wrapping, readout following", () => {
      const engine = fakeEngine();
      const transport = new TransportModule.TransportController({ engine });
      transport.mirrorLoop(loop);
      transport.play();
      expect(engine.loop).toBe(true);

      transport.seekTicks(5 * TICKS_PER_BAR);
      expect(engine.loop).toBe(false);
      expect(transport.loopEnabled).toBe(true);
      engine.advance(10 * TICKS_PER_QUARTER);
      expect(engine.ticks).toBe(5 * TICKS_PER_BAR + 10 * TICKS_PER_QUARTER);
      expect(transport.positionTicks).toBe(engine.ticks);
    });

    it("keeps the engine loop off across a reconcile while past the end", () => {
      const engine = fakeEngine();
      const transport = new TransportModule.TransportController({ engine });
      transport.mirrorLoop(loop);
      transport.play();
      transport.seekTicks(5 * TICKS_PER_BAR);

      transport.mirrorLoop({ ...loop });
      expect(engine.loop).toBe(false);
      engine.advance(TICKS_PER_BAR);
      expect(transport.positionTicks).toBe(6 * TICKS_PER_BAR);
    });

    it("re-arms when the loop end moves past the playhead", () => {
      const engine = fakeEngine();
      const transport = new TransportModule.TransportController({ engine });
      transport.mirrorLoop(loop);
      transport.play();
      transport.seekTicks(3 * TICKS_PER_BAR);

      transport.mirrorLoop({ ...loop, endTicks: 8 * TICKS_PER_BAR });
      expect(engine.loop).toBe(true);
    });

    it("plays into the loop from before its start, then loops", () => {
      const engine = fakeEngine();
      const transport = new TransportModule.TransportController({ engine });
      transport.mirrorLoop(loop);
      transport.play();
      transport.seekTicks(0);
      expect(engine.loop).toBe(true);

      engine.advance(2 * TICKS_PER_BAR);
      expect(engine.ticks).toBe(TICKS_PER_BAR);
      expect(transport.positionTicks).toBe(TICKS_PER_BAR);
    });

    it("stop after playing on rewinds to the loop start and re-arms", () => {
      const engine = fakeEngine();
      const transport = new TransportModule.TransportController({ engine });
      transport.mirrorLoop(loop);
      transport.play();
      transport.seekTicks(5 * TICKS_PER_BAR);

      transport.stop();
      expect(engine.ticks).toBe(TICKS_PER_BAR);
      expect(engine.loop).toBe(true);
    });

    it("play from a stopped position past the end plays on", () => {
      const engine = fakeEngine();
      const transport = new TransportModule.TransportController({ engine });
      transport.mirrorLoop(loop);
      transport.seekTicks(4 * TICKS_PER_BAR);
      expect(engine.loop).toBe(false);

      transport.play();
      engine.advance(TICKS_PER_BAR);
      expect(transport.positionTicks).toBe(5 * TICKS_PER_BAR);
    });

    it("turning the loop off and on keeps the intent in loopEnabled", () => {
      const engine = fakeEngine();
      const transport = new TransportModule.TransportController({ engine });
      transport.mirrorLoop(loop);
      transport.seekTicks(4 * TICKS_PER_BAR);
      transport.mirrorLoop({ ...loop, enabled: false });
      expect(transport.loopEnabled).toBe(false);
      expect(engine.loop).toBe(false);
    });
  });

  it("knows when the next play starts from the top (#937)", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    expect(transport.atStart).toBe(true);
    transport.play();
    expect(transport.atStart).toBe(false);
    engine.ticks = 3 * TICKS_PER_QUARTER;
    transport.pause();
    expect(transport.atStart).toBe(false);
    transport.stop();
    expect(transport.atStart).toBe(true);
    transport.seekTicks(TICKS_PER_BAR);
    expect(transport.atStart).toBe(false);

    // Looping, the top is the loop start, which is where stop rewinds to.
    transport.mirrorLoop({
      startTicks: 2 * TICKS_PER_BAR,
      endTicks: 4 * TICKS_PER_BAR,
      enabled: true,
    });
    transport.stop();
    expect(transport.atStart).toBe(true);
    transport.seekTicks(2 * TICKS_PER_BAR);
    expect(transport.atStart).toBe(true);
  });

  it("never treats a pause as the top, even one that sits on the start tick (#937)", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });

    // Paused before the transport advanced: the playhead is still on tick 0.
    transport.play();
    transport.pause();
    expect(engine.ticks).toBe(0);
    expect(transport.atStart).toBe(false);

    // Paused exactly on the loop start mid-pass.
    transport.mirrorLoop({
      startTicks: TICKS_PER_BAR,
      endTicks: 2 * TICKS_PER_BAR,
      enabled: true,
    });
    transport.play();
    engine.ticks = TICKS_PER_BAR;
    transport.pause();
    expect(transport.atStart).toBe(false);

    // A seek made while playing is part of the programme, even to the top.
    transport.play();
    transport.seekTicks(TICKS_PER_BAR);
    transport.pause();
    expect(transport.atStart).toBe(false);
  });

  it("reports a position just past the loop end as back at the loop start while looping", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    transport.mirrorLoop({ startTicks: 0, endTicks: TICKS_PER_BAR, enabled: true });
    transport.play();

    // The engine's position runs a lookahead ahead of the wrap.
    engine.ticks = TICKS_PER_BAR + 12;
    expect(transport.positionTicks).toBe(12);
    engine.ticks = TICKS_PER_BAR - 1;
    expect(transport.positionTicks).toBe(TICKS_PER_BAR - 1);
  });

  it("reports the raw position when not looping, or when stopped past the loop", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    transport.mirrorLoop({ startTicks: 0, endTicks: TICKS_PER_BAR, enabled: false });
    transport.play();
    engine.ticks = TICKS_PER_BAR + 12;
    expect(transport.positionTicks).toBe(TICKS_PER_BAR + 12);

    transport.mirrorLoop({ startTicks: 0, endTicks: TICKS_PER_BAR, enabled: true });
    transport.pause();
    transport.seekTicks(3 * TICKS_PER_BAR);
    expect(transport.positionTicks).toBe(3 * TICKS_PER_BAR);
  });

  it("continueFromStop resumes at the position stop() rewound from", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });

    transport.play();
    engine.ticks = 6 * TICKS_PER_QUARTER;
    transport.stop();
    // Stop rewound the playhead, which is what makes Shift+Space distinct from
    // Space: the position it stopped at is remembered, not lost.
    expect(transport.positionTicks).toBe(0);

    transport.continueFromStop();
    expect(transport.positionTicks).toBe(6 * TICKS_PER_QUARTER);
    expect(transport.isPlaying).toBe(true);
    expect(engine.startCalls).toBe(2);
  });

  it("continueFromStop resumes in place after a pause, and is a no-op while playing", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });

    transport.play();
    engine.ticks = 3 * TICKS_PER_QUARTER;
    transport.pause();

    // Pause never moved the playhead, so there is nothing to restore.
    transport.continueFromStop();
    expect(transport.positionTicks).toBe(3 * TICKS_PER_QUARTER);
    expect(engine.startCalls).toBe(2);

    // Already running: continue neither restarts nor rewinds.
    engine.ticks = 9 * TICKS_PER_QUARTER;
    transport.continueFromStop();
    expect(engine.startCalls).toBe(2);
    expect(transport.positionTicks).toBe(9 * TICKS_PER_QUARTER);
  });

  it("seekTicks moves the playhead without changing the run state", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    transport.play();
    transport.seekTicks(3 * TICKS_PER_QUARTER);
    expect(transport.positionTicks).toBe(3 * TICKS_PER_QUARTER);
    // Still started — a seek is not a stop.
    expect(engine.stopCalls).toBe(0);
    expect(transport.isPlaying).toBe(true);
  });

  it("setTempo mirrors the (clamped) tempo without starting or stopping", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    transport.play();
    transport.setTempo(300);
    expect(engine.bpm.value).toBe(240);
    // No restart: the transport was never stopped or re-started.
    expect(engine.stopCalls).toBe(0);
    expect(engine.startCalls).toBe(1);
    expect(transport.isPlaying).toBe(true);
  });

  it("mirrorLoop writes the song's range as tick notation and its toggle", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });

    transport.mirrorLoop({
      startTicks: TICKS_PER_BAR,
      endTicks: 3 * TICKS_PER_BAR,
      enabled: true,
    });

    expect(engine.loopStart).toBe(`${TICKS_PER_BAR}i`);
    expect(engine.loopEnd).toBe(`${3 * TICKS_PER_BAR}i`);
    expect(engine.loop).toBe(true);
    expect(transport.loop).toEqual({
      startTicks: TICKS_PER_BAR,
      endTicks: 3 * TICKS_PER_BAR,
    });
    expect(transport.loopEnabled).toBe(true);
  });

  it("mirrorLoop updates a running transport in place: no stop, start, or seek", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    transport.mirrorLoop({ startTicks: 0, endTicks: TICKS_PER_BAR, enabled: true });
    transport.play();
    engine.ticks = 100;

    transport.mirrorLoop({ startTicks: 0, endTicks: 4 * TICKS_PER_BAR, enabled: true });
    transport.mirrorLoop({ startTicks: 0, endTicks: 4 * TICKS_PER_BAR, enabled: false });

    expect(engine.loopEnd).toBe(`${4 * TICKS_PER_BAR}i`);
    expect(engine.loop).toBe(false);
    expect(engine.startCalls).toBe(1);
    expect(engine.stopCalls).toBe(0);
    expect(engine.pauseCalls).toBe(0);
    expect(engine.ticks).toBe(100);
    expect(transport.isPlaying).toBe(true);
  });

  it("never shows the engine an inverted range while a dragged loop moves", () => {
    const engine = fakeEngine();
    const writes: string[] = [];
    const points = { start: 0, end: 0 };
    const inverted: string[] = [];
    const track = (key: "start" | "end") => ({
      get: () => `${points[key]}i`,
      set: (value: string) => {
        points[key] = Number.parseInt(value, 10);
        writes.push(`${key}=${points[key]}`);
        if (points.end !== 0 && points.end <= points.start)
          inverted.push(writes.join(","));
      },
    });
    Object.defineProperty(engine, "loopStart", track("start"));
    Object.defineProperty(engine, "loopEnd", track("end"));
    const transport = new TransportModule.TransportController({ engine });
    const bar = TICKS_PER_BAR;

    transport.mirrorLoop({ startTicks: 0, endTicks: bar, enabled: true });
    transport.play();
    // Drag right past the old end, then back left past the old start.
    transport.mirrorLoop({ startTicks: 4 * bar, endTicks: 6 * bar, enabled: true });
    transport.mirrorLoop({ startTicks: bar, endTicks: 2 * bar, enabled: true });

    expect(inverted).toEqual([]);
    expect(points).toEqual({ start: bar, end: 2 * bar });
    expect(engine.startCalls).toBe(1);
    expect(engine.stopCalls).toBe(0);
  });

  it("mirrorLoop writes nothing when the song's loop has not changed", () => {
    const engine = fakeEngine();
    const transport = new TransportModule.TransportController({ engine });
    const loop = { startTicks: 0, endTicks: TICKS_PER_BAR, enabled: true };
    transport.mirrorLoop(loop);
    engine.loopStart = "sentinel";
    engine.loopEnd = "sentinel";

    transport.mirrorLoop({ ...loop });

    expect(engine.loopStart).toBe("sentinel");
    expect(engine.loopEnd).toBe("sentinel");
  });

  it("delegates the metronome to its Metronome without restarting the transport", () => {
    const engine = fakeEngine();
    const setEnabled = vi.fn();
    let enabled = false;
    const metronome = {
      get enabled() {
        return enabled;
      },
      setEnabled: (value: boolean) => {
        enabled = value;
        setEnabled(value);
      },
      dispose: () => {},
    };
    const transport = new TransportModule.TransportController({
      engine,
      metronome,
    });
    transport.play();
    transport.toggleMetronome();
    expect(setEnabled).toHaveBeenLastCalledWith(true);
    expect(transport.metronomeEnabled).toBe(true);
    transport.toggleMetronome();
    expect(setEnabled).toHaveBeenLastCalledWith(false);
    // The click toggle never stopped or restarted playback.
    expect(engine.startCalls).toBe(1);
    expect(engine.stopCalls).toBe(0);
  });
});

describe("TransportMetronome (PRD AUD-02)", () => {
  function fakeVoice(): MetronomeVoice & {
    clicks: { time: number; accent: boolean }[];
  } {
    const clicks: { time: number; accent: boolean }[] = [];
    return {
      clicks,
      click(time, accent) {
        clicks.push({ time, accent });
      },
      dispose() {},
    };
  }

  it("schedules a single quarter-note repeat from tick 0", () => {
    const engine = fakeEngine();
    const voice = fakeVoice();
    new TransportModule.TransportMetronome(
      engine,
      fakeScope(),
      // Destination is unused because we inject the voice.
      undefined as never,
      { createVoice: () => voice },
    );
    expect(engine.scheduled).toEqual({
      intervalTicks: TICKS_PER_QUARTER,
      startTicks: 0,
    });
  });

  it("clicks only while enabled, accenting the bar downbeat", () => {
    const engine = fakeEngine();
    const voice = fakeVoice();
    const metronome = new TransportModule.TransportMetronome(
      engine,
      fakeScope(),
      undefined as never,
      { createVoice: () => voice },
    );

    // Disabled: firing the repeat produces no click.
    engine.fireRepeat(0, 0.5);
    expect(voice.clicks).toHaveLength(0);

    metronome.setEnabled(true);
    engine.fireRepeat(0, 1); // bar downbeat
    engine.fireRepeat(TICKS_PER_QUARTER, 1.5); // beat 2
    engine.fireRepeat(TICKS_PER_BAR, 2); // next bar downbeat

    expect(voice.clicks).toEqual([
      { time: 1, accent: true },
      { time: 1.5, accent: false },
      { time: 2, accent: true },
    ]);
  });

  it("is idempotent to dispose and stops clicking afterwards", () => {
    const engine = fakeEngine();
    const voice = fakeVoice();
    const disposeSpy = vi.spyOn(voice, "dispose");
    const metronome = new TransportModule.TransportMetronome(
      engine,
      fakeScope(),
      undefined as never,
      { createVoice: () => voice },
    );
    metronome.setEnabled(true);
    metronome.dispose();
    metronome.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    engine.fireRepeat(0, 1);
    expect(voice.clicks).toHaveLength(0);
  });
});

describe("a loop edited during playback, on a real Tone transport (LOOP-017)", () => {
  type ToneTransport = ReturnType<typeof import("tone")["getTransport"]>;

  /**
   * The `TransportEngine` surface bound to one given transport. Offline
   * rendering restores the global context before events fire, so
   * `liveTransportEngine` would reach the wrong transport from a callback.
   */
  function engineFor(transport: ToneTransport): TransportEngine {
    return {
      bpm: transport.bpm,
      get ticks() {
        return transport.ticks;
      },
      set ticks(value: number) {
        transport.ticks = value;
      },
      get state() {
        return transport.state as TransportState;
      },
      get loop() {
        return transport.loop;
      },
      set loop(value: boolean) {
        transport.loop = value;
      },
      get loopStart() {
        return String(transport.loopStart);
      },
      set loopStart(value: string) {
        transport.loopStart = value;
      },
      get loopEnd() {
        return String(transport.loopEnd);
      },
      set loopEnd(value: string) {
        transport.loopEnd = value;
      },
      start: () => transport.start(),
      pause: () => transport.pause(),
      stop: () => transport.stop(),
      scheduleRepeat: () => 0,
      clear: () => {},
    };
  }

  /**
   * Renders 4.5 s at 120 BPM (a 4/4 bar is 2 s) with an event on the downbeat
   * and one half-way through bar 2, returning each trigger with its time in
   * ms. The loop ends up as bars 1-2 either way: `widenMidPass` starts it as
   * bar 1 alone and widens it half-way through the first pass, while running.
   */
  async function render(widenMidPass: boolean): Promise<string[]> {
    const Tone = await import("tone");
    const hits: string[] = [];
    const bar = TICKS_PER_BAR;
    await Tone.Offline(({ transport }) => {
      transport.bpm.value = 120;
      const controller = new TransportModule.TransportController({
        engine: engineFor(transport),
      });
      const final = { startTicks: 0, endTicks: 2 * bar, enabled: true };
      controller.mirrorLoop(widenMidPass ? { ...final, endTicks: bar } : final);
      const hit = (label: string) => (time: number) =>
        hits.push(`${label}@${Math.round(time * 1000)}`);
      transport.schedule(hit("downbeat"), "0i");
      transport.schedule(hit("bar 2"), `${bar + bar / 2}i`);
      transport.schedule(
        () => {
          if (widenMidPass) controller.mirrorLoop(final);
        },
        `${bar / 2}i`,
      );
      controller.play();
    }, 4.5);
    return hits;
  }

  it("is honoured from the next pass, with no extra trigger and no drift", async () => {
    const baseline = await render(false);
    const edited = await render(true);

    // The widened loop runs on into bar 2 and wraps at its new end (4 s), and
    // every trigger lands at the same time, the same number of times, as on a
    // transport that had that loop from the start. (This offline renderer can
    // dispatch one event twice within a microsecond regardless of looping;
    // comparing against the baseline keeps that out of the assertion.)
    expect(edited).toEqual(baseline);
    expect([...new Set(edited)]).toEqual(["downbeat@0", "bar 2@3000", "downbeat@4000"]);
  });
});
