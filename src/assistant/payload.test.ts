import { describe, expect, it } from "vitest";
import {
  createDrumMachineFixtureProject,
  createReferenceProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import { selectOnly } from "../selection/selection";
import { buildAssistantPayload } from "./payload";
import {
  assistantContextPayloadSchema,
  assistantSelectedNotesSchema,
  MAX_CONTEXT_PLACEMENTS,
} from "./protocol";

describe("buildAssistantPayload", () => {
  it("is what the gateway's allowlist schema accepts", () => {
    for (const project of [
      createSliceFixtureProject(),
      createReferenceProject(),
      createDrumMachineFixtureProject(),
    ]) {
      const selection = selectOnly({ kind: "track", id: project.song.tracks[0].id });
      for (const payload of [
        buildAssistantPayload(project),
        buildAssistantPayload(project, selection),
      ]) {
        expect(assistantContextPayloadSchema.parse(payload)).toEqual(payload);
      }
    }
  });

  it("still accepts a track with no pads, as a tab on the earlier bundle sends", () => {
    const payload = buildAssistantPayload(createDrumMachineFixtureProject());
    const legacyTracks = payload.tracks.map(({ pads: _pads, ...track }) => track);
    const parsed = assistantContextPayloadSchema.parse({
      ...payload,
      tracks: legacyTracks,
    });
    expect(parsed.tracks.every((track) => track.pads.length === 0)).toBe(true);
  });

  it("still accepts a track with no placements, as a tab on an earlier bundle sends", () => {
    const payload = buildAssistantPayload(createReferenceProject());
    const legacyTracks = payload.tracks.map(
      ({ placements: _placements, ...track }) => track,
    );
    const parsed = assistantContextPayloadSchema.parse({
      ...payload,
      tracks: legacyTracks,
    });
    expect(parsed.tracks.every((track) => track.placements.length === 0)).toBe(true);
  });

  it("lists at most MAX_CONTEXT_PLACEMENTS of a track's placements, the earliest first", () => {
    const project = createReferenceProject({
      trackCount: 1,
      placementCount: 200,
      automationLaneCount: 0,
    });
    const [track] = buildAssistantPayload(project).tracks;
    expect(track.placementCount).toBe(
      project.song.placements.filter((placement) => placement.trackId === track.id)
        .length,
    );
    expect(track.placements).toHaveLength(MAX_CONTEXT_PLACEMENTS);
    const starts = track.placements.map((placement) => placement.startTicks);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(
      assistantContextPayloadSchema.safeParse(buildAssistantPayload(project)).success,
    ).toBe(true);
  });

  it("carries the song's current swing, so a swing change starts from it", () => {
    const project = createSliceFixtureProject();
    const swung = { ...project, song: { ...project.song, swing: 62 } };
    expect(buildAssistantPayload(swung).swing).toBe(62);
  });

  it("carries ADR 0007's allowlist and nothing else", () => {
    const payload = buildAssistantPayload(createReferenceProject());
    expect(Object.keys(payload).sort()).toEqual(
      [
        "noteStats",
        "projectName",
        "sections",
        "selectedNotes",
        "selection",
        "swing",
        "tempo",
        "timeSignature",
        "totalTicks",
        "tracks",
      ].sort(),
    );
  });

  it("never carries the project's ID, its owner, a clip's name, an asset or a URL", () => {
    const project = createDrumMachineFixtureProject();
    const selection = selectOnly({ kind: "track", id: project.song.tracks[0].id });
    const serialized = JSON.stringify(buildAssistantPayload(project, selection));
    expect(serialized).not.toContain(project.metadata.id);
    expect(serialized).not.toContain(project.metadata.ownerId);
    for (const clip of project.clips) expect(serialized).not.toContain(`"${clip.name}"`);
    for (const asset of project.song.assets) expect(serialized).not.toContain(asset.id);
    expect(serialized).not.toMatch(/https?:|gs:\/\//);
  });

  it("sends no note events at all when nothing is selected", () => {
    const project = createReferenceProject();
    const payload = buildAssistantPayload(project);
    expect(payload.selectedNotes).toBeNull();
    const serialized = JSON.stringify(payload);
    for (const clip of project.clips) {
      if (clip.content.kind !== "notes") continue;
      for (const event of clip.content.events) expect(serialized).not.toContain(event.id);
    }
  });

  it("sends the selected clip's notes and no other clip's", () => {
    const project = createReferenceProject();
    const noteClips = project.clips.filter(
      (clip) => clip.content.kind === "notes" && clip.content.events.length > 0,
    );
    const [chosen, ...others] = noteClips;
    const payload = buildAssistantPayload(
      project,
      selectOnly({ kind: "clip", id: chosen.id }),
    );
    const serialized = JSON.stringify(payload);
    expect(payload.selectedNotes?.clips.map((clip) => clip.clipId)).toEqual([chosen.id]);
    for (const clip of others) {
      if (clip.content.kind !== "notes") continue;
      for (const event of clip.content.events) expect(serialized).not.toContain(event.id);
    }
  });

  it("carries derived note statistics and each track's mixer state", () => {
    const project = createSliceFixtureProject();
    const payload = buildAssistantPayload(project);
    expect(payload.noteStats.song.noteCount).toBeGreaterThan(0);
    expect(payload.noteStats.tracks).toHaveLength(project.song.tracks.length);
    expect(payload.tracks[0]).toMatchObject({
      volume: project.song.tracks[0].mixer.volume,
      pan: project.song.tracks[0].mixer.pan,
    });
  });
});

describe("assistantSelectedNotesSchema", () => {
  const event = (i: number) => ({
    id: `evt_${i}`,
    trigger: { kind: "pitch" as const, pitch: 60 },
    startTicks: i,
    durationTicks: 1,
    velocity: 1,
    probability: null,
  });
  const clip = (id: string, from: number, count: number) => ({
    clipId: id,
    trackId: "trk_a",
    lengthTicks: 768,
    events: Array.from({ length: count }, (_, i) => event(from + i)),
  });

  it("accepts the cap's worth of notes spread over several clips", () => {
    const notes = {
      clips: [clip("clp_a", 0, 1_000), clip("clp_b", 1_000, 1_000)],
      noteCount: 2_000,
      omittedNoteCount: 5,
    };
    expect(assistantSelectedNotesSchema.safeParse(notes).success).toBe(true);
  });

  it("refuses more than the cap across clips, even when each clip is under it", () => {
    const notes = {
      clips: [clip("clp_a", 0, 1_500), clip("clp_b", 1_500, 1_500)],
      noteCount: 2_000,
      omittedNoteCount: 0,
    };
    expect(assistantSelectedNotesSchema.safeParse(notes).success).toBe(false);
  });

  it("refuses a noteCount that is not the number of notes sent", () => {
    const notes = { clips: [clip("clp_a", 0, 3)], noteCount: 2, omittedNoteCount: 0 };
    expect(assistantSelectedNotesSchema.safeParse(notes).success).toBe(false);
  });
});
