import { describe, expect, it } from "vitest";
import { executeTransaction, noteEventsOf } from "../../commands";
import { MAX_CLIP_LENGTH_TICKS } from "../../domain/clipLength";
import type { NoteEvent, Placement, Project } from "../../domain/entities";
import { createFactoryContext, createPlacement } from "../../domain/factories";
import { createPianoRollFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory } from "../../domain/ids";
import { TICKS_PER_BAR, toTicks } from "../../domain/time";
import { canDouble, canHalve, doubleClip, halveClip } from "./clipLengthActions";

const BAR = TICKS_PER_BAR;

describe("Double (#647)", () => {
  /** The fixture's two-bar arpeggio, with its placements swapped for `placements`. */
  function withPlacements(
    make: (clip: Project["clips"][number], trackId: string) => readonly Placement[],
  ): Project {
    const project = createPianoRollFixtureProject();
    const [clip] = project.clips;
    return {
      ...project,
      song: { ...project.song, placements: [...make(clip, clip.trackId)] },
    };
  }

  const context = createFactoryContext({
    ids: createSeededIdFactory("double-placements"),
  });

  function place(
    clip: Project["clips"][number],
    trackId: string,
    startBars: number,
    durationBars: number,
    extra: { looped?: boolean; clipOffsetBars?: number } = {},
  ): Placement {
    return createPlacement(context, {
      clipId: clip.id,
      trackId: trackId as Placement["trackId"],
      startTicks: startBars * BAR,
      durationTicks: durationBars * BAR,
      clipOffsetTicks: (extra.clipOffsetBars ?? 0) * BAR,
      looped: extra.looped,
    });
  }

  function double(project: Project): Project {
    const [clip] = project.clips;
    const result = executeTransaction(
      project,
      doubleClip(project, clip, createSeededIdFactory("double")),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.project;
  }

  const bars = (placement: Placement) => placement.durationTicks / BAR;

  it("doubles the clip and copies every note into the new half, as one transaction", () => {
    const project = createPianoRollFixtureProject();
    const doubled = double(project);
    const [clip] = doubled.clips;

    expect(clip.lengthTicks).toBe(4 * BAR);
    const starts = (noteEventsOf(clip) ?? []).map((note) => note.startTicks / 48);
    expect(starts.sort((a, b) => a - b)).toEqual([0, 4, 8, 12, 32, 36, 40, 44]);
    expect(doubled.metadata.revision).toBe(project.metadata.revision + 1);
  });

  it("stretches a placement that shows the clip's end by the added length", () => {
    const doubled = double(withPlacements((clip, track) => [place(clip, track, 0, 2)]));
    expect(doubled.song.placements.map(bars)).toEqual([4]);
  });

  it("stops a stretch at the next placement on the track", () => {
    const doubled = double(
      withPlacements((clip, track) => [
        place(clip, track, 0, 2),
        place(clip, track, 3, 2),
      ]),
    );
    // The first grows one bar into the gap; the second has the track to itself.
    expect(doubled.song.placements.map(bars)).toEqual([3, 4]);
  });

  it("merges tiled linked copies in pairs, so the region plays the clip in turn", () => {
    // The fixture's clip is two bars; a right-edge drag tiles it (#493).
    const doubled = double(
      withPlacements((clip, track) =>
        [0, 2, 4, 6].map((bar) => place(clip, track, bar, 2)),
      ),
    );
    const spans = doubled.song.placements
      .map((placement) => [placement.startTicks / BAR, bars(placement)])
      .sort((a, b) => a[0] - b[0]);
    // Eight bars of two-bar tiles become two four-bar placements of the
    // doubled clip, covering the same eight bars.
    expect(spans).toEqual([
      [0, 4],
      [4, 4],
    ]);
  });

  it("grows an odd tile left over after the pairs into free space", () => {
    const doubled = double(
      withPlacements((clip, track) => [0, 2, 4].map((bar) => place(clip, track, bar, 2))),
    );
    const spans = doubled.song.placements
      .map((placement) => [placement.startTicks / BAR, bars(placement)])
      .sort((a, b) => a[0] - b[0]);
    expect(spans).toEqual([
      [0, 4],
      [4, 4],
    ]);
  });

  it("leaves looped placements and ones that show only part of the clip", () => {
    const doubled = double(
      withPlacements((clip, track) => [
        place(clip, track, 0, 4, { looped: true }),
        place(clip, track, 8, 1),
      ]),
    );
    expect(doubled.song.placements.map(bars)).toEqual([4, 1]);
  });

  it("can double only while the result fits the longest clip", () => {
    const [clip] = createPianoRollFixtureProject().clips;
    expect(canDouble(clip)).toBe(true);
    expect(canDouble({ ...clip, lengthTicks: toTicks(MAX_CLIP_LENGTH_TICKS / 2) })).toBe(
      true,
    );
    expect(canDouble({ ...clip, lengthTicks: toTicks(MAX_CLIP_LENGTH_TICKS) })).toBe(
      false,
    );
  });
});

describe("Halve (#662)", () => {
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
