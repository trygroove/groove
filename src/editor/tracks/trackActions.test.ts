import { describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { CommandHistory } from "../../commands";
import { createReferenceProject } from "../../domain/fixtures";
import type { TrackId } from "../../domain/ids";
import { memoryStorage } from "../../testing/storage";
import {
  deleteTrack,
  dropSlot,
  moveTrack,
  neighbourTrackId,
  orderedTrackIds,
  previewOrder,
  previewTrackOrder,
  slotToIndex,
  type TrackReorderContext,
} from "./trackActions";

function setUp(options: { analyticsEnabled?: boolean } = {}) {
  const history = new CommandHistory(
    createReferenceProject({ trackCount: 3, placementCount: 6 }),
  );
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  if (options.analyticsEnabled === false) consent.set({ productAnalytics: false });
  const analytics = new Analytics({ transport, consent, storage: memoryStorage() });
  const context: TrackReorderContext = {
    project: () => history.project,
    dispatch: (commands) => history.execute(commands),
    analytics,
  };
  return { history, transport, context };
}

const DRAG = { view: "arrangement", method: "drag" } as const;

describe("moveTrack (TRK-02)", () => {
  it("moves a track through one track.reorder: one revision, one undoable entry", () => {
    const { history, context } = setUp();
    const [a, b, c] = orderedTrackIds(history.project);
    const revision = history.project.metadata.revision;

    expect(moveTrack(context, c, 0, DRAG)).toBe(true);

    expect(orderedTrackIds(history.project)).toEqual([c, a, b]);
    expect(history.project.metadata.revision).toBe(revision + 1);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.commands.map((command) => command.type)).toEqual([
      "track.reorder",
    ]);
    history.undo();
    expect(orderedTrackIds(history.project)).toEqual([a, b, c]);
  });

  it("carries the track's clips, instrument, devices and mixer with it", () => {
    const { history, context } = setUp();
    const [, , c] = orderedTrackIds(history.project);
    const before = history.project.song.tracks.find((t) => t.id === c);
    const clipsBefore = history.project.clips.filter((clip) => clip.trackId === c);

    moveTrack(context, c, 0, DRAG);

    const after = history.project.song.tracks.find((t) => t.id === c);
    expect({ ...after, order: 0 }).toEqual({ ...before, order: 0 });
    expect(history.project.clips.filter((clip) => clip.trackId === c)).toEqual(
      clipsBefore,
    );
  });

  it("logs track_reordered once per move, naming only the view and method", () => {
    const { history, transport, context } = setUp();
    const [a] = orderedTrackIds(history.project);

    moveTrack(context, a, 2, { view: "mixer", method: "button" });

    const events = transport.named("track_reordered");
    expect(events).toHaveLength(1);
    expect(events[0]?.params).toMatchObject({ view: "mixer", method: "button" });
    expect(Object.values(events[0]?.params ?? {})).not.toContain(a);
  });

  it("does nothing for a move that leaves the track in place, or goes nowhere", () => {
    const { history, transport, context } = setUp();
    const [a] = orderedTrackIds(history.project);

    expect(moveTrack(context, a, 0, DRAG)).toBe(false);
    expect(moveTrack(context, a, 3, DRAG)).toBe(false);
    expect(moveTrack(context, a, -1, DRAG)).toBe(false);

    expect(history.entries).toHaveLength(0);
    expect(transport.named("track_reordered")).toHaveLength(0);
  });

  it("reorders identically with analytics disabled", () => {
    const { history, transport, context } = setUp({ analyticsEnabled: false });
    const [a, b, c] = orderedTrackIds(history.project);

    expect(moveTrack(context, a, 2, DRAG)).toBe(true);

    expect(orderedTrackIds(history.project)).toEqual([b, c, a]);
    expect(transport.named("track_reordered")).toHaveLength(0);
  });
});

describe("drop geometry", () => {
  const midpoints = [10, 30, 50];

  it("puts the pointer in the gap before the first item whose middle it has not passed", () => {
    expect(dropSlot(0, midpoints)).toBe(0);
    expect(dropSlot(12, midpoints)).toBe(1);
    expect(dropSlot(49, midpoints)).toBe(2);
    expect(dropSlot(90, midpoints)).toBe(3);
  });

  it("maps a slot to the index the dragged item ends up at", () => {
    // Dragging item 2 to the top, and item 0 to the end.
    expect(slotToIndex(2, 0)).toBe(0);
    expect(slotToIndex(0, 3)).toBe(2);
    // Either gap next to the dragged item leaves it where it is.
    expect(slotToIndex(1, 1)).toBe(1);
    expect(slotToIndex(1, 2)).toBe(1);
  });
});

