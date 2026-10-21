import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTrackFlag } from "../../commands";
import type { Clip, Project, Track } from "../../domain/entities";
import {
  createDrumMachineInstrument,
  createDrumPad,
  createFactoryContext,
} from "../../domain/factories";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import { clickAndFlush } from "../../testing/events";
import { loopEntryFor, showPianoRoll } from "../composition/editorViewModel";
import SequenceEditor, { type SequenceEditorProps } from "./SequenceEditor";

afterEach(cleanup);

/**
 * The sequence editor over one clip, with the session's operations stubbed:
 * what this file asserts is the *surface* — the window, its name, its close,
 * and which editor a clip gets. The command paths underneath are covered where
 * they live (`StepEditor`, `PianoRoll`, `TransformPanel`), and the gesture that
 * opens this is covered in `EditorView.test.tsx`.
 */
function renderEditorFor(
  project: Project,
  pick: (project: Project) => { clip: Clip; track: Track },
  extra: Partial<SequenceEditorProps> = {},
) {
  const { clip, track } = pick(project);
  const rendered = render(() => (
    <SequenceEditor
      clip={clip}
      track={track}
      project={project}
      showPianoRoll={() => showPianoRoll(track, clip)}
      loop={loopEntryFor(project, clip)}
      songTempo={project.song.tempo}
      editorPlaybackStep={() => null}
      selectedNoteIds={() => []}
      setSelectedNoteIds={() => {}}
      playheadTicks={0}
      registerPianoRollActions={() => {}}
      dispatch={() => undefined}
      beginGesture={() => undefined}
      {...extra}
    />
  ));
  return { ...rendered, clip, track };
}

/**
 * The slice fixture as a drum machine: one "BD" pad on the kick sample, the
 * four-on-the-floor clip re-pointed at that pad. A sampler note clip opens the
 * piano roll (#496), so the step grid is only reachable through a drum machine.
 */
function createStepGridProject(): Project {
  const project = createSliceFixtureProject();
  const [track] = project.song.tracks;
  const [asset] = project.song.assets;
  const pad = createDrumPad(createFactoryContext(), { name: "BD", assetId: asset.id });
  return {
    ...project,
    song: {
      ...project.song,
      tracks: [{ ...track, instrument: createDrumMachineInstrument([pad]) }],
    },
    clips: project.clips.map((clip) =>
      clip.content.kind === "notes"
        ? {
            ...clip,
            content: {
              ...clip.content,
              events: clip.content.events.map((event) => ({
                ...event,
                trigger: { kind: "pad" as const, padId: pad.id },
              })),
            },
          }
        : clip,
    ),
  };
}

/** The slice fixture's sampler track and its four-on-the-floor note clip. */
const starterClip = (project: Project) => {
  const track = project.song.tracks[0];
  const clip = project.clips.find((candidate) => candidate.trackId === track.id);
  if (!clip) throw new Error("fixture has no clip on its first track");
  return { clip, track };
};

