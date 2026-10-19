import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDevice } from "../domain/devices";
import type { Project } from "../domain/entities";
import { createFactoryContext, createReturnBus, createSend } from "../domain/factories";
import {
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import { createSeededIdFactory, type DeviceId } from "../domain/ids";
import { stringifyProject } from "../domain/serialize";
import { buildAudioProjection } from "../projection/audioProjection";
import type { Scheduler } from "../shared/scheduler";
import { installWebAudioGlobals, rms } from "./testAudioContext";

// Must run before Tone is imported — see AudioRuntime.test.ts for why.
installWebAudioGlobals();

let Tone: typeof import("tone");
let renderer: typeof import("./offlineRenderer");
let registryModule: typeof import("./resourceRegistry");
let runtimeModule: typeof import("./AudioRuntime");

beforeAll(async () => {
  Tone = await import("tone");
  renderer = await import("./offlineRenderer");
  registryModule = await import("./resourceRegistry");
  runtimeModule = await import("./AudioRuntime");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await runtimeModule.getAudioRuntime().close();
  runtimeModule.__resetAudioRuntimeForTests();
});

const RATE = 22_050;

/** A loader handing every asset the same short decaying tone. */
function toneLoader() {
  return {
    async load() {
      const data = Float32Array.from(
        { length: 2_205 },
        (_, i) => Math.sin(i / 4) * (1 - i / 2_205),
      );
      return Tone.ToneAudioBuffer.fromArray(data);
    },
  };
}

function nativeContexts(created: OfflineAudioContext[] = []) {
  const construct = (target: typeof OfflineAudioContext, args: unknown[]) =>
    created[created.push(Reflect.construct(target, args)) - 1];
  vi.stubGlobal("OfflineAudioContext", new Proxy(OfflineAudioContext, { construct }));
  return created;
}

async function render(
  project: Project,
  extra: Partial<import("./offlineRenderer").OfflineRenderOptions> = {},
) {
  const registry = new registryModule.ResourceRegistry();
  const outcome = renderer.renderProjectOffline(buildAudioProjection(project), {
    sampleRate: RATE,
    maxTailSeconds: 1,
    bufferLoader: toneLoader(),
    registry,
    ...extra,
  });
  return { outcome, registry };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as import("./offlineRenderer").OfflineRenderError;
  }
  throw new Error("expected the render to reject");
}

describe("renderProjectOffline", () => {
  it("renders a synth song to stereo audio and releases everything it built", async () => {
    const live = Tone.getContext();
    const progress: number[] = [];
    const { outcome, registry } = await render(createPianoRollFixtureProject(), {
      onProgress: (fraction) => {
        progress.push(fraction);
        // Between the synchronous spans, the live context is the global one.
        expect(Tone.getContext()).toBe(live);
      },
    });
    const result = await outcome;

    expect(result.channels).toHaveLength(2);
    expect(result.sampleRate).toBe(RATE);
    // Two bars at 120 BPM.
    expect(result.songEndSeconds).toBe(4);
    expect(result.frames).toBeGreaterThanOrEqual(4 * RATE);
    expect(rms(result.channels[0])).toBeGreaterThan(0.001);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(registry.isEmpty()).toBe(true);
    expect(Tone.getContext()).toBe(live);
  });

  it("builds sampler voices in the render, not in the live context", async () => {
    const { outcome, registry } = await render(createSliceFixtureProject());
    const result = await outcome;
    // The four-on-the-floor kick only sounds if every voice built inside a
    // scheduled callback landed in the offline graph.
    const beat = RATE / 2; // one beat at 120 BPM
    for (let i = 0; i < 4; i++) {
      const window = result.channels[0].subarray(i * beat, i * beat + 2_000);
      expect(rms(window), `beat ${i + 1}`).toBeGreaterThan(0.01);
    }
    expect(registry.isEmpty()).toBe(true);
  });

  it("renders nothing for a song with nothing placed", async () => {
    const project = createPianoRollFixtureProject();
    const empty = { ...project, song: { ...project.song, placements: [] } };
    const result = await (await render(empty)).outcome;
    expect(result.frames).toBe(0);
    expect(result.channels.map((c) => c.length)).toEqual([0, 0]);
  });

  it("neither mutates the project nor its projection", async () => {
    const project = createSliceFixtureProject();
    const before = stringifyProject(project);
    const projection = deepFreeze(buildAudioProjection(project));
    await renderer.renderProjectOffline(projection, {
      sampleRate: RATE,
      maxTailSeconds: 1,
      bufferLoader: toneLoader(),
    });
    expect(stringifyProject(project)).toBe(before);
  });

  it("leaves a live project graph and the live transport as they were", async () => {
    const runtime = runtimeModule.getAudioRuntime();
    const graphModule = await import("./ProjectAudioGraph");
    const live = new graphModule.ProjectAudioGraph(runtime, "live-project", {
      transport: { bpm: { value: 97 }, schedule: () => 1, clear: () => {} },
      bufferLoader: toneLoader(),
    });
    live.reconcile(buildAudioProjection(createSliceFixtureProject({ tempo: 97 })));
    const liveCounts = runtime.registry.counts();
    const liveBpm = Tone.getTransport().bpm.value;

    await (await render(createPianoRollFixtureProject({ tempo: 150 }))).outcome;

    expect(runtime.registry.counts()).toEqual(liveCounts);
    expect(Tone.getTransport().bpm.value).toBe(liveBpm);
    expect(live.diagnostics().tracks).toBe(1);
    await live.dispose();
  });
});

