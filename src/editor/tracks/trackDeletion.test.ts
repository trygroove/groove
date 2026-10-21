import { describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { CommandHistory } from "../../commands";
import { createReferenceProject } from "../../domain/fixtures";
import type { TrackId } from "../../domain/ids";
import { memoryStorage } from "../../testing/storage";
import { deleteTrack, neighbourTrackId } from "./trackDeletion";
import { orderedTrackIds } from "./trackReorder";

function setUp(options: { analyticsEnabled?: boolean } = {}) {
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
    const { history, context } = setUp();
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
    const { history, context, select } = setUp();
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
    const { history, context, select, transport } = setUp();
    const revision = history.project.metadata.revision;
    expect(deleteTrack(context, "trk_missing" as TrackId)).toBe(false);
    expect(history.project.metadata.revision).toBe(revision);
    expect(select).not.toHaveBeenCalled();
    expect(transport.named("feature_first_use")).toHaveLength(0);
  });

  it("logs feature_first_use once across deletions, and nothing when analytics is off", () => {
    const on = setUp();
    const ids = orderedTrackIds(on.history.project);
    deleteTrack(on.context, ids[0]);
    deleteTrack(on.context, ids[1]);
    const events = on.transport.named("feature_first_use");
    expect(events).toHaveLength(1);
    expect(events[0].params).toMatchObject({ feature: "track_delete" });

    const off = setUp({ analyticsEnabled: false });
    deleteTrack(off.context, orderedTrackIds(off.history.project)[0]);
    expect(off.transport.named("feature_first_use")).toHaveLength(0);
    expect(off.history.project.song.tracks).toHaveLength(2);
  });
});
