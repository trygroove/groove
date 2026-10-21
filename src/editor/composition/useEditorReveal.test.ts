import { cleanup, renderHook } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import { emptySelection } from "../../selection";
import { createManualScheduler } from "../../shared/scheduler";
import { useTrackSelection } from "../tracks/useTrackSelection";
import type { EditorViewName } from "./editorViews";
import type { EditorNavigation } from "./useEditorNavigation";
import { useEditorReveal } from "./useEditorReveal";

afterEach(() => cleanup());

function setup(initial: Project | null = createDrumMachineFixtureProject()) {
  const [view, setView] = createSignal<EditorViewName>("arrangement");
  const navigation: Pick<EditorNavigation, "selectView"> = {
    selectView: vi.fn((next: EditorViewName) => setView(next)),
  };
  const scheduler = createManualScheduler();
  const project = () => initial;
  const hook = renderHook(() => {
    const selection = useTrackSelection({ project });
    const controls = useEditorReveal({
      registry: createControlRegistry(),
      project,
      view,
      navigation,
      selection,
      scheduler,
    });
    return { selection, controls };
  });
  flush();
  return { ...hook.result, unmount: hook.cleanup, navigation, scheduler, view };
}

describe("useEditorReveal", () => {
  it("reveals a track's volume in the mixer, selecting its track, and says where it was", () => {
    const project = createDrumMachineFixtureProject();
    const { controls, selection, navigation, view } = setup(project);
    const [, second] = project.song.tracks;

    const before = controls.revealControl({ entity: second.id, param: "volume" });
    flush();

    expect(before.view).toBe("arrangement");
    expect(before.selection).toEqual(emptySelection());
    expect(navigation.selectView).toHaveBeenCalledWith("mixer", "reveal");
    expect(view()).toBe("mixer");
    expect(selection.selectedTrackId()).toBe(second.id);
  });

  it("puts the view and the selection back where a reveal found them", () => {
    const project = createDrumMachineFixtureProject();
    const { controls, selection, navigation, view } = setup(project);
    const [first, second] = project.song.tracks;
    selection.selectTrack(first.id);
    flush();

    const before = controls.revealControl({ entity: second.id, param: "pan" });
    flush();
    controls.restoreView(before);
    flush();

    expect(navigation.selectView).toHaveBeenLastCalledWith("arrangement", "reveal");
    expect(view()).toBe("arrangement");
    expect(selection.selectedTrackId()).toBe(first.id);
  });

  it("moves nothing with no project open", () => {
    const { controls, navigation } = setup(null);
    const before = controls.revealControl({ entity: "song", param: "tempo" });
    expect(before.view).toBe("arrangement");
    expect(navigation.selectView).not.toHaveBeenCalled();
  });

  it("stops waiting for a control when the editor goes", () => {
    const project = createDrumMachineFixtureProject();
    const { controls, scheduler, unmount } = setup(project);
    controls.revealControl({ entity: project.song.tracks[0].id, param: "volume" });
    expect(scheduler.pending).toBe(1);
    unmount();
    expect(scheduler.pending).toBe(0);
  });
});
