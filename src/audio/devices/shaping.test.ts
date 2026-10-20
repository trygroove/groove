import { beforeAll, describe, expect, it } from "vitest";
import { createDevice, defaultDeviceParameters } from "../../domain/devices";
import type { Device } from "../../domain/entities";
import type { DeviceId } from "../../domain/ids";
import { hfEnergy, installWebAudioGlobals, rms } from "../testAudioContext";

// Must run before Tone is imported — see AudioRuntime.test.ts for why.
installWebAudioGlobals();

let Tone: typeof import("tone");
let deviceNode: typeof import("./deviceNode");
let filter: typeof import("./filter");
let distortion: typeof import("./distortion");

beforeAll(async () => {
  Tone = await import("tone");
  deviceNode = await import("./deviceNode");
  filter = await import("./filter");
  distortion = await import("./distortion");
});

const context = { scope: null as never, tempo: () => 120 };

function device(
  type: Parameters<typeof createDevice>[1],
  overrides: Record<string, number> = {},
  bypassed = false,
): Device {
  return {
    ...createDevice("dev_shaping" as DeviceId, type, 0),
    bypassed,
    parameters: { ...defaultDeviceParameters(type), ...overrides },
  };
}

/**
 * Renders a fixed oscillator through one device node and returns the mono
 * channel.
 *
 * The waveform matters, and the two used here are chosen deliberately:
 *
 * - A **sine** at a moderate level is the probe for *distortion*. It carries
 *   almost no high-frequency energy of its own, so every harmonic `hfEnergy`
 *   reports is one the device added — which makes the measurement a claim
 *   about the transfer curve rather than about the source.
 * - A **sawtooth** is the probe for *filtering*. It has energy at every
 *   harmonic, so a cutoff moving up or down changes `hfEnergy` monotonically.
 *
 * Using a sawtooth to measure distortion (the first thing tried here) does not
 * work: it is already harmonically dense and near full scale, so it clips at
 * every drive setting and the measurement barely moves.
 */
async function render(
  build: (d: Device) => import("../DeviceChain").DeviceNode,
  d: Device,
  options: { wave?: "sine" | "sawtooth"; level?: number } = {},
): Promise<Float32Array> {
  const buffer = await Tone.Offline(() => {
    const node = build(d);
    const osc = new Tone.Oscillator({
      type: options.wave ?? "sawtooth",
      frequency: 220,
      volume: Tone.gainToDb(options.level ?? 1),
    });
    osc.connect(node.input);
    node.output.toDestination();
    osc.start(0);
  }, 0.4);
  return buffer.getChannelData(0);
}

/** A moderate sine — the distortion probe described on `render`. */
const SINE = { wave: "sine", level: 0.3 } as const;

const buildFilter = (d: Device) =>
  deviceNode.buildDeviceNode(d, context, filter.createFilterCore);
const buildOverdrive = (d: Device) =>
  deviceNode.buildDeviceNode(d, context, distortion.createOverdriveCore);
const buildSaturator = (d: Device) =>
  deviceNode.buildDeviceNode(d, context, distortion.createSaturatorCore);

/** Discards the smoothing ramp at the head so a measurement reads the settled
 * signal rather than the fade-in every ramped parameter starts with. */
function settled(data: Float32Array): Float32Array {
  return data.subarray(Math.floor(data.length * 0.5));
}

/**
 * Harmonic content per unit of level, taken as the median over equal slices of
 * the settled signal rather than over the whole of it.
 *
 * `hfEnergy` is a first-difference measure, so one stray sample (a click, a
 * block the offline renderer produced late) lands in it at full weight and
 * can swing a whole-buffer ratio past the 14-30% gap between drive settings.
 * That happened once in 6,919 CI runs (GRV-198) and never locally. A median
 * of slices ignores a glitch confined to one slice, while a real change in
 * the transfer curve moves every slice, so the property under test is intact.
 */
function medianBrightness(data: Float32Array, slices = 8): number {
  const size = Math.floor(data.length / slices);
  const values = Array.from({ length: slices }, (_, i) => {
    const slice = data.subarray(i * size, (i + 1) * size);
    return hfEnergy(slice) / rms(slice);
  }).sort((a, b) => a - b);
  return values[Math.floor(slices / 2)];
}

