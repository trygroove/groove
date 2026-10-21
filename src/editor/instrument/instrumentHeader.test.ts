import { describe, expect, it } from "vitest";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import { instrumentHeaderFacts } from "./instrumentHeader";

function value(facts: ReturnType<typeof instrumentHeaderFacts>, label: string) {
  return facts.readouts.find((readout) => readout.label === label)?.value;
}

describe("instrumentHeaderFacts (#447)", () => {
  it("names a sampler's slot, kind, sample, window and pitch", () => {
    const project = createSliceFixtureProject();
    const track = project.song.tracks[0];
    const facts = instrumentHeaderFacts(project, track);
    expect(facts.slot).toBe("T01");
    expect(facts.kind).toBe("Sampler");
    const asset = project.song.assets.find(
      (a) => track.instrument?.kind === "sampler" && a.id === track.instrument.assetId,
    );
    expect(value(facts, "Sample")).toBe(asset?.name);
    expect(facts.readouts.find((r) => r.label === "Sample")?.masked).toBe(true);
    expect(value(facts, "Window")).toMatch(/→/);
    expect(value(facts, "Pitch")).toBeDefined();
  });

  it("names a synth's voice, wave and filter", () => {
    const project = createPianoRollFixtureProject();
    const track = project.song.tracks.find((t) => t.instrument?.kind === "synth");
    if (!track) throw new Error("fixture has no synth");
    const facts = instrumentHeaderFacts(project, track);
    expect(facts.kind).toBe("Synth");
    expect(value(facts, "Voice")).toBe("Poly");
    expect(value(facts, "Wave")).toMatch(/^(Sine|Square|Sawtooth|Triangle)$/);
    expect(value(facts, "Filter")).toBeDefined();
  });

  it("counts a drum machine's pads and follows the selected one", () => {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks.find((t) => t.instrument?.kind === "drumMachine");
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [first, second] = track.instrument.pads;
    expect(instrumentHeaderFacts(project, track).kind).toBe("Drum machine");
    expect(value(instrumentHeaderFacts(project, track), "Pads")).toBe(
      String(track.instrument.pads.length),
    );
    // With nothing selected it reads the first pad, as the pad editor shows.
    expect(value(instrumentHeaderFacts(project, track), "Selected")).toBe(first.name);
    expect(value(instrumentHeaderFacts(project, track, second.id), "Selected")).toBe(
      second.name,
    );
  });

  it("calls an audio track a loop and gives its tempo", () => {
    const project = createDrumMachineFixtureProject();
    const index = project.song.tracks.findIndex((t) => t.type === "audio");
    const facts = instrumentHeaderFacts(project, project.song.tracks[index]);
    expect(facts.slot).toBe(`T${String(index + 1).padStart(2, "0")}`);
    expect(facts.kind).toBe("Loop");
    expect(value(facts, "Source tempo")).toMatch(/BPM$/);
  });
});
