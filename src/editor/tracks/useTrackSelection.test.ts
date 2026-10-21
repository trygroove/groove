import { cleanup, renderHook } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../domain/entities";
import { createFactoryContext, createReturnBus } from "../../domain/factories";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory, type PadId } from "../../domain/ids";
import { selectedPadOf } from "../sequence/padSelection";
import { useTrackSelection } from "./useTrackSelection";

afterEach(() => cleanup());

function setup(initial: Project = createDrumMachineFixtureProject()) {
  const [project, setProject] = createSignal<Project | null>(initial);
  const onPoint = vi.fn();
  const { result } = renderHook(() => useTrackSelection({ project, onPoint }));
  flush();
  const [drums, other] = initial.song.tracks;
  return { selection: result, project, setProject, onPoint, drums, other };
}

/** The project with one return bus added (#386). */
function withReturn(project: Project): Project {
  const bus = createReturnBus(
    createFactoryContext({ ids: createSeededIdFactory("track-selection") }),
    { name: "Reverb", order: 0 },
  );
  return { ...project, song: { ...project.song, returns: [bus] } };
}

/** The project with one track, and everything placed on it, taken out. */
function withoutTrack(project: Project, index: number): Project {
  const gone = project.song.tracks[index].id;
  return {
    ...project,
    song: {
      ...project.song,
      tracks: project.song.tracks.filter((track) => track.id !== gone),
      placements: project.song.placements.filter((entry) => entry.trackId !== gone),
    },
  };
}

