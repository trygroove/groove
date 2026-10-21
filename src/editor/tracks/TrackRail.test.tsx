import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandHistory } from "../../commands";
import type { Track } from "../../domain/entities";
import { createReferenceProject, createSliceFixtureProject } from "../../domain/fixtures";
import type { TrackId } from "../../domain/ids";
import { dragTrackHandle, stubTrackDragLayout } from "../../testing/trackDrag";
import TrackRail from "./TrackRail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TrackRail reorder (#447)", () => {
  it("drags a row to reorder its track, previewing it in its new place", async () => {
    const [a, b, c] = createReferenceProject({ trackCount: 3, placementCount: 3 }).song
      .tracks;
    const [tracks] = createSignal<readonly Track[]>([a, b, c]);
    const onReorder = vi.fn<(trackId: TrackId, toIndex: number) => void>();
    render(() => (
      <TrackRail
        tracks={tracks()}
        selectedTrackId={null}
        onSelect={() => {}}
        onReorder={onReorder}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));
    stubTrackDragLayout({
      axis: "y",
      zoneSelector: ".track-rail",
      size: 80,
      zoneLength: 240,
      order: () => tracks().map((track) => track.id),
    });
    const row = (track: Track) =>
      screen.getByRole("button", { name: `Edit ${track.name}` });

    dragTrackHandle(row(c), { x: 50, y: 2 }, () => {
      const shown = [...document.querySelectorAll<HTMLElement>("[data-track-drag]")];
      expect(shown.map((li) => li.dataset.trackDrag)).toEqual([c.id, a.id, b.id]);
      expect(shown[0]).toHaveClass("track-dragging");
      expect(onReorder).not.toHaveBeenCalled();
    });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(c.id, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("picks the row up: a copy follows the pointer, and Escape puts it back (#539)", async () => {
    const [a, b, c] = createReferenceProject({ trackCount: 3, placementCount: 3 }).song
      .tracks;
    const [tracks] = createSignal<readonly Track[]>([a, b, c]);
    const onReorder = vi.fn<(trackId: TrackId, toIndex: number) => void>();
    render(() => (
      <TrackRail
        tracks={tracks()}
        selectedTrackId={null}
        onSelect={() => {}}
        onReorder={onReorder}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));
    stubTrackDragLayout({
      axis: "y",
      zoneSelector: ".track-rail",
      size: 80,
      zoneLength: 240,
      order: () => tracks().map((track) => track.id),
    });
    const handle = screen.getByRole("button", { name: `Edit ${c.name}` });
    const at = (type: string, y: number) =>
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: y });
    expect(document.querySelector(".drag-lift")).toBeNull();

    fireEvent(handle, at("pointerdown", 1));
    fireEvent(window, at("pointermove", 10));
    flush();
    const copy = document.querySelector<HTMLElement>(".drag-lift");
    expect(copy).not.toBeNull();
    expect(copy?.textContent).toContain(c.name);
    expect(copy?.style.transform).toBe("translate(0px, 9px)");
    // The original is the gap, and the copy is not one of the rows.
    expect(document.querySelector(".track-dragging")).toHaveAttribute(
      "data-track-drag",
      c.id,
    );
    expect(document.querySelectorAll("[data-track-drag]")).toHaveLength(3);

    fireEvent(window, at("pointermove", 100));
    expect(copy?.style.transform).toBe("translate(0px, 99px)");

    fireEvent.keyDown(window, { key: "Escape" });
    flush();
    expect(document.querySelector(".drag-lift")).toBeNull();
    expect(document.querySelector(".track-dragging")).toBeNull();
    fireEvent(window, at("pointerup", 2));
    flush();
    expect(onReorder).not.toHaveBeenCalled();
    const order = [...document.querySelectorAll<HTMLElement>("[data-track-drag]")];
    expect(order.map((li) => li.dataset.trackDrag)).toEqual([a.id, b.id, c.id]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("is not a drag handle without a reorder handler", () => {
    const [a] = createReferenceProject({ trackCount: 1, placementCount: 1 }).song.tracks;
    render(() => (
      <TrackRail
        tracks={[a]}
        selectedTrackId={null}
        onSelect={() => {}}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));
    expect(document.querySelector("[data-track-drag]")).toBeNull();
  });

  it("keeps a row's fader through a drag, so the drag keeps moving it", () => {
    const history = new CommandHistory(createSliceFixtureProject());
    const [project, setProject] = createSignal(history.project);
    render(() => (
      <TrackRail
        tracks={project().song.tracks}
        selectedTrackId={null}
        onSelect={() => {}}
        dispatch={(commands) => {
          const result = history.execute(commands);
          setProject(history.project);
          return result;
        }}
        beginGesture={() => undefined}
      />
    ));
    const track = history.project.song.tracks[0];
    const fader = () => screen.getByRole("slider", { name: `Volume for ${track.name}` });
    const grabbed = fader();

    for (const value of ["0.6", "0.5", "0.4"]) {
      fireEvent.input(grabbed, { target: { value } });
      flush();
      expect(fader()).toBe(grabbed);
    }
    expect(history.project.song.tracks[0].mixer.volume).toBeLessThan(track.mixer.volume);
  });
});

describe("TrackRail delete (#537)", () => {
  it("hands the pressed row's track to onDelete", () => {
    const [a, b] = createReferenceProject({ trackCount: 2, placementCount: 2 }).song
      .tracks;
    const onDelete = vi.fn<(trackId: TrackId) => void>();
    render(() => (
      <TrackRail
        tracks={[a, b]}
        selectedTrackId={null}
        onSelect={() => {}}
        onDelete={onDelete}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: `Delete ${b.name}` }));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(b.id);
  });
});

describe("TrackRail semantics (#76)", () => {
  it("lists only the tracks; the add-track buttons follow the list", () => {
    const tracks = createReferenceProject({ trackCount: 3, placementCount: 3 }).song
      .tracks;
    render(() => (
      <TrackRail
        tracks={tracks}
        selectedTrackId={null}
        onSelect={() => {}}
        onAddTrack={() => {}}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));
    const list = screen.getByRole("list", { name: "Tracks" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    // Every child of the list is a list item: nothing with its role removed.
    expect([...list.children].every((child) => child.tagName === "LI")).toBe(true);
    const addSynth = screen.getByRole("button", { name: "Add synth track" });
    expect(list.contains(addSynth)).toBe(false);
  });
});
