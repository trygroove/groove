import { describe, expect, it } from "vitest";
import { CommandHistory } from "../../commands";
import type { Clip, NoteTrigger, Project } from "../../domain/entities";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory } from "../../domain/ids";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import { createStarterProject } from "../composition/starterProject";
import { previewRow, rowCommands, rowNotes } from "./generatedRow";
import { PRESETS, type PresetId, presetHits } from "./stepGenerators";

const preset = (id: PresetId) => {
  const found = PRESETS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("writing a generated row (#643)", () => {
  function setup() {
    const project = createDrumMachineFixtureProject();
    const clip = project.clips[0] as Clip;
    const track = project.song.tracks[0];
    if (track.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [kick, clap] = track.instrument.pads;
    const trigger = (padId: typeof kick.id): NoteTrigger => ({ kind: "pad", padId });
    return { project, clip, kick: trigger(kick.id), clap: trigger(clap.id) };
  }
  const clipOf = (project: Project, clip: Clip) =>
    project.clips.find((candidate) => candidate.id === clip.id) as Clip;
  const onSteps = (clip: Clip, trigger: NoteTrigger) =>
    rowNotes(clip, trigger)
      .map((note) => note.startTicks / TICKS_PER_SIXTEENTH + 1)
      .sort((a, b) => a - b);

  it("replaces only the chosen row, as one history entry and one revision", () => {
    const { project, clip, kick, clap } = setup();
    const history = new CommandHistory(project);
    const hits = presetHits(preset("offbeats"), 16);
    history.execute(rowCommands(clip, clap, hits, createSeededIdFactory(1)));

    const after = clipOf(history.project, clip);
    expect(onSteps(after, clap)).toEqual([3, 7, 11, 15]);
    expect(onSteps(after, kick)).toEqual([1, 5, 9, 13]);
    expect(history.project.metadata.revision).toBe(project.metadata.revision + 1);
    expect(history.canUndo).toBe(true);

    history.undo();
    expect(onSteps(clipOf(history.project, clip), clap)).toEqual([5, 13]);
    expect(history.canUndo).toBe(false);
  });

  it("clears a row with no hits, and does nothing to an empty row", () => {
    const { clip, clap } = setup();
    const ids = createSeededIdFactory(2);
    const clear = rowCommands(clip, clap, [], ids);
    expect(clear.map((command) => command.type)).toEqual(["note.remove"]);
    const empty = { ...clip, content: { kind: "notes" as const, events: [] } };
    expect(rowCommands(empty, clap, [], ids)).toEqual([]);
  });

  it("writes nothing when the row already holds exactly the generated hits", () => {
    const { project, clip, clap } = setup();
    const history = new CommandHistory(project);
    const hits = presetHits(preset("offbeats"), 16);
    history.execute(rowCommands(clip, clap, hits, createSeededIdFactory(3)));
    const written = clipOf(history.project, clip);
    const revision = history.project.metadata.revision;

    expect(rowCommands(written, clap, hits, createSeededIdFactory(4))).toEqual([]);
    // A different velocity is a real change and still writes.
    const louder = hits.map((hit) => ({
      ...hit,
      velocity: hit.velocity === 1 ? 0.5 : 1,
    }));
    expect(rowCommands(written, clap, louder, createSeededIdFactory(5)).length).toBe(2);
    expect(history.project.metadata.revision).toBe(revision);
  });

  it("writes nothing for Four on the floor on a new project's BD row (GRV-154)", () => {
    const project = createStarterProject("user_1");
    const clip = project.clips[0] as Clip;
    const track = project.song.tracks[0];
    if (track.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const bd: NoteTrigger = { kind: "pad", padId: track.instrument.pads[0].id };
    const hits = presetHits(preset("four_on_the_floor"), 16);

    expect(rowCommands(clip, bd, hits, createSeededIdFactory(6))).toEqual([]);
  });

  it("drops hits past the end of the clip", () => {
    const { clip, clap } = setup();
    const commands = rowCommands(
      clip,
      clap,
      [{ step: 20, velocity: 1 }],
      createSeededIdFactory(3),
    );
    // The row's two claps go; nothing is added past the one-bar clip.
    expect(commands.map((command) => command.type)).toEqual(["note.remove"]);
  });

  it("previews what it would add and remove without changing the clip", () => {
    const { clip, clap } = setup();
    const before = JSON.stringify(clip);
    const preview = previewRow(clip, clap, presetHits(preset("four_on_the_floor"), 16));
    // The clap's backbeat is at 5 and 13: 5 and 13 stay, 1 and 9 are added.
    expect([...preview.added].sort((a, b) => a - b)).toEqual([0, 8]);
    expect(preview.removed.size).toBe(0);

    const offbeats = previewRow(clip, clap, presetHits(preset("offbeats"), 16));
    expect(offbeats.added.size).toBe(4);
    expect(offbeats.removed.size).toBe(2);
    expect(JSON.stringify(clip)).toBe(before);
  });
});
