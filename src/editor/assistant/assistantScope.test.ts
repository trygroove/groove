import { describe, expect, it } from "vitest";
import { createSliceFixtureProject } from "../../domain/fixtures";
import type { EventId, PlacementId } from "../../domain/ids";
import {
  availableLevels,
  resolveScope,
  type ScopeSources,
  scopedContext,
  selectionKey,
  widen,
} from "./assistantScope";

const project = createSliceFixtureProject();
const track = project.song.tracks[0] ?? null;
const clip = project.clips[0];
const eventIds = (
  clip?.content.kind === "notes" ? clip.content.events.map((event) => event.id) : []
) as EventId[];
const placementIds = project.song.placements.map((p) => p.id) as PlacementId[];

const notes: ScopeSources = { selection: { kind: "notes", eventIds }, track };
const clips: ScopeSources = { selection: { kind: "clips", placementIds }, track };
const trackOnly: ScopeSources = { selection: null, track };
const nothing: ScopeSources = { selection: null, track: null };

describe("the assistant's scope", () => {
  it("starts at the selection, else the track, else the song", () => {
    expect(resolveScope(notes, null)).toMatchObject({
      level: "selection",
      catalogScope: "clip",
      label: "4 notes",
    });
    expect(resolveScope(clips, null)).toMatchObject({
      catalogScope: "section",
      label: "1 clip",
    });
    expect(resolveScope(trackOnly, null)).toMatchObject({
      catalogScope: "track",
      label: "BD",
    });
    expect(resolveScope(nothing, null)).toMatchObject({
      catalogScope: "song",
      label: "Whole song",
    });
  });

  it("widens one step a click, and comes back round", () => {
    expect(availableLevels(notes)).toEqual(["selection", "track", "song"]);
    expect(widen("selection", notes)).toBe("track");
    expect(widen("track", notes)).toBe("song");
    expect(widen("song", notes)).toBe("selection");
    expect(widen("track", trackOnly)).toBe("song");
    expect(widen("song", trackOnly)).toBe("track");
    expect(widen("song", nothing)).toBe("song");
  });

  it("falls back to the narrowest open level when the chosen one is gone", () => {
    expect(resolveScope(trackOnly, "selection").level).toBe("track");
  });

  it("keys the selection, whatever order it was made in", () => {
    const reversed: ScopeSources = {
      selection: { kind: "notes", eventIds: [...eventIds].reverse() },
      track,
    };
    expect(selectionKey(reversed)).toBe(selectionKey(notes));
    expect(selectionKey(clips)).not.toBe(selectionKey(notes));
  });

  it("sends raw notes for the selection or the track in scope, never the song (ADR 0007)", () => {
    const selected = scopedContext(project, resolveScope(notes, null));
    expect(selected.selectedNotes?.noteCount).toBe(4);
    const clipped = scopedContext(project, resolveScope(clips, null));
    expect(clipped.selectedNotes?.noteCount).toBe(4);
    // GRV-122: the track in scope is what the producer is pointing at, so its
    // notes go, every clip on it.
    const onTrack = scopedContext(project, resolveScope(notes, "track"));
    expect(onTrack.selectedNotes?.noteCount).toBe(4);
    expect(onTrack.selectedNotes?.clips.map((c) => c.trackId)).toEqual([track?.id]);
    expect(onTrack.selection).toEqual({
      description: `In scope: the track "BD" (${track?.id})`,
      countByKind: { track: 1 },
    });
    const song = scopedContext(project, resolveScope(notes, "song"));
    expect(song.selection).toBeNull();
    expect(song.selectedNotes).toBeNull();
  });
});