/** The piano-roll fixture with one return, fed by the Lead's send when `send`. */
function withReturn(send: boolean): Project {
  const project = createPianoRollFixtureProject();
  const context = createFactoryContext({ ids: createSeededIdFactory(7), now: 0 });
  const bus = createReturnBus(context, { name: "Verb", order: 0 });
  const [lead] = project.song.tracks;
  return {
    ...project,
    song: {
      ...project.song,
      returns: [bus],
      tracks: [{ ...lead, sendConfig: send ? [createSend(bus.id, 1)] : [] }],
    },
  };
}

describe("renderProjectOffline determinism (#867)", () => {
  it("renders an unchanged song with a reverb identically every time", async () => {
    // A reverb's tail sets where the render is trimmed, and its impulse
    // response is noise: two exports of one project must still be one file.
    const project = withReturn(true);
    const [bus] = project.song.returns;
    const device = createDevice("dev_reverb" as DeviceId, "reverb", 0);
    // A long decay, so the tail rings past the last clip and sets the length.
    const reverb = { ...device, parameters: { ...device.parameters, decay: 6 } };
    const reverbed: Project = {
      ...project,
      song: { ...project.song, returns: [{ ...bus, devices: [reverb] }] },
    };
    const first = await (await render(reverbed, { maxTailSeconds: 4 })).outcome;
    const second = await (await render(reverbed, { maxTailSeconds: 4 })).outcome;

    expect(first.frames).toBeGreaterThan(first.songEndSeconds * RATE);
    expect(second.frames).toBe(first.frames);
    for (const channel of [0, 1]) {
      expect(second.channels[channel]).toEqual(first.channels[channel]);
    }
  });
});

describe("renderProjectOffline with a shaper on the master (#962)", () => {
  it("ends at the song's real tail, not at the render budget, with an overdrive on the master", async () => {
    const project = createSliceFixtureProject();
    // Default settings: an asymmetric curve, which is what once turned the
    // silence after the song into a constant offset that never trimmed.
    const overdrive = createDevice("dev_overdrive" as DeviceId, "overdrive", 0);
    const driven: Project = {
      ...project,
      song: {
        ...project.song,
        master: { ...project.song.master, devices: [overdrive] },
      },
    };
    const result = await (await render(driven, { maxTailSeconds: 4 })).outcome;

    expect(result.tailTruncated).toBe(false);
    // The fixture's voices are short: anything near the 4 s budget is a
    // constant offset being kept as if it were sound.
    expect(result.frames).toBeLessThan((result.songEndSeconds + 1) * RATE);
  });
});

describe("renderProjectOffline with a new project's master Limiter (#937)", () => {
  it("holds the export under the ceiling however hard it is driven, and still ends on time", async () => {
    const project = createSliceFixtureProject();
    const limiter = createDevice("dev_limiter" as DeviceId, "limiter", 0);
    const pushed: Project = {
      ...project,
      song: {
        ...project.song,
        master: {
          ...project.song.master,
          devices: [{ ...limiter, parameters: { ...limiter.parameters, drive: 24 } }],
          safetyLimiter: false,
        },
      },
    };
    const result = await (await render(pushed, { maxTailSeconds: 2 })).outcome;

    const ceiling = 10 ** (-0.3 / 20);
    let peak = 0;
    for (const channel of result.channels) {
      for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
    }
    expect(peak).toBeGreaterThan(ceiling * 0.9);
    expect(peak).toBeLessThanOrEqual(ceiling + 1e-6);
    expect(result.tailTruncated).toBe(false);
  });
});

describe("renderProjectOffline with tracksSendOnly (a return's stem)", () => {
  it("silences every track's direct output, so only what reaches a return sounds", async () => {
    const dry = await (await render(withReturn(false), { tracksSendOnly: true })).outcome;
    expect(rms(dry.channels[0])).toBe(0);

    const { outcome, registry } = await render(withReturn(true), {
      tracksSendOnly: true,
    });
    const wet = await outcome;
    expect(rms(wet.channels[0])).toBeGreaterThan(0.001);
    expect(registry.isEmpty()).toBe(true);
  });

  it("is off by default: a track with no send still sounds", async () => {
    const result = await (await render(withReturn(false))).outcome;
    expect(rms(result.channels[0])).toBeGreaterThan(0.001);
  });
});

