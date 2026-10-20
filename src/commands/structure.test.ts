import { beforeEach, describe, expect, it } from "vitest";
import {
  bars,
  createNoteClip,
  createPlacement,
  createSamplerInstrument,
  createTrack as createTrackEntity,
  MAX_CLIP_LENGTH_BARS,
  type Project,
  TICKS_PER_BAR,
  toTicks,
} from "../domain";
import {
  addClip,
  addPlacement,
  addTrack,
  removeClip,
  removePlacement,
  removeTrack,
  reorderTrack,
  setTrackFlag,
  updateClip,
  updatePlacement,
  updateTrack,
} from ".";
import { executeCommand } from "./execute";
import { findClip, findPlacement, findTrack } from "./projectEdits";
import {
  ABSENT_IDS,
  type CommandTestProject,
  createCommandTestProject,
  createTestFactoryContext,
} from "./testProjects";

function apply(project: Project, command: Parameters<typeof executeCommand>[1]): Project {
  const result = executeCommand(project, command);
  if (!result.ok) {
    throw new Error(`Expected success: ${result.issues[0].message}`);
  }
  return result.project;
}

function trackNames(project: Project): string[] {
  return [...project.song.tracks]
    .sort((a, b) => a.order - b.order)
    .map((track) => track.name);
}

