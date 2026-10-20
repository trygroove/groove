/**
 * Projection freshness (GRV-80). The two change-detection mechanisms
 * (`revision.ts`, `fingerprint.ts`) share one failure: a dependency list that
 * misses an input, so an edit leaves a stale entry behind. These tests change
 * one field at a time and assert each projection reflects it and that no
 * stale entry is reused (GRV-133 was this bug in the arrangement's preview).
 */

import { describe, expect, it } from "vitest";
import type { RowMetrics } from "../arrangement/geometry";
import { buildArrangementProjection } from "../arrangement/projection";
import type { Clip, Placement, Project, Track } from "../domain/entities";
import { createFactoryContext, createTrack } from "../domain/factories";
import { createPianoRollFixtureProject } from "../domain/fixtures";
import { createSeededIdFactory } from "../domain/ids";
import { toTicks } from "../domain/time";
import { selectOnly } from "../selection/selection";
import { buildAssistantContext } from "./assistantContextProjection";
import { buildAudioProjection } from "./audioProjection";

const rowMetrics: RowMetrics = { trackHeightPx: 32, headerHeightPx: 32 };

/** Immutable edits with the command layer's structural sharing. */
function withTrack(project: Project, edit: (track: Track) => Track): Project {
  const [first, ...rest] = project.song.tracks;
  return { ...project, song: { ...project.song, tracks: [edit(first), ...rest] } };
}

function withPlacement(project: Project, edit: (p: Placement) => Placement): Project {
  const [first, ...rest] = project.song.placements;
  return {
    ...project,
    song: { ...project.song, placements: [edit(first), ...rest] },
  };
}

function withClip(project: Project, edit: (c: Clip) => Clip): Project {
  const [first, ...rest] = project.clips;
  return { ...project, clips: [edit(first), ...rest] };
}

/** The fixture plus a second, empty track for a placement to move onto. */
function twoTrackProject(): { project: Project; otherTrackId: Track["id"] } {
  const base = createPianoRollFixtureProject();
  const other = createTrack(
    createFactoryContext({ ids: createSeededIdFactory("fresh") }),
    {
      name: "Other",
      order: 1,
    },
  );
  return {
    project: { ...base, song: { ...base.song, tracks: [...base.song.tracks, other] } },
    otherTrackId: other.id,
  };
}

function notesOf(project: Project) {
  const clip = project.clips[0];
  if (clip.content.kind !== "notes") throw new Error("expected notes");
  return clip.content.events;
}

describe("arrangement projection freshness", () => {
  const before = createPianoRollFixtureProject();
  const placementId = before.song.placements[0].id;
  const build = (project: Project) => buildArrangementProjection(project, rowMetrics);
  const placementOf = (project: Project) => {
    const geometry = build(project).placementsById.get(placementId);
    if (!geometry) throw new Error("placement missing");
    return geometry;
  };

  it("reflects a track rename and moves the track's revision", () => {
    const after = withTrack(before, (t) => ({ ...t, name: "Renamed" }));
    const a = build(before).tracks[0];
    const b = build(after).tracks[0];
    expect(b.name).toBe("Renamed");
    expect(b.revision).not.toBe(a.revision);
    expect(placementOf(after).revision).not.toBe(placementOf(before).revision);
  });

  it("reflects a track recolour on its placements", () => {
    const after = withTrack(before, (t) => ({ ...t, color: "#123456" }));
    expect(build(after).tracks[0].color).toBe("#123456");
    expect(placementOf(after).color).toBe("#123456");
    expect(placementOf(after).revision).not.toBe(placementOf(before).revision);
  });

  it("reflects a clip rename on its placement's label", () => {
    const after = withClip(before, (c) => ({ ...c, name: "Renamed clip" }));
    expect(placementOf(after).label).toBe("Renamed clip");
    expect(placementOf(after).revision).not.toBe(placementOf(before).revision);
  });

  it("reflects the track a placement is on", () => {
    const { project, otherTrackId } = twoTrackProject();
    const after = withPlacement(project, (p) => ({ ...p, trackId: otherTrackId }));
    const projection = build(after);
    const geometry = projection.placementsById.get(placementId);
    expect(geometry?.trackId).toBe(otherTrackId);
    expect(geometry?.rowIndex).toBe(1);
    expect(projection.placementsByTrack.get(otherTrackId)?.items).toHaveLength(1);
    expect(projection.placementsByTrack.get(project.song.tracks[0].id)).toBeUndefined();
  });

  it("reflects a looped flag in the preview's notes", () => {
    const short = withPlacement(before, (p) => ({
      ...p,
      looped: false,
      durationTicks: toTicks(before.clips[0].lengthTicks * 2),
    }));
    const looped = withPlacement(short, (p) => ({ ...p, looped: true }));
    const count = (project: Project) => {
      const { preview } = placementOf(project);
      if (preview.kind !== "notes") throw new Error("expected notes");
      return preview.notes.length;
    };
    expect(placementOf(looped).revision).not.toBe(placementOf(short).revision);
    expect(count(looped)).toBeGreaterThan(count(short));
  });

  it("reflects an edited note in the preview", () => {
    const after = withClip(before, (clip) => {
      if (clip.content.kind !== "notes") throw new Error("expected notes");
      const [first, ...rest] = clip.content.events;
      return {
        ...clip,
        content: {
          ...clip.content,
          events: [{ ...first, startTicks: toTicks(first.startTicks + 48) }, ...rest],
        },
      };
    });
    const starts = (project: Project) => {
      const { preview } = placementOf(project);
      if (preview.kind !== "notes") throw new Error("expected notes");
      return preview.notes.map((note) => note.startTicks);
    };
    expect(starts(after)).not.toEqual(starts(before));
    expect(placementOf(after).revision).not.toBe(placementOf(before).revision);
  });

  it("keeps an untouched placement's revision when a sibling track changes", () => {
    const { project } = twoTrackProject();
    const after = {
      ...project,
      song: {
        ...project.song,
        tracks: [
          project.song.tracks[0],
          { ...project.song.tracks[1], name: "Other, renamed" },
        ],
      },
    };
    expect(placementOf(after).revision).toBe(placementOf(project).revision);
  });
});

