import { cleanup, renderHook } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Analytics } from "../analytics/analytics";
import type { Project } from "../domain/entities";
import { createDrumMachineFixtureProject } from "../domain/fixtures";
import type { EditorViewName } from "./editorViews";
import { useEditingSurfaces } from "./useEditingSurfaces";
import type { EditorNavigation } from "./useEditorNavigation";
import type { UseEditorSessionResult } from "./useEditorSession";
import { useEditorShortcuts } from "./useEditorShortcuts";
import type { LibraryTargeting } from "./useLibraryTarget";
import type { ProjectAudioControls } from "./useProjectAudio";
import type { SongControls } from "./useSongControls";
import { useTrackSelection } from "./useTrackSelection";

afterEach(() => cleanup());

/**
 * The editor's shortcut wiring over its hooks: a real selection and real
 * editing surfaces, and stand-ins for everything that would need audio, a
 * repository or the Library.
 */
function setup(
  view: EditorViewName,
  ask: { readonly optionCount?: number; readonly pick?: (index: number) => boolean } = {},
) {
  const project = createDrumMachineFixtureProject();
  const [currentView] = createSignal<EditorViewName>(view);
  const dispatch = vi.fn(() => ({ ok: true }) as never);
  const session = {
    dispatch,
    state: { canUndo: false, canRedo: false },
  } as unknown as UseEditorSessionResult;
  const audio = {
    positionTicks: () => 0,
    isPlaying: () => false,
  } as ProjectAudioControls;
  const navigation: EditorNavigation = {
    selectView: vi.fn(),
    libraryReturn: () => "instrument",
  };
  const library = {
    isOpen: () => false,
    actions: () => null,
    returnFromInsert: vi.fn(),
  } as unknown as LibraryTargeting;
  const song = {
    toggleLoop: vi.fn(),
    moveLoop: vi.fn(),
    resizeLoop: vi.fn(),
  } as unknown as SongControls;
  const { result } = renderHook(() => {
    const projectAccessor = () => project as Project | null;
    const selection = useTrackSelection({ project: projectAccessor });
    const surfaces = useEditingSurfaces({ opened: selection.opened, audio, session });
    useEditorShortcuts({
      view: currentView,
      project: projectAccessor,
      audio,
      session,
      analytics: () =>
        ({ log: vi.fn(), logFeatureFirstUse: vi.fn() }) as unknown as Analytics,
      navigation,
      selection,
      library,
      song,
      surfaces,
      openPlacement: vi.fn(),
      guideOpen: () => false,
      setGuideOpen: vi.fn(),
      exportOpen: () => false,
      assistant: {
        toggle: vi.fn(),
        resizeBy: vi.fn(),
        dismissAction: () => undefined,
        edgeHasFocus: () => false,
        composerHasFocus: () => false,
        askTextHasFocus: () => false,
        focusInPanelOutsideFields: () => ask.optionCount !== undefined,
      },
      sendAssistantDraft: vi.fn(),
      assistantAsk: {
        pending: () => ask.optionCount !== undefined,
        optionCount: () => ask.optionCount ?? 0,
        multiSelect: () => false,
        pick: ask.pick ?? (() => false),
        canFinish: () => false,
        finish: () => false,
        focused: () => null,
        canHear: () => false,
        hear: () => false,
      },
    });
    return selection;
  });
  flush();
  const [first, second] = project.song.tracks;
  return { selection: result, dispatch, navigation, first, second };
}

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  flush();
  return event;
}

describe("useEditorShortcuts", () => {
  it("picks a question's options by number, and leaves a digit past the last alone (GRV-42)", () => {
    const pick = vi.fn(() => true);
    setup("arrangement", { optionCount: 3, pick });
    expect(press("3").defaultPrevented).toBe(true);
    expect(pick).toHaveBeenCalledWith(2);
    expect(press("4").defaultPrevented).toBe(false);
    expect(pick).toHaveBeenCalledOnce();
  });

  it("steps the chosen track with the arrows", () => {
    const { selection, first, second } = setup("instrument");
    selection.selectTrack(first.id);
    flush();
    press("ArrowDown");
    expect(selection.selectedTrackId()).toBe(second.id);
    expect(selection.deletableTrackId()).toBe(second.id);
  });

  it("leaves the arrows to the mixer", () => {
    const { selection, first } = setup("mixer");
    selection.selectTrack(first.id);
    flush();
    press("ArrowDown");
    expect(selection.selectedTrackId()).toBe(first.id);
  });

  it("deletes only a track the user chose (#960)", () => {
    const { selection, dispatch, second } = setup("arrangement");
    selection.selectTrack(second.id);
    flush();
    press("Backspace");
    expect(dispatch).not.toHaveBeenCalled();

    selection.chooseTrack(second.id);
    flush();
    press("Backspace");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("never deletes a track from the sequence view", () => {
    const { selection, dispatch, second } = setup("sequence");
    selection.chooseTrack(second.id);
    flush();
    press("Backspace");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lets go of the chosen track on Escape", () => {
    const { selection, second } = setup("arrangement");
    selection.chooseTrack(second.id);
    flush();
    press("Escape");
    expect(selection.deletableTrackId()).toBeNull();
    expect(selection.selectedTrackId()).toBe(second.id);
  });

  it("switches views through the same path as the dock, as the keyboard", () => {
    const { navigation } = setup("arrangement");
    press("2");
    expect(navigation.selectView).toHaveBeenCalledWith("sequence", "keyboard");
  });
});