describe("structural commands", () => {
  let fixture: CommandTestProject;
  let context: ReturnType<typeof createTestFactoryContext>;

  beforeEach(() => {
    fixture = createCommandTestProject();
    context = createTestFactoryContext("structure");
  });

  describe("track.create", () => {
    it("appends a track and keeps orders contiguous", () => {
      const track = createTrackEntity(context, {
        name: "Lead",
        order: 2,
        instrument: createSamplerInstrument(null),
      });
      const next = apply(fixture.project, addTrack(track));
      expect(trackNames(next)).toEqual(["Bass", "Drums", "Lead"]);
    });

    it("inserts in the middle and pushes later tracks down", () => {
      const track = createTrackEntity(context, { name: "Lead", order: 0 });
      const next = apply(fixture.project, addTrack(track));
      expect(trackNames(next)).toEqual(["Lead", "Bass", "Drums"]);
      expect(next.song.tracks.map((entry) => entry.order).sort()).toEqual([0, 1, 2]);
    });

    it("labels a new track with its starter clip and placement as an add", () => {
      const track = createTrackEntity(context, { name: "Synth", order: 2 });
      const clip = createNoteClip(context, { trackId: track.id, name: "Starter" });
      const placement = createPlacement(context, {
        clipId: clip.id,
        trackId: track.id,
        startTicks: 0,
        durationTicks: bars(1),
      });
      const result = executeCommand(
        fixture.project,
        addTrack(track, { clips: [clip], placements: [placement] }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.summary).toBe('Add track "Synth"');
    });

    it("rejects a position beyond the end of the track list", () => {
      const track = createTrackEntity(context, { name: "Lead", order: 9 });
      const result = executeCommand(fixture.project, addTrack(track));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].message).toMatch(/Cannot insert a track/);
    });

    it("rejects a track ID that already exists", () => {
      const existing = fixture.project.song.tracks[0];
      const result = executeCommand(fixture.project, addTrack({ ...existing, order: 2 }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].message).toMatch(/already exists/);
    });
  });

  describe("track.delete", () => {
    it("removes the track and everything that cannot outlive it", () => {
      const next = apply(fixture.project, removeTrack(fixture.trackAId));

      expect(findTrack(next, fixture.trackAId)).toBeUndefined();
      expect(findClip(next, fixture.clipAId)).toBeUndefined();
      expect(findPlacement(next, fixture.placementAId)).toBeUndefined();
      expect(next.song.automation).toHaveLength(0);
      // The surviving track is renumbered from 1 to 0.
      expect(next.song.tracks.map((track) => track.order)).toEqual([0]);
      expect(findClip(next, fixture.clipBId)).toBeDefined();
    });

    it("rejects a track that is not there", () => {
      const result = executeCommand(fixture.project, removeTrack(ABSENT_IDS.track));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].code).toBe("rejected");
    });
  });

  describe("track.update, reorder, and flags", () => {
    it("renames a track", () => {
      const next = apply(fixture.project, updateTrack(fixture.trackAId, { name: "Sub" }));
      expect(findTrack(next, fixture.trackAId)?.name).toBe("Sub");
    });

    it("moves a track and renumbers the rest", () => {
      const next = apply(fixture.project, reorderTrack(fixture.trackAId, 1));
      expect(trackNames(next)).toEqual(["Drums", "Bass"]);
    });

    it("rejects a position outside the track list", () => {
      const result = executeCommand(fixture.project, reorderTrack(fixture.trackAId, 5));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].message).toMatch(/Cannot move a track/);
    });

    it("mutes and solos a track", () => {
      const muted = apply(fixture.project, setTrackFlag(fixture.trackAId, "muted", true));
      expect(findTrack(muted, fixture.trackAId)?.mixer.muted).toBe(true);

      const soloed = apply(muted, setTrackFlag(fixture.trackAId, "soloed", true));
      expect(findTrack(soloed, fixture.trackAId)?.mixer.soloed).toBe(true);
      expect(findTrack(soloed, fixture.trackAId)?.mixer.muted).toBe(true);
    });
  });

  describe("clip commands", () => {
    it("adds a clip to a track", () => {
      const clip = createNoteClip(context, {
        trackId: fixture.trackAId,
        name: "Second",
      });
      const next = apply(fixture.project, addClip(clip));
      expect(findClip(next, clip.id)?.name).toBe("Second");
    });

    it("rejects a clip whose owning track is missing", () => {
      const clip = createNoteClip(context, {
        trackId: ABSENT_IDS.track,
        name: "Orphan",
      });
      const result = executeCommand(fixture.project, addClip(clip));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].code).toBe("invalid_project");
    });

    it("deletes a clip together with its placements", () => {
      const next = apply(fixture.project, removeClip(fixture.clipAId));
      expect(findClip(next, fixture.clipAId)).toBeUndefined();
      expect(findPlacement(next, fixture.placementAId)).toBeUndefined();
      expect(next.song.placements).toHaveLength(1);
    });

    it("renames a clip", () => {
      const next = apply(
        fixture.project,
        updateClip(fixture.clipAId, { name: "Groove" }),
      );
      expect(findClip(next, fixture.clipAId)?.name).toBe("Groove");
    });

    it("refuses to shrink a clip below its last note", () => {
      const result = executeCommand(
        fixture.project,
        updateClip(fixture.clipAId, { lengthTicks: toTicks(100) }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].code).toBe("invalid_project");
      expect(result.issues[0].domainIssues?.[0].code).toBe("invalid_musical_time");
    });

    it("resizes a clip up to the 32-bar maximum", () => {
      const next = apply(
        fixture.project,
        updateClip(fixture.clipAId, {
          lengthTicks: toTicks(TICKS_PER_BAR * MAX_CLIP_LENGTH_BARS),
        }),
      );
      expect(findClip(next, fixture.clipAId)?.lengthTicks).toBe(
        TICKS_PER_BAR * MAX_CLIP_LENGTH_BARS,
      );
    });

    it("refuses a clip longer than the 32-bar maximum (#256)", () => {
      const result = executeCommand(fixture.project, {
        type: "clip.update",
        payload: {
          clipId: fixture.clipAId,
          changes: { lengthTicks: TICKS_PER_BAR * (MAX_CLIP_LENGTH_BARS + 1) },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].code).toBe("invalid_payload");
    });
  });

  describe("placement commands", () => {
    it("places a clip in the arrangement", () => {
      const placement = createPlacement(context, {
        clipId: fixture.clipAId,
        trackId: fixture.trackAId,
        startTicks: bars(2),
        durationTicks: bars(1),
      });
      const next = apply(fixture.project, addPlacement(placement));
      expect(findPlacement(next, placement.id)?.startTicks).toBe(bars(2));
    });

    it("rejects a placement whose clip does not exist", () => {
      const placement = createPlacement(context, {
        clipId: ABSENT_IDS.clip,
        trackId: fixture.trackAId,
        startTicks: 0,
        durationTicks: bars(1),
      });
      const result = executeCommand(fixture.project, addPlacement(placement));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].domainIssues?.map((found) => found.code)).toContain(
        "dangling_reference",
      );
    });

    it("moves a placement along the timeline", () => {
      const next = apply(
        fixture.project,
        updatePlacement(fixture.placementAId, {
          startTicks: bars(4),
        }),
      );
      expect(findPlacement(next, fixture.placementAId)?.startTicks).toBe(
        TICKS_PER_BAR * 4,
      );
    });

    it("refuses to move a placement onto a track that does not own its clip", () => {
      const result = executeCommand(
        fixture.project,
        updatePlacement(fixture.placementAId, { trackId: fixture.trackBId }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].domainIssues?.map((found) => found.code)).toContain(
        "cross_owner_reference",
      );
    });

    it("removes a placement without touching its clip", () => {
      const next = apply(fixture.project, removePlacement(fixture.placementAId));
      expect(findPlacement(next, fixture.placementAId)).toBeUndefined();
      expect(findClip(next, fixture.clipAId)).toBeDefined();
    });
  });
});
