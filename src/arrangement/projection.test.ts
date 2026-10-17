import { describe, expect, it } from "vitest";
import { addTrack, updateTrack } from "../commands/definitions/tracks";
import { executeTransaction } from "../commands/execute";
import type { Project } from "../domain/entities";
import {
  createFactoryContext,
  createNoteClip,
  createPlacement,
  createTrack,
} from "../domain/factories";
import {
  createDrumMachineFixtureProject,
  createLargeArrangementProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import { createSeededIdFactory } from "../domain/ids";
import { TICKS_PER_BAR, toTicks } from "../domain/time";
import type { RowMetrics } from "./geometry";
import {
  buildArrangementProjection,
  hitTestArrangement,
  visiblePlacements,
  visiblePlacementsForTrack,
} from "./projection";

const rowMetrics: RowMetrics = { trackHeightPx: 32, headerHeightPx: 32 };

describe("buildArrangementProjection", () => {
  it("orders tracks by `order` and gives each a matching rowIndex", () => {
    const project = createDrumMachineFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);

    expect(projection.tracks.map((track) => track.rowIndex)).toEqual(
      projection.tracks.map((_, index) => index),
    );
    for (let index = 1; index < projection.tracks.length; index += 1) {
      expect(projection.tracks[index].order).toBeGreaterThan(
        projection.tracks[index - 1].order,
      );
    }
  });

  it("builds rowOffsets one longer than the track count", () => {
    const project = createDrumMachineFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    expect(projection.rowOffsets).toHaveLength(projection.tracks.length + 1);
  });

  it("gives every placement the row index of its owning track", () => {
    const project = createSliceFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    const track = projection.tracks[0];
    const index = projection.placementsByTrack.get(track.id);
    expect(index?.items.every((placement) => placement.rowIndex === track.rowIndex)).toBe(
      true,
    );
  });

  it("labels a note clip's placement with a notes preview", () => {
    const project = createSliceFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    const [placement] = [...projection.placementsById.values()];
    expect(placement.preview.kind).toBe("notes");
  });

  it("places a note preview's notes on rows by pitch, highest on top (#351)", () => {
    // C4, E4, G4, C5: a 13-semitone span, so C5 is row 0 and C4 row 12.
    const project = createPianoRollFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    const [placement] = [...projection.placementsById.values()];
    if (placement.preview.kind !== "notes") throw new Error("expected notes");
    expect(placement.preview.laneCount).toBe(13);
    expect(placement.preview.notes.map((note) => note.lane)).toEqual([12, 8, 5, 0]);
  });

  it("repeats a looped placement's notes across its whole length (GRV-133)", () => {
    const base = createPianoRollFixtureProject();
    const [placement] = base.song.placements;
    const clip = base.clips.find((candidate) => candidate.id === placement.clipId);
    if (!clip || clip.content.kind !== "notes") throw new Error("expected notes");
    const noteCount = clip.content.events.length;
    const project: Project = {
      ...base,
      song: {
        ...base.song,
        placements: [
          {
            ...placement,
            looped: true,
            clipOffsetTicks: toTicks(0),
            durationTicks: toTicks(clip.lengthTicks * 4),
          },
          ...base.song.placements.slice(1),
        ],
      },
    };
    const projection = buildArrangementProjection(project, rowMetrics);
    const geometry = projection.placementsById.get(placement.id);
    if (geometry?.preview.kind !== "notes") throw new Error("expected notes");
    expect(geometry.preview.notes).toHaveLength(noteCount * 4);
    const starts = geometry.preview.notes.map((note) => note.startTicks);
    expect(Math.max(...starts)).toBeGreaterThanOrEqual(clip.lengthTicks * 3);
  });

  it("labels an audioLoop clip's placement with a waveform preview", () => {
    const project = createDrumMachineFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    const waveformPlacement = [...projection.placementsById.values()].find(
      (placement) => placement.preview.kind === "waveform",
    );
    expect(waveformPlacement).toBeDefined();
  });

  it("exposes section markers sorted by start tick with bar ranges", () => {
    const project = createLargeArrangementProject(20);
    const projection = buildArrangementProjection(project, rowMetrics);
    expect(projection.sections.length).toBe(project.song.sections.length);
    for (let index = 1; index < projection.sections.length; index += 1) {
      expect(projection.sections[index].startTicks).toBeGreaterThanOrEqual(
        projection.sections[index - 1].startTicks,
      );
    }
    const first = projection.sections[0];
    const source = project.song.sections.find((s) => s.id === first.id);
    expect(source).toBeDefined();
    expect(first.endTicks).toBe((source?.startTicks ?? 0) + (source?.durationTicks ?? 0));
  });

  it("exposes at most one automation lane per track", () => {
    const project = createLargeArrangementProject(20);
    const projection = buildArrangementProjection(project, rowMetrics);
    expect(projection.automationByTrack.size).toBeLessThanOrEqual(
      projection.tracks.length,
    );
  });

  describe("revision stability", () => {
    it("gives the same track a stable revision across two builds of the same project", () => {
      const project = createSliceFixtureProject();
      const first = buildArrangementProjection(project, rowMetrics);
      const second = buildArrangementProjection(project, rowMetrics);
      expect(second.tracks[0].revision).toBe(first.tracks[0].revision);
      expect(second.songRevision).toBe(first.songRevision);
    });

    it("changes only the affected track's revision when only that track changes", () => {
      const project = createLargeArrangementProject(20);
      const before = buildArrangementProjection(project, rowMetrics);

      const changedTrack = { ...project.song.tracks[0], name: "Renamed" };
      const changed: Project = {
        ...project,
        song: {
          ...project.song,
          tracks: project.song.tracks.map((track, index) =>
            index === 0 ? changedTrack : track,
          ),
        },
      };
      const after = buildArrangementProjection(changed, rowMetrics);

      expect(after.tracks[0].revision).not.toBe(before.tracks[0].revision);
      for (let index = 1; index < after.tracks.length; index += 1) {
        expect(after.tracks[index].revision).toBe(before.tracks[index].revision);
      }
    });
  });
});

