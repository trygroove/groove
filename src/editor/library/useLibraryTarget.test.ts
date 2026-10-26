import { cleanup, renderHook } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Analytics } from "../../analytics/analytics";
import type { Project } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
} from "../../domain/fixtures";
import type { PadId } from "../../domain/ids";
import type { LibraryClient } from "../../library/libraryClient";
import type { EditorViewName } from "../composition/editorViews";
import type { EditorNavigation } from "../composition/useEditorNavigation";
import type { ProjectAudioControls } from "../composition/useProjectAudio";
import { useTrackSelection } from "../tracks/useTrackSelection";
import type { LibraryActions } from "./LibraryModal";
import { useLibraryTarget } from "./useLibraryTarget";

afterEach(() => cleanup());

function setup(view: EditorViewName = "instrument") {
  // A drum track, a loop track, and a synth, which plays no samples.
  const kit = createDrumMachineFixtureProject();
  const [synth] = createPianoRollFixtureProject().song.tracks;
  const project: Project = {
    ...kit,
    song: { ...kit.song, tracks: [...kit.song.tracks, synth] },
  };
  const [drums, loop] = project.song.tracks;
  const [currentView, setView] = createSignal<EditorViewName>(view);
  const navigation: EditorNavigation = {
    selectView: vi.fn((next: EditorViewName) => setView(next)),
    libraryReturn: () => "arrangement",
  };
  const audio = {
    previewInSlot: vi.fn(),
    clearPreview: vi.fn(),
    isPlaying: () => false,
  } as unknown as ProjectAudioControls;
  const { result } = renderHook(() => {
    const projectAccessor = () => project as Project | null;
    const selection = useTrackSelection({
      project: projectAccessor,
      onPoint: () => library.endNewAim(),
    });
    const library = useLibraryTarget({
      project: projectAccessor,
      view: currentView,
      session: { dispatch: vi.fn() },
      analytics: () => ({ log: vi.fn() }) as unknown as Analytics,
      selection,
      navigation,
      audio,
      client: {} as LibraryClient,
    });
    return { selection, library };
  });
  flush();
  return { ...result, navigation, audio, setView, drums, loop, synth };
}

function padIds(track: Project["song"]["tracks"][number]): PadId[] {
  if (track.instrument?.kind !== "drumMachine") throw new Error("expected drums");
  return track.instrument.pads.map((pad) => pad.id);
}

