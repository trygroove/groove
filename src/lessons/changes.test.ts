import { describe, expect, it } from "vitest";
import { addNotes } from "../commands/definitions/notes";
import { setParameter } from "../commands/definitions/parameters";
import { updatePlacement } from "../commands/definitions/placements";
import { removeTrack } from "../commands/definitions/tracks";
import { createNoteEvent } from "../domain/factories";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH, toTicks } from "../domain/time";
import {
  applied,
  applyShowMe,
  lessonContext,
  showBite,
  starterWorld,
} from "../testing/lessonWorld";
import {
  describeChanges,
  MAX_CHANGE_LINE_LENGTH,
  MAX_CHANGE_LINES,
  MAX_LISTED_HITS,
} from "./changes";
import { bite, chapter, nextStep } from "./chapters";
import { beatTrack, kickPad } from "./drums";

describe("what the producer changed (GRV-43)", () => {
  it("says nothing when nothing changed", () => {
    const { project } = starterWorld();
    expect(describeChanges(project, project)).toEqual([]);
  });

  it("names the steps of hits added, and calls a soft one a ghost note", () => {
    const { project } = starterWorld();
    const track = beatTrack(project);
    const pad = track && kickPad(track);
    const clip = project.clips[0];
    if (!track || !pad || !clip) throw new Error("no beat");
    const context = lessonContext();
    const after = applied(project, [
      addNotes(clip.id, [
        createNoteEvent(context, {
          startTicks: 10 * TICKS_PER_SIXTEENTH,
          durationTicks: TICKS_PER_SIXTEENTH,
          padId: pad.id,
        }),
        createNoteEvent(context, {
          startTicks: 7 * TICKS_PER_SIXTEENTH,
          durationTicks: TICKS_PER_SIXTEENTH,
          padId: pad.id,
          velocity: 0.3,
        }),
      ]),
    ]);
    expect(describeChanges(project, after)).toEqual([
      "BD's BD: hits added on step 8 and step 11 (1 soft, a ghost note).",
    ]);
    expect(describeChanges(after, project)).toEqual([
      "BD's BD: hits removed from step 8 and step 11.",
    ]);
  });

  it("names a new pad and its sound, a synth's changed controls, the tempo and a longer loop", () => {
    const world = starterWorld();
    const snare = nextStep(chapter("beat").bites[3], world, { style: "boom_bap" });
    const withSnare = applyShowMe(
      world,
      snare?.step.showMe(world, { style: "boom_bap" }, lessonContext()) ?? null,
    );
    const lines = describeChanges(world.project, withSnare.project);
    expect(lines[0]).toMatch(/^Added a pad, Snare, to BD, playing "/);
    expect(lines[1]).toBe("BD's Snare: hits added on step 5 and step 13.");

    const placement = world.project.song.placements[0];
    const longer = applied(world.project, [
      setParameter({ scope: "song", parameterId: "song.tempo" }, 90),
      updatePlacement(placement.id, {
        durationTicks: toTicks(4 * TICKS_PER_BAR),
        looped: true,
      }),
    ]);
    expect(describeChanges(world.project, longer)).toEqual([
      "Tempo: 120 to 90 BPM.",
      "BD's clips now play in bars 1-4 (were bar 1).",
    ]);

    const sound = chapter("sound").bites[0];
    const withSynth = applyShowMe(
      world,
      nextStep(sound, world, { style: "trap" })?.step.showMe(
        world,
        { style: "trap" },
        lessonContext(),
      ) ?? null,
    );
    const synthLines = describeChanges(world.project, withSynth.project);
    expect(synthLines[0]).toBe('Added a synth track, "Synth".');
    expect(synthLines[1]).toMatch(/^Synth: 8 notes added in bars? [\d-]+\.$/);
    const synth = withSynth.project.song.tracks.find((track) => track.name === "Synth");
    if (!synth) throw new Error("no synth");
    const square = applied(withSynth.project, [
      setParameter(
        { scope: "instrument", trackId: synth.id, parameterId: "waveform" },
        1,
      ),
    ]);
    expect(describeChanges(withSynth.project, square)).toEqual([
      "Synth's waveform: sawtooth to square.",
    ]);
  });

  it("says when a track went, and stops at a handful of lines", () => {
    const { project } = starterWorld();
    const without = applied(project, [removeTrack(project.song.tracks[0].id)]);
    expect(describeChanges(project, without)[0]).toBe(
      'Removed the drum machine track "BD".',
    );
    expect(describeChanges(project, without).length).toBeLessThanOrEqual(
      MAX_CHANGE_LINES,
    );
  });

  it("counts a run of hits rather than listing each, so no line outgrows the cap", () => {
    const { project } = starterWorld();
    const track = beatTrack(project);
    const pad = track && kickPad(track);
    const clip = project.clips[0];
    if (!track || !pad || !clip) throw new Error("no beat");
    const context = lessonContext();
    // 48 hits: listed one by one, a run like this ran to 697 characters.
    const many = Array.from({ length: 48 }, (_, index) =>
      createNoteEvent(context, {
        startTicks: index * (TICKS_PER_SIXTEENTH / 4) + 1,
        durationTicks: TICKS_PER_SIXTEENTH / 4,
        padId: pad.id,
      }),
    );
    const after = applied(project, [addNotes(clip.id, many)]);
    const lines = describeChanges(project, after);
    expect(lines).toEqual(["BD's BD: 48 hits added across bar 1."]);
    expect(describeChanges(after, project)).toEqual([
      "BD's BD: 48 hits removed across bar 1.",
    ]);
    for (const line of [...lines, ...describeChanges(after, project)]) {
      expect(line.length).toBeLessThanOrEqual(MAX_CHANGE_LINE_LENGTH);
    }
    // A handful is still listed.
    expect(MAX_LISTED_HITS).toBeGreaterThanOrEqual(4);
  });

  it("cuts a line that is still too long, as one with a very long track name would be", () => {
    const { project } = starterWorld();
    const named = {
      ...project,
      song: {
        ...project.song,
        tracks: project.song.tracks.map((track) => ({ ...track, name: "B".repeat(600) })),
      },
    };
    const without = applied(named, [removeTrack(named.song.tracks[0].id)]);
    const [line] = describeChanges(named, without);
    expect(line).toHaveLength(MAX_CHANGE_LINE_LENGTH);
    expect(line.endsWith("…")).toBe(true);
  });

  it("says what Show me did as it is: the key, the chords' shape, and where clips play (GRV-44)", () => {
    const settings = { style: "four_on_the_floor" } as const;
    let world = starterWorld();
    const lines: Record<string, string[]> = {};
    for (const id of [
      "beat-snare",
      "beat-hats",
      "beat-loop",
      "bass-key",
      "bass-line",
      "chords-loop",
      "chords-hook",
      "arrange-copy",
      "arrange-intro",
      "arrange-breakdown",
      "arrange-drop",
      "arrange-outro",
    ] as const) {
      const before = world.project;
      world = showBite(bite(id), world, settings);
      lines[id] = describeChanges(before, world.project);
    }
    expect(lines["bass-key"]).toEqual([
      "Key: no key (chromatic) to A minor.",
      'Added a synth track, "Bass".',
    ]);
    expect(lines["chords-loop"]).toContain(
      "Chords: 12 notes added in bars 1-4, as 4 chords of 3 notes.",
    );
    // Copying the loop out changes no note: it says only where the clips play.
    expect(lines["arrange-copy"]).toEqual([
      "BD's clips now play in bars 1-32 (were bars 1-4).",
      "Bass's clips now play in bars 1-32 (were bars 1-4).",
      "Chords's clips now play in bars 1-32 (were bars 1-4).",
      "Hook's clips now play in bars 1-32 (were bars 1-4).",
    ]);
    expect(lines["arrange-outro"]).toEqual([
      "BD's clips now play in bars 1-8 and 17-28 (were bars 1-8 and 17-32).",
      "Bass's clips now play in bars 1-28 (were bars 1-32).",
      "Chords's clips now play in bars 9-28 (were bars 9-32).",
      "Hook's clips now play in bars 9-28 (were bars 9-32).",
    ]);
  });
});