describe("visiblePlacementsForTrack / visiblePlacements culling", () => {
  it("only returns placements that intersect the requested tick range", () => {
    const project = createLargeArrangementProject(20);
    const projection = buildArrangementProjection(project, rowMetrics);
    const [track] = projection.tracks;
    const index = projection.placementsByTrack.get(track.id);
    expect(index).toBeDefined();
    if (!index) return;

    const midpoint = TICKS_PER_BAR * 30;
    const narrowRange = { startTick: midpoint, endTick: midpoint + 1 };
    const visible = visiblePlacementsForTrack(index, narrowRange);

    for (const placement of visible) {
      expect(placement.endTicks).toBeGreaterThanOrEqual(narrowRange.startTick);
      expect(placement.startTicks).toBeLessThanOrEqual(narrowRange.endTick);
    }
    // Sanity: culling actually excludes something in a dense fixture.
    expect(visible.length).toBeLessThan(index.items.length);
  });

  it("finds a placement that starts before the range but still overlaps it", () => {
    const project = createSliceFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    const [track] = projection.tracks;
    const index = projection.placementsByTrack.get(track.id);
    expect(index).toBeDefined();
    if (!index) return;
    const [placement] = index.items;

    // The fixture's one placement spans [0, TICKS_PER_BAR); a range that
    // starts mid-placement must still find it.
    const midRange = {
      startTick: placement.startTicks + 10,
      endTick: placement.endTicks + 100,
    };
    expect(visiblePlacementsForTrack(index, midRange)).toContainEqual(placement);
  });

  it("restricts visiblePlacements to the requested row range", () => {
    const project = createLargeArrangementProject(20);
    const projection = buildArrangementProjection(project, rowMetrics);
    const fullTickRange = { startTick: 0, endTick: projection.lengthTicks };

    const onlyFirstRow = visiblePlacements(projection, fullTickRange, {
      startRow: 0,
      endRow: 0,
    });
    expect(onlyFirstRow.every((placement) => placement.rowIndex === 0)).toBe(true);
    expect(onlyFirstRow.length).toBeGreaterThan(0);
  });
});

