import { cleanup, renderHook } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlacementEditingActions } from "../../arrangement/ArrangementView";
import type { Project } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
} from "../../domain/fixtures";
import type { OpenedClip } from "./editorViewModel";
import { useEditingSurfaces } from "./useEditingSurfaces";

afterEach(() => cleanup());

/** The project's first placement, opened as the sequence view would. */
function openFirst(project: Project): OpenedClip {
  const placement = project.song.placements[0];
  const clip = project.clips.find((candidate) => candidate.id === placement.clipId);
  const track = project.song.tracks.find(
    (candidate) => candidate.id === placement.trackId,
  );
  if (!clip || !track) throw new Error("fixture placement points nowhere");
  return { clip, track };
}

function noteIds(opened: OpenedClip) {
  if (opened.clip.content.kind !== "notes") throw new Error("expected notes");
  return opened.clip.content.events.map((event) => event.id);
}

function setup(initial: OpenedClip | null) {
  const [opened, setOpened] = createSignal<OpenedClip | null>(initial);
  const [positionTicks, setPositionTicks] = createSignal(0);
  const [isPlaying, setPlaying] = createSignal(false);
  const dispatch = vi.fn();
  const { result } = renderHook(() =>
    useEditingSurfaces({
      opened,
      audio: { positionTicks, isPlaying },
      session: { dispatch },
    }),
  );
  flush();
  return { surfaces: result, setOpened, setPositionTicks, setPlaying, dispatch };
}

describe("useEditingSurfaces", () => {
  it("edits the opened clip, and nothing with none open", () => {
    const opened = openFirst(createDrumMachineFixtureProject());
    const { surfaces, setOpened } = setup(opened);
    expect(surfaces.clip()).toBe(opened.clip);
    setOpened(null);
    flush();
    expect(surfaces.clip()).toBeNull();
    expect(surfaces.selectAllSteps()).toBeUndefined();
  });

  it("shows the step grid for a drum clip and the piano roll for a synth's notes", () => {
    const { surfaces, setOpened } = setup(openFirst(createDrumMachineFixtureProject()));
    expect(surfaces.showPianoRoll()).toBe(false);
    setOpened(openFirst(createPianoRollFixtureProject()));
    flush();
    expect(surfaces.showPianoRoll()).toBe(true);
  });

  it("follows the playhead through the clip's steps only while playing", () => {
    const { surfaces, setPositionTicks, setPlaying } = setup(
      openFirst(createDrumMachineFixtureProject()),
    );
    setPositionTicks(48 * 3);
    flush();
    expect(surfaces.editorPlaybackStep()).toBeNull();
    setPlaying(true);
    flush();
    expect(surfaces.editorPlaybackStep()).toBe(3);
  });

  it("selects every note in the open clip, and deletes the selection in one command", () => {
    const opened = openFirst(createDrumMachineFixtureProject());
    const { surfaces, dispatch } = setup(opened);
    surfaces.selectAllSteps()?.();
    flush();
    expect(surfaces.selectedNoteIds()).toEqual(noteIds(opened));

    surfaces.deleteSelection();
    flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ type: "note.remove" });
    expect(surfaces.selectedNoteIds()).toEqual([]);
  });

  it("deletes nothing with no clip open", () => {
    const { surfaces, dispatch } = setup(null);
    surfaces.deleteSelection();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("holds what the piano roll, the arrangement and the loop brace hand up", () => {
    const { surfaces } = setup(null);
    expect(surfaces.hasArrangementSelection()).toBe(false);
    const actions = { hasSelection: () => true } as unknown as PlacementEditingActions;
    surfaces.setArrangementEditingActions(actions);
    surfaces.setLoopBraceFocused(true);
    flush();
    expect(surfaces.arrangementEditingActions()).toBe(actions);
    expect(surfaces.hasArrangementSelection()).toBe(true);
    expect(surfaces.loopBraceFocused()).toBe(true);
    expect(surfaces.pianoRollActions()).toBeNull();
  });
});