describe("audio projection freshness", () => {
  const before = createPianoRollFixtureProject();
  const previous = buildAudioProjection(before);
  const trackId = before.song.tracks[0].id;
  const placementId = before.song.placements[0].id;
  const placementIn = (projection: ReturnType<typeof buildAudioProjection>) =>
    projection.placements.find((placement) => placement.id === placementId);

  it("returns the same objects for an unchanged project", () => {
    const again = buildAudioProjection(before, previous);
    expect(again.tracksById.get(trackId)).toBe(previous.tracksById.get(trackId));
    expect(placementIn(again)).toBe(placementIn(previous));
  });

  it("reflects an instrument parameter without changing the topology", () => {
    const after = withTrack(before, (t) => ({
      ...t,
      instrument: t.instrument && { ...t.instrument, parameters: { cutoff: 0.25 } },
    }));
    const next = buildAudioProjection(after, previous);
    const a = previous.tracksById.get(trackId);
    const b = next.tracksById.get(trackId);
    expect(b).not.toBe(a);
    expect(b?.instrument).toEqual(after.song.tracks[0].instrument);
    expect(b?.fingerprint).not.toBe(a?.fingerprint);
    expect(b?.topologyFingerprint).toBe(a?.topologyFingerprint);
  });

  it("reflects a mixer value in the track entry", () => {
    const after = withTrack(before, (t) => ({
      ...t,
      mixer: { ...t.mixer, muted: !t.mixer.muted },
    }));
    const b = buildAudioProjection(after, previous).tracksById.get(trackId);
    expect(b?.mixer.muted).toBe(after.song.tracks[0].mixer.muted);
    expect(b).not.toBe(previous.tracksById.get(trackId));
  });

  it("reflects a looped flag and drops the stale placement", () => {
    const after = withPlacement(before, (p) => ({ ...p, looped: !p.looped }));
    const b = placementIn(buildAudioProjection(after, previous));
    expect(b?.looped).toBe(after.song.placements[0].looped);
    expect(b).not.toBe(placementIn(previous));
  });

  it("reflects the track a placement is on", () => {
    const { project, otherTrackId } = twoTrackProject();
    const base = buildAudioProjection(project);
    const after = withPlacement(project, (p) => ({ ...p, trackId: otherTrackId }));
    const b = placementIn(buildAudioProjection(after, base));
    expect(b?.trackId).toBe(otherTrackId);
    expect(b).not.toBe(placementIn(base));
  });

  it("reflects an edited note in the clip and drops the stale clip", () => {
    const clipId = before.clips[0].id;
    const after = withClip(before, (clip) => {
      if (clip.content.kind !== "notes") throw new Error("expected notes");
      const [first, ...rest] = clip.content.events;
      return {
        ...clip,
        content: { ...clip.content, events: [{ ...first, pitch: 61 }, ...rest] },
      };
    });
    const b = buildAudioProjection(after, previous).clipsById.get(clipId);
    expect(b?.content).toEqual(after.clips[0].content);
    expect(b).not.toBe(previous.clipsById.get(clipId));
  });
});

describe("assistant context freshness", () => {
  const before = createPianoRollFixtureProject();
  const fingerprint = (project: Project, selection?: ReturnType<typeof selectOnly>) =>
    buildAssistantContext(project, selection).fingerprint;
  const base = fingerprint(before);

  it("is stable for an unchanged project", () => {
    expect(fingerprint(createPianoRollFixtureProject())).toBe(base);
  });

  it("changes with a track rename", () => {
    const after = withTrack(before, (t) => ({ ...t, name: "Renamed" }));
    expect(buildAssistantContext(after).tracks[0].name).toBe("Renamed");
    expect(fingerprint(after)).not.toBe(base);
  });

  it("changes with a looped flag", () => {
    const after = withPlacement(before, (p) => ({ ...p, looped: !p.looped }));
    expect(buildAssistantContext(after).tracks[0].placements[0].looped).toBe(
      after.song.placements[0].looped,
    );
    expect(fingerprint(after)).not.toBe(base);
  });

  it("changes with the track a placement is on", () => {
    const { project, otherTrackId } = twoTrackProject();
    const baseTwo = fingerprint(project);
    const after = withPlacement(project, (p) => ({ ...p, trackId: otherTrackId }));
    const context = buildAssistantContext(after);
    expect(context.tracks[1].placementCount).toBe(1);
    expect(context.fingerprint).not.toBe(baseTwo);
  });

  it("changes with a selected note's content, and only when it is selected", () => {
    const eventId = notesOf(before)[0].id;
    const selection = selectOnly({ kind: "event", id: eventId });
    const after = withClip(before, (clip) => {
      if (clip.content.kind !== "notes") throw new Error("expected notes");
      const [first, ...rest] = clip.content.events;
      return {
        ...clip,
        content: { ...clip.content, events: [{ ...first, velocity: 0.1 }, ...rest] },
      };
    });
    const context = buildAssistantContext(after, selection);
    expect(context.selectedNotes?.clips[0].events[0].velocity).toBe(0.1);
    expect(context.fingerprint).not.toBe(fingerprint(before, selection));
    // Unselected notes are not part of the context, so they are not in the hash.
    expect(fingerprint(after)).toBe(base);
  });
});