describe("useTrackSelection", () => {
  it("starts with nothing selected, showing the project's first track", () => {
    const { selection, drums } = setup();
    expect(selection.selectedTrackId()).toBeNull();
    expect(selection.track()?.id).toBe(drums.id);
    expect(selection.drumTrack()?.id).toBe(drums.id);
    expect(selection.deletableTrackId()).toBeNull();
  });

  it("points at a track without choosing it, and says so", () => {
    const { selection, onPoint, other } = setup();
    selection.selectTrack(other.id);
    flush();
    expect(selection.selectedTrackId()).toBe(other.id);
    expect(selection.track()?.id).toBe(other.id);
    expect(selection.drumTrack()).toBeNull();
    expect(selection.deletableTrackId()).toBeNull();
    expect(onPoint).toHaveBeenCalledTimes(1);
  });

  it("makes only a track picked through its header Delete's to remove (#960)", () => {
    const { selection, drums, other } = setup();
    selection.selectTrackFrom(other.id, "follow");
    flush();
    expect(selection.deletableTrackId()).toBeNull();

    selection.selectTrackFrom(other.id, "header");
    flush();
    expect(selection.deletableTrackId()).toBe(other.id);

    selection.chooseTrack(drums.id);
    flush();
    expect(selection.deletableTrackId()).toBe(drums.id);

    // Any other way of selecting a track clears the choice.
    selection.selectTrack(other.id);
    flush();
    expect(selection.deletableTrackId()).toBeNull();
  });

  it("drops the choice of track but keeps it selected", () => {
    const { selection, other } = setup();
    selection.chooseTrack(other.id);
    flush();
    selection.dropTrackChoice();
    flush();
    expect(selection.deletableTrackId()).toBeNull();
    expect(selection.selectedTrackId()).toBe(other.id);
  });

  it("lets go of a track the project no longer has", () => {
    const { selection, setProject, project, other, drums } = setup();
    selection.chooseTrack(other.id);
    flush();
    const current = project();
    if (!current) throw new Error("expected a project");
    setProject(withoutTrack(current, 1));
    flush();
    expect(selection.selectedTrackId()).toBeNull();
    expect(selection.deletableTrackId()).toBeNull();
    expect(selection.track()?.id).toBe(drums.id);
  });

  it("opens a placement's clip and selects its track, until another track is chosen", () => {
    const { selection, project, other } = setup();
    const placement = project()?.song.placements[0];
    if (!placement) throw new Error("expected a placement");
    selection.selectPlacement(placement.id);
    flush();
    expect(selection.openPlacementId()).toBe(placement.id);
    expect(selection.selectedTrackId()).toBe(placement.trackId);
    expect(selection.opened()?.track.id).toBe(placement.trackId);

    selection.selectTrack(other.id);
    flush();
    expect(selection.opened()).toBeNull();
    expect(selection.openPlacementId()).toBe(placement.id);
  });

  it("selects a drum track's pad, and says so", () => {
    const { selection, onPoint, drums } = setup();
    const pad = padIds(drums)[1];
    selection.selectPad(drums.id, pad);
    flush();
    expect(selectedPadOf(selection.padSelection(), drums)).toBe(pad);
    expect(onPoint).toHaveBeenCalledTimes(1);
  });

  it("points the editor at a return until a track is selected (#386)", () => {
    const { selection, onPoint, project, drums, other } = setup(
      withReturn(createDrumMachineFixtureProject()),
    );
    const bus = selection.selectedReturn;
    expect(bus()).toBeNull();
    const busId = returnIdOf(project());
    selection.selectReturn(busId);
    flush();
    expect(bus()?.id).toBe(busId);
    expect(onPoint).not.toHaveBeenCalled();

    selection.selectPad(drums.id, padIds(drums)[0]);
    flush();
    expect(bus()?.id).toBe(busId);

    selection.selectTrack(other.id);
    flush();
    expect(bus()).toBeNull();
  });

  it("lets go of a return when the master is selected (#1106)", () => {
    const { selection, onPoint, project, drums } = setup(
      withReturn(createDrumMachineFixtureProject()),
    );
    selection.selectTrack(drums.id);
    selection.selectReturn(returnIdOf(project()));
    flush();
    onPoint.mockClear();

    selection.selectMaster();
    flush();
    expect(selection.selectedReturn()).toBeNull();
    // The master is not a track: the track the editor follows stays put.
    expect(selection.selectedTrackId()).toBe(drums.id);
    expect(onPoint).not.toHaveBeenCalled();
  });

  it("lets go of a return the song no longer has (#386)", () => {
    const { selection, setProject, project } = setup(
      withReturn(createDrumMachineFixtureProject()),
    );
    selection.selectReturn(returnIdOf(project()));
    flush();
    const current = project();
    if (!current) throw new Error("expected a project");
    setProject({ ...current, song: { ...current.song, returns: [] } });
    flush();
    expect(selection.selectedReturn()).toBeNull();

    setProject(current);
    flush();
    expect(selection.selectedReturn()).toBeNull();
  });

  it("puts the selection back where it was, without pointing anywhere", () => {
    const { selection, onPoint, project, drums, other } = setup();
    const placement = project()?.song.placements[0];
    if (!placement) throw new Error("expected a placement");
    selection.selectPlacement(placement.id);
    selection.selectPad(drums.id, padIds(drums)[1]);
    flush();
    const saved = selection.location();

    selection.selectTrack(other.id);
    selection.selectPad(drums.id, padIds(drums)[0]);
    flush();
    onPoint.mockClear();

    selection.restore(saved);
    flush();
    expect(selection.location()).toEqual(saved);
    expect(selection.opened()?.track.id).toBe(placement.trackId);
    expect(onPoint).not.toHaveBeenCalled();
  });

  it("restores a location whose track has gone without pointing at it", () => {
    const { selection, setProject, project, other } = setup();
    selection.selectTrack(other.id);
    flush();
    const saved = selection.location();
    const current = project();
    if (!current) throw new Error("expected a project");
    setProject(withoutTrack(current, 1));
    flush();
    selection.restore(saved);
    flush();
    expect(selection.selectedTrackId()).toBeNull();
  });
});

function padIds(track: Project["song"]["tracks"][number]): PadId[] {
  if (track.instrument?.kind !== "drumMachine") throw new Error("expected drums");
  return track.instrument.pads.map((pad) => pad.id);
}

function returnIdOf(project: Project | null) {
  const bus = project?.song.returns[0];
  if (!bus) throw new Error("expected a return");
  return bus.id;
}
