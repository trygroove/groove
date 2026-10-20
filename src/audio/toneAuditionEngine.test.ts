import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LibraryAsset } from "../library/manifest";
import { installWebAudioGlobals, rms } from "./testAudioContext";

// The library audition engine is the other Tone-touching path besides the
// project graph, so its audible behaviour is asserted here, in the audio
// suite, against a rendered graph: a headless browser cannot hear (#43).
installWebAudioGlobals();

let Tone: typeof import("tone");
let engineModule: typeof import("./toneAuditionEngine");
let runtimeModule: typeof import("./AudioRuntime");
let auditionModule: typeof import("../library/audition");

beforeAll(async () => {
  Tone = await import("tone");
  engineModule = await import("./toneAuditionEngine");
  runtimeModule = await import("./AudioRuntime");
  auditionModule = await import("../library/audition");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SAMPLE_RATE = 44_100;

function loopAsset(overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id: "sg-loop-drums-beat-0001",
    name: "Beat",
    type: "loop",
    family: "drums",
    role: "beat",
    genres: ["house"],
    characters: ["punchy"],
    packId: "pak_test",
    packSlug: "core-electronic-drums",
    packName: "Core Electronic Drums",
    packVersion: "1.0.0",
    url: "/samples/starter-library/audio/loop.wav",
    storageKey: "loop.wav",
    durationSeconds: 2,
    sampleRate: SAMPLE_RATE,
    channelCount: 1,
    bpm: 120,
    bars: 1,
    peaks: null,
    licence: "solid-groove-owned",
    ...overrides,
  };
}

/** Serve `samples` as the decoded audio for every asset URL the engine loads. */
function serveDecodedAudio(samples: Float32Array<ArrayBuffer>): void {
  vi.spyOn(Tone.ToneAudioBuffer, "load").mockImplementation(async () => {
    const context = Tone.getContext().rawContext as unknown as {
      createBuffer(channels: number, length: number, rate: number): AudioBuffer;
    };
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    return buffer;
  });
}

/** Two seconds of a 220 Hz sine at half scale: a loop that is plainly audible. */
function sineLoop(): Float32Array<ArrayBuffer> {
  const samples = new Float32Array(SAMPLE_RATE * 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
  }
  return samples;
}

/**
 * Audition `asset` with the *transport stopped* — a producer browsing the
 * library, not playing the song — and render what reaches the destination.
 */
async function renderAudition(
  asset: LibraryAsset,
  songTempo: number,
): Promise<Float32Array> {
  const rendered = await Tone.Offline(
    async ({ destination }) => {
      const runtime = new runtimeModule.AudioRuntime();
      const host: import("./AudioRuntime").AudioHost = {
        getDestination: () => destination,
        getSampleRate: () => SAMPLE_RATE,
        resume: async () => {},
        openProjectScope: (owner) => runtime.openProjectScope(owner),
      };
      const engine = new engineModule.ToneAuditionEngine(host, {
        songTempo: () => songTempo,
      });
      await engine.start(asset, {
        sync: auditionModule.auditionsInSync(asset),
      });
    },
    1,
    1,
    SAMPLE_RATE,
  );
  return Float32Array.from(rendered.getChannelData(0));
}

describe("ToneAuditionEngine loop audition (#330, LIB-01/INS-02)", () => {
  it("is audible when auditioned with the transport stopped", async () => {
    serveDecodedAudio(sineLoop());
    const output = await renderAudition(loopAsset(), 120);
    // A sine at 0.5 peak has an RMS of ~0.35. The pre-fix engine scheduled
    // the loop on a transport that never starts, so it rendered pure silence.
    expect(rms(output)).toBeGreaterThan(0.1);
  });

  it("follows the project tempo by time-stretching, with its pitch untouched", async () => {
    serveDecodedAudio(sineLoop());
    const grainStart = vi.spyOn(Tone.GrainPlayer.prototype, "start");

    // A loop authored at 90 BPM auditioned in a 120 BPM project.
    const output = await renderAudition(loopAsset({ bpm: 90 }), 120);

    expect(grainStart).toHaveBeenCalledTimes(1);
    const player = grainStart.mock.instances[0] as import("tone").GrainPlayer;
    expect(player.playbackRate).toBeCloseTo(120 / 90);
    expect(player.detune).toBe(0);
    expect(rms(output)).toBeGreaterThan(0.05);
  });

  it("reports a loop that decodes to silence instead of playing it quietly", async () => {
    serveDecodedAudio(new Float32Array(SAMPLE_RATE));
    await expect(renderAudition(loopAsset(), 120)).rejects.toMatchObject({
      name: "AuditionError",
      reason: "decode_failed",
    });
  });
});