describe("hitTestArrangement", () => {
  it("reports empty for a row with no track", () => {
    const project = createSliceFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    expect(hitTestArrangement(projection, { rowIndex: 99, tick: 0 }, 10)).toEqual({
      kind: "empty",
    });
  });

  it("reports the placement body for a point well inside it", () => {
    const project = createSliceFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    const [placement] = [...projection.placementsById.values()];
    const midTick = Math.floor((placement.startTicks + placement.endTicks) / 2);

    const result = hitTestArrangement(
      projection,
      { rowIndex: placement.rowIndex, tick: midTick },
      5,
    );
    expect(result).toEqual({
      kind: "placement",
      placementId: placement.id,
      handle: "body",
    });
  });

  it("prefers the start handle over the body near the placement's left edge", () => {
    const project = createSliceFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    const [placement] = [...projection.placementsById.values()];

    const result = hitTestArrangement(
      projection,
      { rowIndex: placement.rowIndex, tick: placement.startTicks + 2 },
      5,
    );
    expect(result).toEqual({
      kind: "placement",
      placementId: placement.id,
      handle: "start",
    });
  });

  it("prefers the end handle over the body near the placement's right edge", () => {
    const project = createSliceFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    const [placement] = [...projection.placementsById.values()];

    const result = hitTestArrangement(
      projection,
      { rowIndex: placement.rowIndex, tick: placement.endTicks - 2 },
      5,
    );
    expect(result).toEqual({
      kind: "placement",
      placementId: placement.id,
      handle: "end",
    });
  });

  it("reports empty for a point on the track but outside any placement", () => {
    const project = createSliceFixtureProject();
    const projection = buildArrangementProjection(project, rowMetrics);
    const [placement] = [...projection.placementsById.values()];

    const result = hitTestArrangement(
      projection,
      { rowIndex: placement.rowIndex, tick: placement.endTicks + 10_000 },
      5,
    );
    expect(result).toEqual({ kind: "empty" });
  });
});

describe("placement colour follows the track (#365)", () => {
  function apply(project: Project, commands: Parameters<typeof executeTransaction>[1]) {
    const result = executeTransaction(project, commands);
    expect(result.ok, JSON.stringify((result as { issues?: unknown }).issues)).toBe(true);
    return result.project;
  }

  /** The slice fixture plus a second track (order 1, so a different default
   * colour) carrying a default-coloured clip placed on it — the way a clip
   * added to any track after the first is made. */
  function twoTrackProject() {
    const base = createSliceFixtureProject();
    const context = createFactoryContext({ ids: createSeededIdFactory("issue-365") });
    const track = createTrack(context, { name: "Keys", order: 1 });
    const clip = createNoteClip(context, { trackId: track.id, name: "Chords" });
    const placement = createPlacement(context, {
      clipId: clip.id,
      trackId: track.id,
      startTicks: 0,
      durationTicks: TICKS_PER_BAR,
    });
    const project = apply(base, [
      addTrack(track, { clips: [clip], placements: [placement] }),
    ]);
    return { project, trackId: track.id, placementId: placement.id };
  }

  it("draws a clip on any track in that track's colour, not the first track's", () => {
    const { project, trackId, placementId } = twoTrackProject();
    const [first, second] = project.song.tracks;
    expect(second.color).not.toBe(first.color);

    const projection = buildArrangementProjection(project, rowMetrics);

    const track = project.song.tracks.find((candidate) => candidate.id === trackId);
    expect(projection.placementsById.get(placementId)?.color).toBe(track?.color);
  });

  it("redraws a track's clips in its new colour after the track is recoloured", () => {
    const { project, trackId, placementId } = twoTrackProject();
    const before = buildArrangementProjection(project, rowMetrics);

    const recoloured = apply(project, [updateTrack(trackId, { color: "#123456" })]);
    const after = buildArrangementProjection(recoloured, rowMetrics);

    const placement = after.placementsById.get(placementId);
    expect(placement?.color).toBe("#123456");
    expect(placement?.revision).not.toBe(
      before.placementsById.get(placementId)?.revision,
    );
  });
});
