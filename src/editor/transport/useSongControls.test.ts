import { cleanup, renderHook } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Analytics } from "../../analytics/analytics";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { SONG_SWING, SONG_TEMPO } from "../../domain/parameters";
import { useSongControls } from "./useSongControls";

afterEach(() => cleanup());

function setup(initial: Project | null = createSliceFixtureProject()) {
  const [project, setProject] = createSignal<Project | null>(initial);
  const dispatch = vi.fn((_command: unknown) => ({ ok: true }) as never);
  // No gesture: a control falls back to plain dispatch, one command per step.
  const beginGesture = vi.fn(() => undefined);
  const log = vi.fn();
  const logFeatureFirstUse = vi.fn();
  const analytics = { log, logFeatureFirstUse } as unknown as Analytics;
  const { result } = renderHook(() =>
    useSongControls({
      project,
      session: { dispatch, beginGesture },
      analytics: () => analytics,
    }),
  );
  flush();
  return { song: result, setProject, dispatch, log, logFeatureFirstUse };
}

describe("useSongControls", () => {
  it("reads the song's tempo and swing, with the defaults before a project opens", () => {
    const { song, setProject } = setup(null);
    expect(song.tempo()).toBe(SONG_TEMPO.defaultValue);
    expect(song.swing()).toBe(SONG_SWING.defaultValue);
    const project = createSliceFixtureProject();
    setProject(project);
    flush();
    expect(song.tempo()).toBe(project.song.tempo);
    expect(song.swing()).toBe(project.song.swing);
  });

  it("sets the tempo through one command, clamped to the supported range", () => {
    const { song, dispatch } = setup();
    song.applyTempo(400);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "parameter.set",
      payload: { target: { scope: "song", parameterId: SONG_TEMPO.id }, value: 240 },
    });
  });

  it("ignores a tempo that is not a number", () => {
    const { song, dispatch } = setup();
    song.applyTempo(Number.NaN);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("writes swing through parameter.set, and counts a commit as first use", () => {
    const { song, dispatch, logFeatureFirstUse } = setup();
    song.swingInput(0.3);
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "parameter.set",
      payload: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 0.3 },
    });
    expect(logFeatureFirstUse).not.toHaveBeenCalled();
    song.commitSwing(0.3);
    expect(logFeatureFirstUse).toHaveBeenCalledWith("swing");
  });

  it("flips the song's loop through one command and logs it", () => {
    const project = createSliceFixtureProject();
    const { song, dispatch, log } = setup(project);
    song.toggleLoop();
    const enabled = !project.song.loop.enabled;
    expect(dispatch).toHaveBeenCalledWith({
      type: "loop.setEnabled",
      payload: { enabled },
    });
    expect(log).toHaveBeenCalledWith("loop_toggled", { enabled });
  });

  it("moves and resizes the loop brace through commands", () => {
    const { song, dispatch } = setup();
    song.moveLoop(1);
    song.resizeLoop(1);
    expect(
      dispatch.mock.calls.map(([command]) => (command as { type: string }).type),
    ).toEqual(["loop.setRange", "loop.setRange"]);
  });
});
