import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDevice } from "../domain/devices";
import type { Device } from "../domain/entities";
import { createSeededIdFactory } from "../domain/ids";
import type { AudioMasterProjection } from "../projection/audioProjection";
import { installWebAudioGlobals, rms } from "./testAudioContext";

installWebAudioGlobals();

let Tone: typeof import("tone");
let AudioRuntimeModule: typeof import("./AudioRuntime");
let MasterAudioGraphModule: typeof import("./MasterAudioGraph");
let devicesModule: typeof import("./devices");

beforeAll(async () => {
  Tone = await import("tone");
  AudioRuntimeModule = await import("./AudioRuntime");
  MasterAudioGraphModule = await import("./MasterAudioGraph");
  devicesModule = await import("./devices");
});

afterEach(async () => {
  try {
    await AudioRuntimeModule.getAudioRuntime().close();
  } catch {
    // already closed
  }
  AudioRuntimeModule.__resetAudioRuntimeForTests();
});

const ids = createSeededIdFactory("master-audio-graph-test");

function masterProjection(
  overrides: Partial<AudioMasterProjection> = {},
): AudioMasterProjection {
  return {
    volume: 0,
    devices: [],
    safetyLimiter: true,
    fingerprint: "f",
    topologyFingerprint: "t",
    ...overrides,
  };
}

function passthroughDevice(order: number): Device {
  return {
    id: ids("device"),
    type: "filter",
    order,
    bypassed: false,
    parameters: {},
    preset: null,
  };
}

/** Peak absolute sample value across a rendered channel. */
function peak(data: Float32Array): number {
  let max = 0;
  for (const sample of data) max = Math.max(max, Math.abs(sample));
  return max;
}

/** Peak over a sub-window [startFrac, endFrac) — used to measure the steady
 * state after the limiter's attack has settled, since a brick-wall limiter is a
 * sustained-output safety net rather than a sample-accurate transient clamp. */
function peakWindow(data: Float32Array, startFrac: number, endFrac: number): number {
  const start = Math.floor(data.length * startFrac);
  const end = Math.floor(data.length * endFrac);
  let max = 0;
  for (let i = start; i < end; i += 1) max = Math.max(max, Math.abs(data[i]));
  return max;
}

