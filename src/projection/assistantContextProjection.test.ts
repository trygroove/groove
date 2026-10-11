import { describe, expect, it } from "vitest";
import {
  createDenseStepFixtureProject,
  createReferenceProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import { addToSelection, emptySelection, selectOnly } from "../selection/selection";
import { buildAssistantContext, summarizeSelection } from "./assistantContextProjection";

describe("buildAssistantContext", () => {
  it("summarizes tracks, sections, and tempo compactly", () => {
    const project = createSliceFixtureProject();
    const context = buildAssistantContext(project);

    expect(context.projectId).toBe(project.metadata.id);
    expect(context.tempo).toBe(project.song.tempo);
    expect(context.tracks).toHaveLength(1);
    expect(context.tracks[0].name).toBe(project.song.tracks[0].name);
    expect(context.tracks[0].clipCount).toBe(1);
    expect(context.tracks[0].placementCount).toBe(1);
    expect(context.selection).toBeNull();
  });

  it("never includes full per-note event data", () => {
    const project = createSliceFixtureProject();
    const context = buildAssistantContext(project);
    const serialized = JSON.stringify(context);
    // The fixture's note events use pitch 36; assert the context is compact
    // enough that it does not embed a full per-event array (only counts).
    expect(context.tracks[0]).not.toHaveProperty("clips");
    expect(serialized.length).toBeLessThan(2000);
  });

  it("does not mutate the source project", () => {
    const project = createSliceFixtureProject();
    const before = JSON.parse(JSON.stringify(project));
    buildAssistantContext(project);
    expect(JSON.parse(JSON.stringify(project))).toEqual(before);
  });

  describe("selection summary", () => {
    it("is null for an empty selection", () => {
      const project = createSliceFixtureProject();
      const context = buildAssistantContext(project, emptySelection());
      expect(context.selection).toBeNull();
    });

    it("describes a single-track selection in words, not raw scopes", () => {
      const project = createSliceFixtureProject();
      const selection = selectOnly({
        kind: "track",
        id: project.song.tracks[0].id,
      });
      const context = buildAssistantContext(project, selection);
      expect(context.selection?.description).toBe("1 track selected");
      expect(context.selection?.countByKind).toEqual({ track: 1 });
    });

    it("describes a mixed multi-selection", () => {
      const project = createSliceFixtureProject();
      let selection = selectOnly({
        kind: "track",
        id: project.song.tracks[0].id,
      });
      selection = addToSelection(selection, {
        kind: "placement",
        id: project.song.placements[0].id,
      });
      selection = addToSelection(selection, {
        kind: "clip",
        id: project.clips[0].id,
      });

      const summary = summarizeSelection(selection);
      expect(summary?.countByKind).toEqual({ track: 1, placement: 1, clip: 1 });
      expect(summary?.description).toContain("1 track");
      expect(summary?.description).toContain("1 clip");
      expect(summary?.description).toContain("1 placement");
    });

    it("pluralizes counts greater than one", () => {
      const project = createReferenceProject({
        trackCount: 4,
        placementCount: 8,
      });
      let selection = selectOnly({
        kind: "track",
        id: project.song.tracks[0].id,
      });
      selection = addToSelection(selection, {
        kind: "track",
        id: project.song.tracks[1].id,
      });
      const summary = summarizeSelection(selection);
      expect(summary?.description).toBe("2 tracks selected");
    });
  });

  describe("empty state", () => {
    it("summarizes a project with no tracks or sections", () => {
      const project = createSliceFixtureProject();
      const emptied = {
        ...project,
        song: { ...project.song, tracks: [], placements: [], sections: [] },
        clips: [],
      };
      const context = buildAssistantContext(emptied);
      expect(context.tracks).toEqual([]);
      expect(context.sections).toEqual([]);
      expect(context.totalTicks).toBe(0);
    });
  });

  describe("large fixtures", () => {
    it("summarizes the 50-track reference project", () => {
      const project = createReferenceProject();
      const context = buildAssistantContext(project);
      expect(context.tracks).toHaveLength(50);
      expect(context.sections).toHaveLength(4);
    });
  });
});

describe("buildAssistantContext: selected notes (ADR 0007)", () => {
  it("carries no note events when nothing is selected", () => {
    const project = createSliceFixtureProject();
    expect(buildAssistantContext(project).selectedNotes).toBeNull();
    expect(buildAssistantContext(project, emptySelection()).selectedNotes).toBeNull();
  });

  it("carries the selected track's notes, and only that track's", () => {
    const project = createReferenceProject();
    const [first, second] = project.song.tracks;
    const context = buildAssistantContext(
      project,
      selectOnly({ kind: "track", id: first.id }),
    );
    const trackIds = new Set(context.selectedNotes?.clips.map((clip) => clip.trackId));
    expect([...trackIds]).toEqual([first.id]);
    const serialized = JSON.stringify(context.selectedNotes);
    for (const clip of project.clips.filter((c) => c.trackId === second.id)) {
      if (clip.content.kind !== "notes") continue;
      for (const event of clip.content.events) expect(serialized).not.toContain(event.id);
    }
  });

  it("changes the fingerprint when the selected notes change", () => {
    const project = createReferenceProject();
    const [first, second] = project.song.tracks;
    const a = buildAssistantContext(project, selectOnly({ kind: "track", id: first.id }));
    const b = buildAssistantContext(
      project,
      selectOnly({ kind: "track", id: second.id }),
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("carries each track's fader and pan", () => {
    const project = createSliceFixtureProject();
    const [track] = buildAssistantContext(project).tracks;
    expect(track.volume).toBe(project.song.tracks[0].mixer.volume);
    expect(track.pan).toBe(project.song.tracks[0].mixer.pan);
  });

  it("lists a drum machine's pads by ID and name, and no pads for a sampler", () => {
    const kit = createDenseStepFixtureProject();
    const drums = kit.song.tracks[0];
    const pads = drums.instrument?.kind === "drumMachine" ? drums.instrument.pads : [];
    expect(buildAssistantContext(kit).tracks[0].pads).toEqual(
      pads.map((pad) => ({ id: pad.id, name: pad.name })),
    );
    expect(buildAssistantContext(kit).tracks[0].pads.map((pad) => pad.name)).toEqual([
      "BD",
      "SD",
      "HH",
    ]);
    expect(buildAssistantContext(createSliceFixtureProject()).tracks[0].pads).toEqual([]);
  });

  it("lists each track's placements by start, with no other track's", () => {
    const project = createReferenceProject();
    const context = buildAssistantContext(project);
    for (const track of context.tracks) {
      const own = project.song.placements.filter(
        (placement) => placement.trackId === track.id,
      );
      expect(track.placements).toHaveLength(own.length);
      expect(track.placements.map((placement) => placement.id).sort()).toEqual(
        own.map((placement) => placement.id).sort(),
      );
      const starts = track.placements.map((placement) => placement.startTicks);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      for (const summary of track.placements) {
        const placement = own.find((candidate) => candidate.id === summary.id);
        expect(summary).toEqual({
          id: placement?.id,
          clipId: placement?.clipId,
          startTicks: placement?.startTicks,
          durationTicks: placement?.durationTicks,
          looped: placement?.looped,
        });
      }
    }
    expect(context.tracks.some((track) => track.placements.length > 0)).toBe(true);
  });
});