describe("previewTrackOrder (TRK-02)", () => {
  it("reads as if the track had moved, without touching the project", () => {
    const project = createReferenceProject({ trackCount: 3, placementCount: 3 });
    const [a, b, c] = orderedTrackIds(project);

    const preview = previewTrackOrder(project, c, 0);

    expect(orderedTrackIds(preview)).toEqual([c, a, b]);
    expect(orderedTrackIds(project)).toEqual([a, b, c]);
  });
});

describe("previewOrder (#447)", () => {
  it("draws the moving item where it would land, and nothing else moves", () => {
    const items = ["a", "b", "c", "d"];
    expect(previewOrder(items, (item) => item === "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(previewOrder(items, (item) => item === "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(previewOrder(items, (item) => item === "b", 1)).toEqual(items);
  });

  it("leaves the order alone with no target, or nothing moving", () => {
    const items = ["a", "b"];
    expect(previewOrder(items, (item) => item === "a", null)).toBe(items);
    expect(previewOrder(items, () => false, 1)).toBe(items);
  });
});

function setUpDeletion(options: { analyticsEnabled?: boolean } = {}) {
  const history = new CommandHistory(
    createReferenceProject({ trackCount: 3, placementCount: 6 }),
  );
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  if (options.analyticsEnabled === false) consent.set({ productAnalytics: false });
  const analytics = new Analytics({ transport, consent, storage: memoryStorage() });
  const select = vi.fn<(id: TrackId) => void>();
  const context = {
    project: () => history.project,
    dispatch: (commands: Parameters<CommandHistory["execute"]>[0]) =>
      history.execute(commands),
    select,
    analytics,
  };
  return { history, transport, select, context };
}

describe("deleteTrack (#537)", () => {
  it("deletes through one track.delete: one revision, one undo that restores it", () => {
    const { history, context } = setUpDeletion();
    const [a, b, c] = orderedTrackIds(history.project);
    const revision = history.project.metadata.revision;

    expect(deleteTrack(context, b)).toBe(true);

    expect(orderedTrackIds(history.project)).toEqual([a, c]);
    expect(history.project.metadata.revision).toBe(revision + 1);
    history.undo();
    expect(orderedTrackIds(history.project)).toEqual([a, b, c]);
    expect(history.project.song.placements.some((p) => p.trackId === b)).toBe(true);
  });

  it("selects the next track, else the previous, else nothing", () => {
    const { history, context, select } = setUpDeletion();
    const [a, b, c] = orderedTrackIds(history.project);
    expect(neighbourTrackId(history.project, b)).toBe(c);
    expect(neighbourTrackId(history.project, c)).toBe(b);

    deleteTrack(context, a);
    expect(select).toHaveBeenLastCalledWith(b);
    deleteTrack(context, c);
    expect(select).toHaveBeenLastCalledWith(b);
    select.mockClear();
    deleteTrack(context, b);
    expect(select).not.toHaveBeenCalled();
    expect(history.project.song.tracks).toHaveLength(0);
  });

  it("does nothing for an unknown track", () => {
    const { history, context, select, transport } = setUpDeletion();
    const revision = history.project.metadata.revision;
    expect(deleteTrack(context, "trk_missing" as TrackId)).toBe(false);
    expect(history.project.metadata.revision).toBe(revision);
    expect(select).not.toHaveBeenCalled();
    expect(transport.named("feature_first_use")).toHaveLength(0);
  });

  it("logs feature_first_use once across deletions, and nothing when analytics is off", () => {
    const on = setUpDeletion();
    const ids = orderedTrackIds(on.history.project);
    deleteTrack(on.context, ids[0]);
    deleteTrack(on.context, ids[1]);
    const events = on.transport.named("feature_first_use");
    expect(events).toHaveLength(1);
    expect(events[0].params).toMatchObject({ feature: "track_delete" });

    const off = setUpDeletion({ analyticsEnabled: false });
    deleteTrack(off.context, orderedTrackIds(off.history.project)[0]);
    expect(off.transport.named("feature_first_use")).toHaveLength(0);
    expect(off.history.project.song.tracks).toHaveLength(2);
  });
});