describe("renderProjectOffline cancellation and failure", () => {
  it("rejects a render cancelled before it starts without building anything", async () => {
    const controller = new AbortController();
    controller.abort();
    const { outcome, registry } = await render(createPianoRollFixtureProject(), {
      signal: controller.signal,
    });
    const error = await rejection(outcome);
    expect(error).toBeInstanceOf(renderer.OfflineRenderError);
    expect(error.code).toBe("aborted");
    expect(error.cancelled).toBe(true);
    expect(registry.snapshot()).toEqual([]);
  });

  it("stops mid-render when cancelled, and releases every offline resource", async () => {
    const live = Tone.getContext();
    const contexts = nativeContexts();
    const controller = new AbortController();
    const yields: unknown[] = [];
    const scheduler: Scheduler = {
      schedule(callback, delayMs) {
        yields.push(Tone.getContext());
        const handle = setTimeout(callback, delayMs);
        return () => clearTimeout(handle);
      },
    };
    const { outcome, registry } = await render(createPianoRollFixtureProject(), {
      // A long tail budget so the clock yields several times.
      maxTailSeconds: 20,
      scheduler,
      signal: controller.signal,
      onProgress: (fraction) => {
        if (fraction > 0.2) controller.abort();
      },
    });
    const error = await rejection(outcome);
    expect(error.code).toBe("aborted");
    expect(registry.isEmpty()).toBe(true);
    expect(contexts.map((context) => context.state)).toEqual(["closed"]);
    expect(yields.length).toBeGreaterThan(0);
    for (const context of yields) expect(context).toBe(live);
    expect(Tone.getContext()).toBe(live);
  });

  it("fails as a render failure mid-render, and still finishes the render", async () => {
    const contexts = nativeContexts();
    const { outcome } = await render(createPianoRollFixtureProject(), {
      maxTailSeconds: 20,
      onProgress: (fraction) => {
        if (fraction > 0.5) throw new Error("bug");
      },
    });
    expect((await rejection(outcome)).code).toBe("render_failed");
    expect(contexts.map((context) => context.state)).toEqual(["closed"]);
  });

  it("fails with a decode error when an asset will not load, and releases everything", async () => {
    const { outcome, registry } = await render(createSliceFixtureProject(), {
      bufferLoader: {
        load: async () => {
          throw new Error("not audio");
        },
      },
    });
    const error = await rejection(outcome);
    expect(error.code).toBe("decode_failed");
    expect(error.cancelled).toBe(false);
    // Only the asset's id may reach an error report, never its name or URL.
    expect(error.message).not.toMatch(/909|samples\//);
    expect(registry.isEmpty()).toBe(true);
  });

  // #78: a project whose only sound is in a withdrawn pack still exports, as
  // the song's length of silence, and says which sound it went without.
  it("renders a reported-missing sound that will not load as silence", async () => {
    const project = createSliceFixtureProject();
    const ids = project.song.assets.map((asset) => asset.id);
    const { outcome, registry } = await render(project, {
      missingAssetIds: new Set(ids),
      bufferLoader: {
        load: async () => {
          throw new Error("withdrawn");
        },
      },
    });
    const result = await outcome;
    expect(result.silencedAssetIds).toEqual(ids);
    expect(result.frames).toBeGreaterThanOrEqual(result.songEndSeconds * RATE);
    expect(rms(result.channels[0])).toBe(0);
    expect(registry.isEmpty()).toBe(true);
  });

  it("fails as a render failure when the graph cannot be built, and restores the live context", async () => {
    const live = Tone.getContext();
    const { outcome, registry } = await render(createPianoRollFixtureProject(), {
      createInstrument: () => {
        throw new Error("bug");
      },
    });
    const error = await rejection(outcome);
    expect(error.code).toBe("render_failed");
    expect(registry.isEmpty()).toBe(true);
    expect(Tone.getContext()).toBe(live);
  });
});

// GRV-55: a render the browser has no memory for says so, not "internal".
describe("renderProjectOffline out of memory (GRV-55)", () => {
  it("fails as out of memory when an allocation fails", async () => {
    const { outcome } = await render(createPianoRollFixtureProject(), {
      onProgress: () => {
        throw new RangeError("Array buffer allocation failed");
      },
    });
    expect((await rejection(outcome)).code).toBe("out_of_memory");
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    if (value instanceof Map) for (const child of value.values()) deepFreeze(child);
  }
  return value;
}