describe("useLibraryTarget", () => {
  it("aims at the selected drum track's selected pad", () => {
    const { library, selection, drums } = setup();
    const pad = padIds(drums)[1];
    selection.selectPad(drums.id, pad);
    flush();
    expect(library.target()).toEqual({ kind: "pad", trackId: drums.id, padId: pad });
    expect(library.isTarget({ kind: "pad", padId: pad })).toBe(true);
    expect(library.isTarget({ kind: "pad", padId: padIds(drums)[0] })).toBe(false);
    expect(library.isTarget({ kind: "sampler" })).toBe(false);
  });

  it("aims at a loop track's loop", () => {
    const { library, selection, loop } = setup();
    selection.selectTrack(loop.id);
    flush();
    expect(library.target()).toEqual({ kind: "loop", trackId: loop.id });
    expect(library.isTarget({ kind: "loop" })).toBe(true);
  });

  it("says why it is aimed nowhere when the track plays no samples", () => {
    const { library, selection, synth } = setup();
    selection.selectTrack(synth.id);
    flush();
    expect(library.target()).toBeNull();
    expect(library.aimed()).toEqual({ kind: "synth" });
  });

  it("aims at a new track and goes to the Library, until a track is selected", () => {
    const { library, selection, navigation, drums } = setup();
    library.aim("arrangement", "new-track");
    flush();
    expect(navigation.selectView).toHaveBeenCalledWith("library", "arrangement");
    expect(library.target()).toEqual({ kind: "new-track" });

    selection.selectTrack(drums.id);
    flush();
    expect(library.target()?.kind).not.toBe("new-track");
  });

  it("ends a new-track aim when asked", () => {
    const { library } = setup();
    library.aim("slot", "new-track");
    flush();
    library.endNewAim();
    flush();
    expect(library.target()?.kind).not.toBe("new-track");
  });

  it("aims at a new pad and goes back to where it was asked for, until a pad is selected (#947)", () => {
    const { library, selection, navigation, drums } = setup();
    selection.selectTrack(drums.id);
    library.aim("slot", "new-pad");
    flush();
    expect(navigation.selectView).toHaveBeenLastCalledWith("library", "slot");
    expect(library.target()).toEqual({ kind: "new-pad", trackId: drums.id });
    library.returnFromInsert("keyboard");
    expect(navigation.selectView).toHaveBeenLastCalledWith("arrangement", "keyboard");

    selection.selectPad(drums.id, padIds(drums)[0]);
    flush();
    expect(library.target()?.kind).toBe("pad");
  });

  it("is open only on the Library view with somewhere to insert", () => {
    const { library, setView, selection, synth, drums } = setup();
    selection.selectPad(drums.id, padIds(drums)[0]);
    flush();
    expect(library.isOpen()).toBe(false);
    setView("library");
    flush();
    expect(library.isOpen()).toBe(true);
    selection.selectTrack(synth.id);
    flush();
    expect(library.isOpen()).toBe(false);
  });

  it("goes back to the instrument, or for a new track to where it was asked for", () => {
    const { library, navigation, selection, drums } = setup("library");
    selection.selectPad(drums.id, padIds(drums)[0]);
    flush();
    library.returnFromInsert("library_insert");
    expect(navigation.selectView).toHaveBeenLastCalledWith(
      "instrument",
      "library_insert",
    );

    library.aim("arrangement", "new-track");
    flush();
    library.returnFromInsert("keyboard");
    expect(navigation.selectView).toHaveBeenLastCalledWith("arrangement", "keyboard");
  });

  it("still goes back to where it was asked for after an insert that stayed open (GRV-227)", () => {
    const { library, navigation, selection, loop } = setup("library");
    library.aim("arrangement", "new-track");
    flush();
    // Shift+Enter: the insert commits against the new-track aim, then selects
    // the track it made, which re-aims the Library at that track's loop slot.
    void library.insert({ kind: "new-track" }, {} as never, {} as never);
    selection.selectTrack(loop.id);
    flush();
    expect(library.target()?.kind).toBe("loop");

    // The next Enter replaces that loop and still goes back to the arrangement.
    void library.insert(
      { kind: "loop", trackId: loop.id } as never,
      {} as never,
      {} as never,
    );
    library.returnFromInsert("keyboard");
    expect(navigation.selectView).toHaveBeenLastCalledWith("arrangement", "keyboard");

    // A visit that began on the track's slot does not.
    library.aim("slot");
    flush();
    library.returnFromInsert("keyboard");
    expect(navigation.selectView).toHaveBeenLastCalledWith("instrument", "keyboard");
  });

  it("auditions through the pad it is aimed at, and standalone for a new track", () => {
    const { library, audio, selection, drums } = setup();
    const pad = padIds(drums)[0];
    selection.selectPad(drums.id, pad);
    flush();
    const slot = library.slotAudition();
    expect(slot).toBeDefined();
    slot?.clear();
    expect(audio.clearPreview).toHaveBeenCalledTimes(1);

    library.aim("arrangement", "new-track");
    flush();
    expect(library.slotAudition()).toBeUndefined();
  });

  it("holds the open library modal's actions for the shortcuts", () => {
    const { library } = setup();
    expect(library.actions()).toBeNull();
    const actions = { back: vi.fn() } as unknown as LibraryActions;
    library.registerActions(actions);
    flush();
    expect(library.actions()).toBe(actions);
    library.registerActions(null);
    flush();
    expect(library.actions()).toBeNull();
  });
});
