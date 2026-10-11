import { describe, expect, it } from "vitest";
import {
  createArrangementWaveformCache,
  drawInteractionLayer,
} from "../../arrangement/canvasRenderer";
import type { Viewport } from "../../arrangement/geometry";
import { visibleRowRange, visibleTickRange } from "../../arrangement/geometry";
import { buildArrangementProjection } from "../../arrangement/projection";
import type { Project, Track } from "../../domain/entities";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import {
  referenceBands,
  referenceLabel,
  referenceSelection,
  resolveTrack,
} from "./askReferences";

const project = createDrumMachineFixtureProject();

function drumTrack(source: Project): Track & {
  instrument: Extract<Track["instrument"], { kind: "drumMachine" }>;
} {
  const track = source.song.tracks.find(
    (candidate) => candidate.instrument?.kind === "drumMachine",
  );
  if (!track || track.instrument?.kind !== "drumMachine" || !track.instrument.pads[0]) {
    throw new Error("the drum-machine fixture needs a pad");
  }
  return track as never;
}

/** The dashed rectangles a draw strokes, by their top. */
function strokedRows(source: Project, bands: ReturnType<typeof referenceBands>) {
  const viewport: Viewport = {
    scrollLeft: 0,
    scrollTop: 0,
    width: 800,
    height: 600,
    pixelsPerTick: 0.05,
  };
  const projection = buildArrangementProjection(source, {
    trackHeightPx: 28,
    headerHeightPx: 28,
  });
  const strokes: { y: number; dash: readonly number[] }[] = [];
  let dash: readonly number[] = [];
  const ctx = {
    clearRect() {},
    fillRect() {},
    strokeRect(_x: number, y: number) {
      strokes.push({ y, dash });
    },
    setLineDash(segments: number[]) {
      dash = [...segments];
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  };
  drawInteractionLayer(
    {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      projection,
      rowRange: visibleRowRange(projection.rowOffsets, viewport, 4),
      tickRange: visibleTickRange(viewport, 200),
      waveformCache: createArrangementWaveformCache(),
    },
    {
      playheadTicks: null,
      band: null,
      point: null,
      hoverPlacementId: null,
      selectedPlacementIds: new Set(),
      highlight: bands,
    },
  );
  return { strokes, projection };
}

describe("what a question's track reference points at (GRV-42)", () => {
  it("draws a track reference as a dashed band down that track's row", () => {
    const track = drumTrack(project);
    const bands = referenceBands(project, { kind: "track", trackId: track.id });
    expect(bands).toHaveLength(1);
    expect(bands[0]?.trackIds).toEqual([track.id]);

    const { strokes, projection } = strokedRows(project, bands);
    const row = projection.tracks.find((candidate) => candidate.id === track.id);
    expect(row).toBeDefined();
    expect(strokes).toHaveLength(1);
    expect(strokes[0]?.dash.length).toBeGreaterThan(0);
  });

  it("finds the track when the model names one of its drum pads instead", () => {
    // QA: a "Kick (BD)" option pointed at the kick pad, and nothing lit up.
    const track = drumTrack(project);
    const pad = track.instrument.pads[0];
    if (!pad) throw new Error("no pad");
    const ref = { kind: "track", trackId: pad.id } as const;
    expect(resolveTrack(project, pad.id)?.id).toBe(track.id);
    expect(referenceBands(project, ref)).toEqual([
      expect.objectContaining({ trackIds: [track.id] }),
    ]);
    expect(referenceLabel(project, ref)).toBe(`Track ${track.name}`);
    expect(referenceSelection(project, ref).trackId).toBe(track.id);
    expect(strokedRows(project, referenceBands(project, ref)).strokes).toHaveLength(1);
  });

  it("finds a track by its name when exactly one track has it", () => {
    const track = drumTrack(project);
    expect(resolveTrack(project, track.name.toUpperCase())?.id).toBe(track.id);
    expect(resolveTrack(project, "no such track")).toBeUndefined();
    expect(referenceBands(project, { kind: "track", trackId: "no such track" })).toEqual(
      [],
    );
  });

  it("finds a clip from one of its placements' IDs", () => {
    const placement = project.song.placements[0];
    if (!placement) throw new Error("the fixture needs a placement");
    const bands = referenceBands(project, { kind: "clip", clipId: placement.id });
    expect(bands.length).toBeGreaterThan(0);
    expect(bands.every((band) => band.trackIds[0] === placement.trackId)).toBe(true);
  });
});