describe("MasterAudioGraph (PRD AUD-04/AUD-08)", () => {
  it("passes an ordinary, already-safe signal through unchanged", async () => {
    const rendered = await Tone.Offline(
      ({ destination }) => {
        const runtime = new AudioRuntimeModule.AudioRuntime();
        const scope = runtime.openProjectScope("p");
        const master = new MasterAudioGraphModule.MasterAudioGraph(scope, destination);
        master.reconcile(masterProjection());
        // A moderate oscillator, well under 0 dBFS.
        const osc = new Tone.Oscillator({ frequency: 220, volume: -12 });
        osc.connect(master.input);
        osc.start(0).stop(0.2);
      },
      0.2,
      1,
    );
    const energy = rms(Float32Array.from(rendered.getChannelData(0)));
    expect(energy).toBeGreaterThan(0.01);
    // The safety limiter is transparent for safe material: no gross clipping.
    expect(peak(Float32Array.from(rendered.getChannelData(0)))).toBeLessThan(1);
  });

  it("the safety limiter attenuates a dangerously loud, extreme chain", async () => {
    /** Renders a +24 dB source through an extreme master device chain, with the
     * master's own safety limiter either kept or bypassed for comparison. */
    async function renderExtreme(withLimiter: boolean): Promise<Float32Array> {
      const buffer = await Tone.Offline(
        ({ destination }) => {
          const runtime = new AudioRuntimeModule.AudioRuntime();
          const scope = runtime.openProjectScope("p");
          const master = new MasterAudioGraphModule.MasterAudioGraph(scope, destination);
          master.reconcile(
            masterProjection({
              volume: 6,
              devices: [passthroughDevice(0), passthroughDevice(1)],
            }),
          );
          const osc = new Tone.Oscillator({ frequency: 110, volume: 24 });
          osc.connect(withLimiter ? master.input : destination);
          osc.start(0).stop(0.4);
        },
        0.4,
        1,
      );
      return Float32Array.from(buffer.getChannelData(0));
    }

    const limited = await renderExtreme(true);
    const unlimited = await renderExtreme(false);

    // The steady-state output through the master's limiter is meaningfully
    // quieter than the same dangerous signal reaching the destination
    // unprotected — the transparent safety stage is doing its job (PRD AUD-04).
    expect(peakWindow(limited, 0.5, 0.9)).toBeLessThan(peakWindow(unlimited, 0.5, 0.9));
    // And it is genuinely engaging (well below the raw signal), not a rounding
    // difference.
    expect(peakWindow(limited, 0.5, 0.9)).toBeLessThan(
      peakWindow(unlimited, 0.5, 0.9) * 0.75,
    );
  });

  it("leaves the safety limiter out, and a Limiter device in charge, on a new project's master (#937)", async () => {
    /** A +12 dB sine through the master, with or without its devices' DSP. */
    async function render(
      devices: Device[],
      { volume = 0, restore = false }: { volume?: number; restore?: boolean } = {},
    ): Promise<Float32Array> {
      const buffer = await Tone.Offline(
        ({ destination }) => {
          const runtime = new AudioRuntimeModule.AudioRuntime();
          const scope = runtime.openProjectScope("p");
          const master = new MasterAudioGraphModule.MasterAudioGraph(
            scope,
            destination,
            devicesModule.createDeviceNodeFactory({ scope, tempo: () => 120 }),
          );
          master.reconcile(masterProjection({ devices, volume, safetyLimiter: false }));
          expect(master.safetyLimited).toBe(false);
          if (restore) {
            master.reconcile(masterProjection({ devices, volume, safetyLimiter: true }));
            expect(master.safetyLimited).toBe(true);
          }
          const osc = new Tone.Oscillator({ frequency: 110, volume: 12 });
          osc.connect(master.input);
          osc.start(0).stop(0.4);
        },
        0.4,
        1,
      );
      return Float32Array.from(buffer.getChannelData(0));
    }

    const ceiling = 10 ** (-0.3 / 20) + 1e-6;
    // Nothing on the chain and no hidden limiter: the overload goes straight
    // through, which is what bypassing or removing the Limiter means.
    expect(peakWindow(await render([]), 0.5, 0.9)).toBeGreaterThan(2);
    // The Limiter holds it at its ceiling.
    const limiter = createDevice(ids("device"), "limiter", 0);
    expect(peak(await render([limiter]))).toBeLessThanOrEqual(ceiling);
    // The master fader comes before the chain here, so even at its +6 dB top
    // it drives into the Limiter rather than lifting its output past the
    // ceiling (the #837 clipping a new project's Limiter exists to prevent).
    expect(peak(await render([limiter], { volume: 6 }))).toBeLessThanOrEqual(ceiling);

    // Turning the safety limiter back on restores the original order:
    // chain -> volume -> safety limiter, which catches the overload again.
    expect(peakWindow(await render([], { restore: true }), 0.5, 0.9)).toBeLessThan(2);
  });

  it("renders silence when nothing is connected, and the meter reads no signal", async () => {
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const scope = runtime.openProjectScope("p");
    const master = new MasterAudioGraphModule.MasterAudioGraph(
      scope,
      runtime.getDestination(),
    );
    master.reconcile(masterProjection());
    // No source connected: the meter reports -Infinity dB (no signal).
    const value = master.levelMeter.getValue();
    const level = Array.isArray(value) ? Math.max(...value) : value;
    expect(level).toBeLessThan(-60);
    // Nor does the reading the master strip's meter takes (GRV-44), in
    // either routing of the safety limiter.
    expect(master.readLevel().rmsDb).toBeLessThan(-60);
    expect(master.readLevel().peakDb).toBe(Number.NEGATIVE_INFINITY);
    master.reconcile(masterProjection({ safetyLimiter: false, fingerprint: "f2" }));
    expect(master.readLevel().peakDb).toBe(Number.NEGATIVE_INFINITY);
    master.dispose();
    await runtime.close();
  });

  it("a volume (parameter-only) edit reconciles in place without recreating the meter or limiter", async () => {
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const scope = runtime.openProjectScope("p");
    const master = new MasterAudioGraphModule.MasterAudioGraph(
      scope,
      runtime.getDestination(),
    );
    master.reconcile(masterProjection({ volume: 0 }));
    const meterBefore = master.levelMeter;
    const nodeCountBefore = runtime.diagnostics().resources.byOwner.p;

    // A pure volume change — the fingerprint differs but the topology does not.
    master.reconcile(masterProjection({ volume: -6, fingerprint: "f2" }));

    // Same meter object identity, and no net node created or disposed.
    expect(master.levelMeter).toBe(meterBefore);
    expect(runtime.diagnostics().resources.byOwner.p).toBe(nodeCountBefore);

    master.dispose();
    await runtime.close();
  });

  it("disposes every node it owns, idempotently", async () => {
    const runtime = new AudioRuntimeModule.AudioRuntime();
    const scope = runtime.openProjectScope("p");
    const master = new MasterAudioGraphModule.MasterAudioGraph(
      scope,
      runtime.getDestination(),
    );
    master.reconcile(masterProjection({ devices: [passthroughDevice(0)] }));
    expect(runtime.diagnostics().resources.byOwner.p).toBeGreaterThan(0);

    master.dispose();
    master.dispose(); // idempotent
    await Promise.resolve();

    expect(runtime.diagnostics().resources.byOwner.p).toBeUndefined();
    await runtime.close();
  });
});
