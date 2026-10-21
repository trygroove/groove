import { describe, expect, it } from "vitest";
import { executeTransaction, noteEventsOf } from "../../commands";
import type { NoteEvent, Placement, Project } from "../../domain/entities";
import { createFactoryContext, createPlacement } from "../../domain/factories";
import { createPianoRollFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory } from "../../domain/ids";
import { TICKS_PER_BAR, toTicks } from "../../domain/time";
import { doubleClip } from "./doubleClip";
import { canHalve, halveClip } from "./halveClip";

const BAR = TICKS_PER_BAR;
const noteIds = createSeededIdFactory("halve-notes");
const [KEEP, CROSS, DROP] = [0, 1, 2].map(() => noteIds("event") as NoteEvent["id"]);
const context = createFactoryContext({ ids: createSeededIdFactory("halve") });

function run(project: Project, commands: ReturnType<typeof halveClip>): Project {
  const result = executeTransaction(project, commands);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.project;
}

const halve = (project: Project) => run(project, halveClip(project, project.clips[0]));

/** The fixture's two-bar clip with its notes swapped for `events`. */
function withNotes(make: (template: NoteEvent) => NoteEvent[]): Project {
  const project = createPianoRollFixtureProject();
  const [clip] = project.clips;
  const [template] = noteEventsOf(clip) ?? [];
  return {
    ...project,
    clips: [{ ...clip, content: { kind: "notes", events: make(template) } }],
  };
}

function withPlacements(make: (project: Project) => Placement[]): Project {
  const project = createPianoRollFixtureProject();
  return { ...project, song: { ...project.song, placements: make(project) } };
}

function place(
  project: Project,
  startBars: number,
  durationBars: number,
  extra: { looped?: boolean; clipOffsetBars?: number } = {},
): Placement {
  return createPlacement(context, {
    clipId: project.clips[0].id,
    trackId: project.song.tracks[0].id,
    startTicks: startBars * BAR,
    durationTicks: durationBars * BAR,
    clipOffsetTicks: (extra.clipOffsetBars ?? 0) * BAR,
    looped: extra.looped,
  });
}

describe("Halve (#662)", () => {
  it("halves the clip, drops notes in the second half and trims one crossing the midpoint", () => {
    const project = withNotes((note) => [
      {
        ...note,
        id: KEEP,
        startTicks: toTicks(0),
        durationTicks: toTicks(48),
      },
      {
        ...note,
        id: CROSS,
        startTicks: toTicks(BAR - 96),
        durationTicks: toTicks(192),
      },
      {
        ...note,
        id: DROP,
        startTicks: toTicks(BAR + 48),
        durationTicks: toTicks(48),
      },
    ]);
    const halved = halve(project);
    const [clip] = halved.clips;
    expect(clip.lengthTicks).toBe(BAR);
    expect(
      (noteEventsOf(clip) ?? []).map((note) => [
        note.id,
        note.startTicks,
        note.durationTicks,
      ]),
    ).toEqual([
      [KEEP, 0, 48],
      [CROSS, BAR - 96, 96],
    ]);
    expect(halved.metadata.revision).toBe(project.metadata.revision + 1);
  });

  it("undoes Double exactly", () => {
    const project = createPianoRollFixtureProject();
    const doubled = run(
      project,
      doubleClip(project, project.clips[0], createSeededIdFactory("halve-double")),
    );
    const back = halve(doubled);
    expect(back.clips[0].lengthTicks).toBe(project.clips[0].lengthTicks);
    expect(noteEventsOf(back.clips[0])).toEqual(noteEventsOf(project.clips[0]));
    expect(back.song.placements.map((p) => p.durationTicks)).toEqual(
      project.song.placements.map((p) => p.durationTicks),
    );
  });

  it("shrinks placements to the kept half, removes ones showing only the rest, and leaves looped ones", () => {
    const halved = halve(
      withPlacements((p) => [
        place(p, 0, 2),
        place(p, 4, 1, { clipOffsetBars: 1 }),
        place(p, 8, 4, { looped: true }),
      ]),
    );
    expect(
      halved.song.placements.map((p) => [p.startTicks / BAR, p.durationTicks / BAR]),
    ).toEqual([
      [0, 1],
      [8, 4],
    ]);
  });

  it("stops at one bar", () => {
    const [clip] = createPianoRollFixtureProject().clips;
    expect(canHalve(clip)).toBe(true);
    expect(canHalve({ ...clip, lengthTicks: toTicks(BAR) })).toBe(false);
  });
});