describe("filter device (FX-01)", () => {
  it("removes high-frequency energy as the cutoff closes", async () => {
    const open = settled(await render(buildFilter, device("filter", { cutoff: 18_000 })));
    const closed = settled(await render(buildFilter, device("filter", { cutoff: 300 })));
    expect(hfEnergy(closed)).toBeLessThan(hfEnergy(open) * 0.5);
  });

  it("passes highs and cuts lows in high-pass mode", async () => {
    const low = settled(
      await render(buildFilter, device("filter", { mode: 0, cutoff: 2_000 })),
    );
    const high = settled(
      await render(buildFilter, device("filter", { mode: 1, cutoff: 2_000 })),
    );
    // At the same cutoff the two modes are complementary, so the high-pass
    // keeps proportionally far more high-frequency energy per unit of level.
    expect(hfEnergy(high) / rms(high)).toBeGreaterThan(hfEnergy(low) / rms(low));
  });

  it("stays stable and finite at the top of its deliberately extreme resonance (FX-02)", async () => {
    const data = settled(
      await render(buildFilter, device("filter", { cutoff: 500, resonance: 30 })),
    );
    expect(data.every((s) => Number.isFinite(s))).toBe(true);
    // Bounded: a self-resonant sweep is loud and creative, not a runaway.
    expect(Math.max(...data.map(Math.abs))).toBeLessThan(8);
  });

  it("changes mode without replacing the node", async () => {
    const node = buildFilter(device("filter", { mode: 0 }));
    const before = node.input;
    node.update(device("filter", { mode: 2 }));
    expect(node.input).toBe(before);
    node.dispose();
  });
});

