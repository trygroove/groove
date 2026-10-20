import { describe, expect, it } from "vitest";
import { createDevice } from "../../domain/devices";
import type { Project } from "../../domain/entities";
import { createPianoRollFixtureProject } from "../../domain/fixtures";
import type { DeviceId } from "../../domain/ids";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH, type Ticks } from "../../domain/time";
import { buildAudioProjection } from "../../projection/audioProjection";
import { deviceTailSeconds, estimateTailSeconds } from "./tailEstimate";

const device = (type: "reverb" | "delay" | "filter", parameters = {}) => ({
  ...createDevice("dev_t" as DeviceId, type, 0),
  parameters: { ...createDevice("dev_t" as DeviceId, type, 0).parameters, ...parameters },
});

describe("deviceTailSeconds", () => {
  it("is zero for a device that does not ring and for a bypassed one", () => {
    expect(deviceTailSeconds(device("filter"), 120)).toBe(0);
    expect(deviceTailSeconds({ ...device("reverb"), bypassed: true }, 120)).toBe(0);
  });

  it("rings a reverb for no longer than its impulse", () => {
    const tail = deviceTailSeconds(device("reverb", { decay: 4, size: 0.5 }), 120);
    expect(tail).toBeGreaterThan(1);
    expect(tail).toBeLessThanOrEqual(4 + 0.01 + 0.025 + 0.05);
  });

  it("rings a delay for its repeats, and longer at higher feedback", () => {
    const low = deviceTailSeconds(device("delay", { feedback: 0.3 }), 120);
    const high = deviceTailSeconds(device("delay", { feedback: 0.8 }), 120);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });

  it("is silent when the effect is fully dry", () => {
    expect(deviceTailSeconds(device("reverb", { wet: 0 }), 120)).toBe(0);
    expect(deviceTailSeconds(device("delay", { wet: 0 }), 120)).toBe(0);
  });
});

/** A one-bar song at 120 BPM: one 16th of synth on `sixteenth`, through `devices`. */
function oneNoteSong(
  sixteenth: number,
  devices: Project["song"]["tracks"][number]["devices"],
) {
  const project = createPianoRollFixtureProject();
  const [clip] = project.clips;
  if (clip.content.kind !== "notes") throw new Error("expected a note clip");
  const note = {
    ...clip.content.events[0],
    startTicks: (sixteenth * TICKS_PER_SIXTEENTH) as Ticks,
  };
  const length = TICKS_PER_BAR as Ticks;
  return buildAudioProjection({
    ...project,
    clips: [{ ...clip, lengthTicks: length, content: { kind: "notes", events: [note] } }],
    song: {
      ...project.song,
      tracks: project.song.tracks.map((track) => ({ ...track, devices })),
      placements: project.song.placements.map((p) => ({ ...p, durationTicks: length })),
    },
  });
}

// GRV-162: the tails a Chromium render of these songs actually keeps. The
// renderer trims at -100 dBFS, so a tail is as long as it takes to fall that
// far from where it starts, and it starts well under full scale.
describe("estimateTailSeconds", () => {
  it("counts no tail for a default reverb that dies before a one-bar song ends", () => {
    // QA's case: rendered, both stems were exactly the song's 2 s.
    const tail = estimateTailSeconds(oneNoteSong(0, [device("reverb")]), 30);
    expect(tail).toBeLessThan(0.1);
  });

  it("counts close to the tail a default reverb rings past the song", () => {
    // A note on the last 16th: Chromium keeps 1.845 s past the song.
    const tail = estimateTailSeconds(oneNoteSong(15, [device("reverb")]), 30);
    expect(Math.abs(tail - 1.845)).toBeLessThan(0.25);
  });

  it("counts close to the repeats a default delay rings past the song", () => {
    // Chromium keeps 2.749 s past the song.
    const tail = estimateTailSeconds(oneNoteSong(15, [device("delay")]), 30);
    expect(Math.abs(tail - 2.749)).toBeLessThan(0.25);
  });
});
