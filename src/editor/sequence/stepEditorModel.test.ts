import { describe, expect, it } from "vitest";
import {
  createDenseStepFixtureProject,
  createDrumMachineFixtureProject,
  createSliceFixtureProject,
  DENSE_STEP_FIXTURE_BARS,
} from "../../domain/fixtures";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";
import {
  barCount,
  barOptions,
  eventCountBucket,
  isBarStart,
  isBeatStart,
  isShadedBeat,
  lanesFor,
  MAX_BARS,
  noteAt,
  playbackStep,
  SAMPLER_LANE_PITCH,
  STEPS_PER_BAR,
  selectedLane,
  stepCount,
  stepStartTicks,
  triggersMatch,
} from "./stepEditorModel";

describe("stepEditorModel", () => {
  it("shades beats in alternating groups of four (#643)", () => {
    const shaded = Array.from({ length: 16 }, (_, step) => isShadedBeat(step));
    expect(shaded.slice(0, 4)).toEqual([true, true, true, true]);
    expect(shaded.slice(4, 8)).toEqual([false, false, false, false]);
    expect(isShadedBeat(8)).toBe(true);
    expect(isShadedBeat(12)).toBe(false);
  });

  it("selects the row a key names, else the first row (#643)", () => {
    const drum = createDrumMachineFixtureProject().song.tracks[0];
    const lanes = lanesFor(drum.instrument);
    expect(selectedLane(lanes, lanes[1].key)).toBe(lanes[1]);
    expect(selectedLane(lanes, "pad_gone")).toBe(lanes[0]);
    expect(selectedLane(lanes, null)).toBe(lanes[0]);
    expect(selectedLane([], null)).toBeNull();
  });

  it("derives a single pitched lane for a sampler clip", () => {
    const project = createSliceFixtureProject();
    const lanes = lanesFor(project.song.tracks[0].instrument);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].trigger).toEqual({
      kind: "pitch",
      pitch: SAMPLER_LANE_PITCH,
    });
  });

  it("derives one named lane per pad for a drum-machine clip", () => {
    const project = createDrumMachineFixtureProject();
    const drum = project.song.tracks.find(
      (track) => track.instrument?.kind === "drumMachine",
    );
    const instrument = drum?.instrument;
    if (instrument?.kind !== "drumMachine") throw new Error("expected pads");
    const lanes = lanesFor(instrument);
    expect(lanes.map((lane) => lane.name)).toEqual(["BD", "CP"]);
    expect(lanes.map((lane) => lane.trigger)).toEqual(
      instrument.pads.map((pad) => ({ kind: "pad", padId: pad.id })),
    );
  });

  it("counts steps from the clip's bar length, up to the 32-bar maximum", () => {
    const project = createSliceFixtureProject();
    const clip = project.clips[0];
    expect(barCount(clip)).toBe(1);
    expect(stepCount(clip)).toBe(STEPS_PER_BAR);

    const twelveBars = {
      ...clip,
      lengthTicks: (TICKS_PER_BAR * 12) as typeof clip.lengthTicks,
    };
    // Twelve bars used to clamp to eight, hiding a third of the clip (#256).
    expect(barCount(twelveBars)).toBe(12);
    expect(stepCount(twelveBars)).toBe(12 * STEPS_PER_BAR);

    const overMax = {
      ...clip,
      lengthTicks: (TICKS_PER_BAR * 40) as typeof clip.lengthTicks,
    };
    expect(barCount(overMax)).toBe(MAX_BARS);
    expect(MAX_BARS).toBe(32);
  });

  it("offers the musical bar lengths, plus the clip's own when unlisted", () => {
    const project = createSliceFixtureProject();
    const clip = project.clips[0];
    expect(barOptions(clip)).toEqual([1, 2, 4, 8, 16, 32]);

    const threeBars = {
      ...clip,
      lengthTicks: (TICKS_PER_BAR * 3) as typeof clip.lengthTicks,
    };
    expect(barOptions(threeBars)).toEqual([1, 2, 3, 4, 8, 16, 32]);
  });

  it("marks bar and beat starts distinctly across two bars", () => {
    // A bar start is also a beat start; a beat start is not a bar start.
    expect(isBarStart(0)).toBe(true);
    expect(isBeatStart(0)).toBe(true);
    expect(isBarStart(4)).toBe(false);
    expect(isBeatStart(4)).toBe(true);
    expect(isBarStart(STEPS_PER_BAR)).toBe(true);
    expect(isBeatStart(5)).toBe(false);
  });

  it("finds a note only when its start tick and trigger match the lane", () => {
    const project = createSliceFixtureProject();
    const clip = project.clips[0];
    const [lane] = lanesFor(project.song.tracks[0].instrument);
    // The slice clip is four-on-the-floor: steps 0, 4, 8, 12 are on.
    expect(noteAt(clip, lane, 0)).toBeDefined();
    expect(noteAt(clip, lane, 1)).toBeUndefined();
    expect(noteAt(clip, lane, 4)).toBeDefined();
    expect(stepStartTicks(4)).toBe(4 * TICKS_PER_SIXTEENTH);
  });

  it("matches triggers by pitch or pad id", () => {
    expect(
      triggersMatch({ kind: "pitch", pitch: 36 }, { kind: "pitch", pitch: 36 }),
    ).toBe(true);
    expect(
      triggersMatch({ kind: "pitch", pitch: 36 }, { kind: "pitch", pitch: 37 }),
    ).toBe(false);
    expect(
      triggersMatch(
        { kind: "pitch", pitch: 36 },
        {
          kind: "pad",
          padId: "pad_x" as never,
        },
      ),
    ).toBe(false);
  });

  it("reports the wrapped playback step only while playing", () => {
    const project = createSliceFixtureProject();
    const clip = project.clips[0];
    expect(playbackStep(clip, 0, false)).toBeNull();
    expect(playbackStep(clip, 0, true)).toBe(0);
    expect(playbackStep(clip, TICKS_PER_SIXTEENTH * 3, true)).toBe(3);
    // Wraps within the clip's 16 steps: tick past the clip lights step 0 again.
    expect(playbackStep(clip, TICKS_PER_BAR, true)).toBe(0);
  });

  it("buckets a gesture's changed-event count for analytics", () => {
    expect(eventCountBucket(1)).toBe("1_4");
    expect(eventCountBucket(4)).toBe("1_4");
    expect(eventCountBucket(5)).toBe("5_16");
    expect(eventCountBucket(300)).toBe("256_plus");
  });

  it("describes the dense 8-bar fixture at the CLP-02 upper bound", () => {
    const project = createDenseStepFixtureProject();
    const clip = project.clips[0];
    expect(barCount(clip)).toBe(DENSE_STEP_FIXTURE_BARS);
    expect(stepCount(clip)).toBe(DENSE_STEP_FIXTURE_BARS * STEPS_PER_BAR);
    const lanes = lanesFor(project.song.tracks[0].instrument);
    expect(lanes.map((lane) => lane.name)).toEqual(["BD", "SD", "HH"]);
  });
});