describe("overdrive and saturator (FX-01, FX-02)", () => {
  it("adds harmonics as drive climbs, from coloration to destruction", async () => {
    const clean = settled(
      await render(buildOverdrive, device("overdrive", { drive: 0, tone: 1 }), SINE),
    );
    const pushed = settled(
      await render(buildOverdrive, device("overdrive", { drive: 0.5, tone: 1 }), SINE),
    );
    const destroyed = settled(
      await render(buildOverdrive, device("overdrive", { drive: 1, tone: 1 }), SINE),
    );
    // Harmonic content per unit of level rises monotonically with drive —
    // normalising by RMS is what makes this a claim about *distortion* rather
    // than about the device simply getting louder.
    const brightness = medianBrightness;
    expect(brightness(pushed)).toBeGreaterThan(brightness(clean));
    expect(brightness(destroyed)).toBeGreaterThan(brightness(pushed));
  });

  // #962: an asymmetric curve must not leave a DC offset, either on silence
  // (which kept an export's tail from ever trimming) or under the music.
  it("passes silence through the overdrive as silence", async () => {
    const data = settled(
      await render(buildOverdrive, device("overdrive", { wet: 1 }), { level: 0 }),
    );
    expect(Math.max(...data.map(Math.abs))).toBeLessThan(1e-6);
  });

  it("adds no DC offset to the music it drives", async () => {
    const data = settled(
      await render(buildOverdrive, device("overdrive", { drive: 1, wet: 1 }), SINE),
    );
    // 0.2 s of a 220 Hz sine is a whole number of cycles, so any mean is DC.
    const mean = data.reduce((sum, s) => sum + s, 0) / data.length;
    expect(Math.abs(mean)).toBeLessThan(10 ** (-80 / 20));
  });

  it("darkens with the overdrive tone control", async () => {
    const dark = settled(
      await render(buildOverdrive, device("overdrive", { drive: 0.6, tone: 0 })),
    );
    const bright = settled(
      await render(buildOverdrive, device("overdrive", { drive: 0.6, tone: 1 })),
    );
    expect(hfEnergy(dark)).toBeLessThan(hfEnergy(bright));
  });

  // #925: Overdrive at Drive 0 is its cleanest setting, so a quiet sine leaves
  // at its own level, and a sine past full scale is rounded by the knee rather
  // than flattened by the curve table's edge.
  describe("at drive 0 (#925)", () => {
    const clean = device("overdrive", { drive: 0, tone: 1, wet: 1, output: 0 });
    const sine = (dbfs: number) => ({ wave: "sine", level: 10 ** (dbfs / 20) }) as const;
    const peak = (data: Float32Array) =>
      data.reduce((m, s) => Math.max(m, Math.abs(s)), 0);

    it("passes a -30 dBFS sine near unity", async () => {
      const data = settled(await render(buildOverdrive, clean, sine(-30)));
      expect(20 * Math.log10(peak(data))).toBeCloseTo(-30, 0);
    });

    it("rounds a +3 dBFS sine instead of holding it flat at the table's end", async () => {
      const data = settled(await render(buildOverdrive, clean, sine(3)));
      const top = data.reduce((m, s) => Math.max(m, s), 0);
      const bottom = data.reduce((m, s) => Math.min(m, s), 0);
      // A table that ends at full scale holds every sample over it at the end
      // value: a quarter of each cycle sits flat at the positive peak. A knee
      // only touches its peak for an instant.
      const flat = (edge: number) => data.filter((s) => Math.abs(s - edge) < 1e-4).length;
      expect(flat(top) / data.length).toBeLessThan(0.02);
      expect(flat(bottom) / data.length).toBeLessThan(0.02);
      // Still saturated: the knee, not the input, sets the peak.
      expect(peak(data)).toBeLessThan(1);
    });
  });

  it("keeps the saturator's output bounded at its most extreme drive", async () => {
    const data = settled(
      await render(buildSaturator, device("saturator", { drive: 48, character: 1 })),
    );
    expect(data.every((s) => Number.isFinite(s))).toBe(true);
    // Every curve table is clamped to ±1, so however hard it is driven the
    // device cannot hand an unsafe sample to the rest of the chain (FX-02).
    expect(Math.max(...data.map(Math.abs))).toBeLessThanOrEqual(1.0001);
  });

  // #885: at Drive 0 dB the device is meant to be the cleanest it gets, so a
  // quiet sine comes out at its own level on either leg, and a sine past full
  // scale is rounded by the knee rather than flattened by the table's edge.
  describe("at 0 dB drive (#885)", () => {
    const clean = (character: number) =>
      device("saturator", { drive: 0, character, wet: 1, output: 0 });
    const sine = (dbfs: number) => ({ wave: "sine", level: 10 ** (dbfs / 20) }) as const;
    const peakDb = (data: Float32Array) =>
      20 * Math.log10(data.reduce((m, s) => Math.max(m, Math.abs(s)), 0));

    it.each([0, 1])(
      "passes a -30 dBFS sine near unity at character %s",
      async (character) => {
        const data = settled(await render(buildSaturator, clean(character), sine(-30)));
        expect(peakDb(data)).toBeCloseTo(-30, 0);
      },
    );

    it("rounds a +3 dBFS sine instead of flat-topping it at exactly full scale", async () => {
      const data = settled(await render(buildSaturator, clean(0), sine(3)));
      const pinned = data.filter((s) => Math.abs(s) >= 0.9999).length;
      expect(pinned).toBe(0);
      // Still saturated: the knee, not the input, sets the peak.
      expect(peakDb(data)).toBeLessThan(0);
    });

    it("keeps the fold leg sounding at and above full scale", async () => {
      const soft = settled(await render(buildSaturator, clean(0), sine(3)));
      const fold = settled(await render(buildSaturator, clean(1), sine(3)));
      // A fold that collapses to 0 at ±1 loses most of a hot sine's energy.
      expect(rms(fold)).toBeGreaterThan(rms(soft) * 0.7);
    });
  });

  it("moves from a soft knee toward a hard fold with character", async () => {
    // Measured where the fold has turned over: both curves are unity near 0
    // (#885), and below its peak the sine is if anything gentler than the tanh,
    // so the two only part once the drive pushes the signal past the fold
    // (18 dB lifts this 0.3 sine to about 2.4, well over the fold's peak at
    // pi/2 and still inside the tables' ±4 span).
    const soft = settled(
      await render(
        buildSaturator,
        device("saturator", { drive: 18, character: 0 }),
        SINE,
      ),
    );
    const hard = settled(
      await render(
        buildSaturator,
        device("saturator", { drive: 18, character: 1 }),
        SINE,
      ),
    );
    expect(hfEnergy(hard) / rms(hard)).toBeGreaterThan(hfEnergy(soft) / rms(soft));
  });
});
