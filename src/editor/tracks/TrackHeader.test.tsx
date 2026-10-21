import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandHistory, type RawCommandInput } from "../../commands";
import type { Track } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import TrackHeader from "./TrackHeader";

afterEach(cleanup);

/** One header over a real history, so a toggle really changes the track. */
function renderHeader(
  selected = false,
  withDelete = false,
  surface: "arrangement" | "instrument" = "arrangement",
) {
  const history = new CommandHistory(createSliceFixtureProject());
  const [project, setProject] = createSignal(history.project);
  const dispatch = (commands: RawCommandInput | readonly RawCommandInput[]) => {
    const result = history.execute(commands);
    setProject(history.project);
    return result;
  };
  const trackId = history.project.song.tracks[0]?.id;
  const track = () => project().song.tracks.find((t) => t.id === trackId) as Track;
  const onSelect = vi.fn();
  const onDragStart = vi.fn();
  const onDelete = vi.fn();
  render(() => (
    <TrackHeader
      track={track()}
      selected={selected}
      onSelect={onSelect}
      dispatch={dispatch}
      beginGesture={(options) => {
        const gesture = history.beginGesture(options);
        return {
          get active() {
            return gesture.active;
          },
          apply(commands) {
            const result = gesture.apply(commands);
            setProject(history.project);
            return result;
          },
          commit(summary) {
            const entry = gesture.commit(summary);
            setProject(history.project);
            return entry;
          },
          cancel: () => gesture.cancel(),
        };
      }}
      trackLevel={() => null}
      onDragStart={onDragStart}
      onDelete={withDelete ? onDelete : undefined}
      surface={surface}
    />
  ));
  return { history, track, onSelect, onDragStart, onDelete };
}