describe("SequenceEditor", () => {
  it("is a named region, not a dialog, with the track it is editing (UI-002)", () => {
    const project = createSliceFixtureProject();
    const { track } = renderEditorFor(project, starterClip);

    const dialog = screen.getByRole("region", { name: "Sequence editor" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Both the editor's own title and the clip editor's track info name it.
    expect(
      within(dialog).getByText(track.name, { selector: ".sequence-editor-title" }),
    ).toBeInTheDocument();
  });

  it("gives a drum-machine clip the step editor, with the clip's own steps", () => {
    const project = createStepGridProject();
    renderEditorFor(project, starterClip);

    const dialog = screen.getByRole("region", { name: "Sequence editor" });
    expect(within(dialog).getByRole("region", { name: "Step editor" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "BD, step 1, on" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "BD, step 2, off" })).toBeVisible();
    expect(within(dialog).queryByRole("region", { name: /Piano roll/ })).toBeNull();
  });

  it("hands a picked row to the host as the selected pad, and plays it (#643)", () => {
    const project = createStepGridProject();
    const onSelectPad = vi.fn();
    const auditionPad = vi.fn();
    const { track } = renderEditorFor(project, starterClip, {
      selectedPadId: null,
      onSelectPad,
      auditionPad,
    });
    const pad =
      track.instrument?.kind === "drumMachine" ? track.instrument.pads[0] : null;

    const rows = within(screen.getByRole("group", { name: "Rows" }));
    clickAndFlush(rows.getByRole("button", { name: "BD" }));
    expect(onSelectPad).toHaveBeenCalledExactlyOnceWith(pad?.id);
    expect(auditionPad).toHaveBeenCalledExactlyOnceWith(pad?.id);
  });

  it("plays the song from the step grid's Play (#643)", () => {
    const onTogglePlay = vi.fn();
    renderEditorFor(createStepGridProject(), starterClip, { onTogglePlay });
    clickAndFlush(screen.getByRole("button", { name: "Play" }));
    expect(onTogglePlay).toHaveBeenCalledOnce();
  });

  it("solos the clip's track from the step grid's Solo (#657)", () => {
    const dispatch = vi.fn();
    const { track } = renderEditorFor(createStepGridProject(), starterClip, {
      dispatch,
    });
    clickAndFlush(screen.getByRole("button", { name: "Solo" }));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      setTrackFlag(track.id, "soloed", true),
    );
  });

  it("puts Generate beside Transform, previewing into the selected row (#643)", () => {
    const dispatch = vi.fn(() => ({ ok: true }) as never);
    renderEditorFor(createStepGridProject(), starterClip, { dispatch });
    const generate = within(screen.getByRole("region", { name: "Generate" }));
    expect(screen.getByRole("region", { name: "Generate" })).toHaveTextContent("into BD");
    expect(screen.getByRole("region", { name: "Transform" })).toBeInTheDocument();

    // Offbeats over the kick: its four steps hatched, the kick's four fading.
    fireEvent.pointerEnter(generate.getByRole("button", { name: "Offbeats" }));
    flush();
    expect(screen.getByRole("button", { name: "BD, step 3, off" })).toHaveClass("ghost");
    expect(screen.getByRole("button", { name: "BD, step 1, on" })).toHaveClass("fading");
    expect(dispatch).not.toHaveBeenCalled();

    clickAndFlush(generate.getByRole("button", { name: "Offbeats" }));
    expect(dispatch).toHaveBeenCalledOnce();
    fireEvent.pointerLeave(screen.getByRole("region", { name: "Generate" }));
    flush();
    expect(document.querySelectorAll(".step-cell.ghost, .step-cell.fading")).toHaveLength(
      0,
    );
  });

  it("gives a sampler note clip the piano roll, not the step editor (#496)", () => {
    renderEditorFor(createSliceFixtureProject(), starterClip);

    const dialog = screen.getByRole("region", { name: "Sequence editor" });
    expect(within(dialog).getByRole("region", { name: /Piano roll/ })).toBeVisible();
    expect(within(dialog).queryByRole("region", { name: "Step editor" })).toBeNull();
  });

  it("gives a synth clip the piano roll, with the Key and Transform panels under it", () => {
    const project = createPianoRollFixtureProject();
    const onTogglePlay = vi.fn();
    const audition = vi.fn();
    renderEditorFor(project, starterClip, {
      onTogglePlay,
      audition,
      playing: true,
    });

    const dialog = screen.getByRole("region", { name: "Sequence editor" });
    expect(within(dialog).getByRole("region", { name: /^Piano roll\b/ })).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "Key" })).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "Transform" })).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Quantize to scale" }),
    ).toBeDisabled();
    expect(within(dialog).queryByRole("region", { name: "Step editor" })).toBeNull();

    // The roll's Play is the transport's, and its preview plays the track.
    clickAndFlush(within(dialog).getByRole("button", { name: "Stop" }));
    expect(onTogglePlay).toHaveBeenCalledOnce();
    const c3 = within(within(dialog).getByRole("group", { name: "Pitches" })).getByRole(
      "button",
      { name: "C3" },
    );
    c3.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(audition).toHaveBeenCalledWith(60, 0.8);
  });

  it("shows the loop panel instead for a tempo-labelled audio loop", () => {
    // LOOP-006's panel used to sit in the workspace beside everything else;
    // an audio loop has no notes to program, so this is what opening one shows.
    const project = createDrumMachineFixtureProject();
    renderEditorFor(project, (current) => {
      const clip = current.clips.find((c) => c.content.kind === "audioLoop");
      if (!clip) throw new Error("fixture has no audio loop");
      const track = current.song.tracks.find((t) => t.id === clip.trackId);
      if (!track) throw new Error("the loop clip has no track");
      return { clip, track };
    });

    const dialog = screen.getByRole("region", { name: "Sequence editor" });
    expect(within(dialog).getByRole("region", { name: "Audio loop" })).toBeVisible();
    // Instead, not as well: a step grid and note transforms on an audio clip
    // would offer to edit notes it does not have (#281).
    expect(within(dialog).queryByRole("region", { name: "Step editor" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Transpose" })).toBeNull();
  });
});