describe("TrackHeader (#447)", () => {
  it("shows the swatch, the name as the Edit control, M, S, volume and level", () => {
    const { track } = renderHeader(true);
    const name = track().name;
    const edit = screen.getByRole("button", { name: `Edit ${name}` });
    expect(edit).toHaveAttribute("aria-pressed", "true");
    expect(edit).toHaveTextContent(name);
    expect(screen.getByRole("button", { name: `Colour for ${name}` })).toHaveStyle({
      background: track().color,
    });
    expect(screen.getByRole("button", { name: `Mute ${name}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Solo ${name}` })).toBeInTheDocument();
    const volume = screen.getByRole("slider", { name: `Volume for ${name}` });
    expect(volume).toHaveAttribute("aria-orientation", "horizontal");
    expect(volume.id).toBe(`arrangement-volume-${track().id}`);
    expect(screen.getByRole("meter", { name: "Level" })).toBeInTheDocument();
  });

  it("mutes and solos through the command layer, and selects the track", () => {
    const { history, track, onSelect } = renderHeader();
    const name = track().name;

    clickAndFlush(screen.getByRole("button", { name: `Mute ${name}` }));
    expect(track().mixer.muted).toBe(true);
    expect(screen.getByRole("button", { name: `Edit ${name} (muted)` })).toBeVisible();
    clickAndFlush(screen.getByRole("button", { name: `Solo ${name}` }));
    expect(track().mixer.soloed).toBe(true);
    expect(screen.getByRole("button", { name: `Solo ${name}` })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(history.canUndo).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("sets the volume through the command layer, and selects the track", () => {
    const { track, onSelect } = renderHeader();
    const before = track().mixer.volume;
    const volume = screen.getByRole("slider", { name: `Volume for ${track().name}` });

    fireAndFlush(() => {
      fireEvent.input(volume, { target: { value: "0.2" } });
      fireEvent.change(volume, { target: { value: "0.2" } });
    });

    expect(track().mixer.volume).toBeLessThan(before);
    expect(onSelect).toHaveBeenCalled();
  });

  it("selects once from the name, and not again when already selected", () => {
    const { track, onSelect } = renderHeader();
    clickAndFlush(screen.getByRole("button", { name: `Edit ${track().name}` }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    cleanup();

    const again = renderHeader(true);
    clickAndFlush(document.querySelector(".track-header") as Element);
    expect(again.onSelect).not.toHaveBeenCalled();
  });

  it("starts a drag from the header, never from its controls", () => {
    const { track, onDragStart } = renderHeader();
    fireEvent.pointerDown(screen.getByRole("slider"));
    fireEvent.pointerDown(screen.getByRole("button", { name: `Mute ${track().name}` }));
    expect(onDragStart).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole("button", { name: `Edit ${track().name}` }));
    fireEvent.pointerDown(document.querySelector(".track-header") as Element);
    expect(onDragStart).toHaveBeenCalledTimes(2);
  });

  it("offers no control that would do nothing, on a surface that cannot edit", () => {
    const track = createSliceFixtureProject().song.tracks[0];
    render(() => (
      <TrackHeader
        track={track}
        selected={false}
        onSelect={() => {}}
        trackLevel={() => null}
        surface="arrangement"
      />
    ));
    expect(
      screen.getByRole("button", { name: `Edit ${track.name}` }),
    ).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Level" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Mute ${track.name}` })).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("button", { name: `Colour for ${track.name}` })).toBeNull();
  });

  it("offers a labelled trash button that deletes without selecting the track (#537)", async () => {
    const { track, onDelete, onSelect } = renderHeader(false, true);
    await clickAndFlush(screen.getByRole("button", { name: `Delete ${track().name}` }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows no trash button when the surface cannot delete (#537)", () => {
    const { track } = renderHeader(false, false);
    expect(
      screen.queryByRole("button", { name: `Delete ${track().name}` }),
    ).not.toBeInTheDocument();
  });

  describe.each(["arrangement", "instrument"] as const)(
    "renaming, on the %s",
    (surface) => {
      /** Clicks the name text, as a person does, and reads the input it opens. */
      const startRename = (name: string) => {
        const label = screen.getByText(name, { selector: ".track-header-name" });
        clickAndFlush(label);
        return screen.getByRole("textbox", { name: "Track name" }) as HTMLInputElement;
      };

      it("starts on a click of the name, selecting the track too", async () => {
        const { track, onSelect } = renderHeader(false, false, surface);
        const input = startRename(track().name);
        await Promise.resolve();
        expect(input).toHaveFocus();
        expect(onSelect).toHaveBeenCalled();
      });

      it("commits one undo entry on Enter's change, and closes the editor", () => {
        const { history, track } = renderHeader(false, false, surface);
        const input = startRename(track().name);
        input.value = "Kick drum";
        fireAndFlush(() => fireEvent.change(input));
        expect(history.project.song.tracks[0].name).toBe("Kick drum");
        expect(screen.queryByRole("textbox", { name: "Track name" })).toBeNull();
        history.undo();
        expect(history.canUndo).toBe(false);
      });

      it("cancels on Escape, changing nothing", () => {
        const { history, track } = renderHeader(false, false, surface);
        const name = track().name;
        const input = startRename(name);
        input.focus();
        input.value = "Nope";
        fireAndFlush(() => fireEvent.keyDown(input, { key: "Escape", bubbles: true }));
        expect(screen.queryByRole("textbox", { name: "Track name" })).toBeNull();
        expect(history.canUndo).toBe(false);
        expect(history.project.song.tracks[0].name).toBe(name);
      });

      it("does not drag from the open name field", () => {
        const { track, onDragStart } = renderHeader(false, false, surface);
        fireEvent.pointerDown(startRename(track().name));
        expect(onDragStart).not.toHaveBeenCalled();
      });
    },
  );

  it("does not offer rename on a surface that cannot edit", () => {
    const track = createSliceFixtureProject().song.tracks[0];
    render(() => (
      <TrackHeader
        track={track}
        selected={false}
        onSelect={() => {}}
        trackLevel={() => null}
        surface="arrangement"
      />
    ));
    clickAndFlush(screen.getByText(track.name, { selector: ".track-header-name" }));
    expect(screen.queryByRole("textbox", { name: "Track name" })).toBeNull();
  });
});
