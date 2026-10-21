import { describe, expect, it } from "vitest";
import type { Project } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createPianoRollFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import type { PackId } from "../../domain/ids";
import { TICKS_PER_BAR, TICKS_PER_QUARTER } from "../../domain/time";
import { emptySelection, selectOnly } from "../../selection";
import {
  addedPackIds,
  adjacentTrackId,
  drumTrack,
  editedClip,
  editedInstrument,
  editedTrack,
  focusedTrackId,
  instrumentPanelTrackId,
  loopClips,
  loopEntryFor,
  normalizePlayheadSegments,
  openedClip,
  playheadLabel,
  playheadSegments,
  playheadSegmentsToTicks,
  sampleAssets,
  sampleName,
  samplerTrackId,
  showPianoRoll,
} from "./editorViewModel";

/**
 * `editorViewModel` is the pure half of `EditorView`: every derivation the
 * editor's memos wrap. These exercise them directly against the reference
 * fixtures — no rendering, no Solid — including the null-project path each one
 * has to answer while a project is still loading.
 */

describe("addedPackIds", () => {
  it("unions the project's derived dependencies with the session's additions", () => {
    const project = createSliceFixtureProject();
    const projectPackId = project.metadata.packDependencies[0].packId;

    expect(addedPackIds(project, [])).toEqual([projectPackId]);
    expect(addedPackIds(project, ["pak_session"])).toEqual([
      projectPackId,
      "pak_session",
    ]);
  });

  it("includes the project's shelf, without writing to it", () => {
    const project = createSliceFixtureProject();
    const projectPackId = project.metadata.packDependencies[0].packId;
    const shelved = {
      ...project.metadata.packDependencies[0],
      packId: "pak_shelved" as PackId,
    };
    const withShelf = {
      ...project,
      metadata: { ...project.metadata, addedPacks: [shelved] },
    };

    expect(addedPackIds(withShelf, [])).toEqual([projectPackId, "pak_shelved"]);
    expect(withShelf.metadata.addedPacks).toEqual([shelved]);
  });

  it("de-duplicates a session addition the project already depends on", () => {
    const project = createSliceFixtureProject();
    const projectPackId = project.metadata.packDependencies[0].packId;
    expect(addedPackIds(project, [projectPackId])).toEqual([projectPackId]);
  });

  it("returns only the session's packs with no project open", () => {
    expect(addedPackIds(null, [])).toEqual([]);
    expect(addedPackIds(null, ["pak_session"])).toEqual(["pak_session"]);
  });
});

describe("playheadLabel", () => {
  it("shows a 1-based bar.beat, dropping the sixteenth fraction", () => {
    // Tick 0 is the very start: bar 1, beat 1.
    expect(playheadLabel(0)).toBe("1.1");
    // One quarter in is still bar 1, but beat 2.
    expect(playheadLabel(TICKS_PER_QUARTER)).toBe("1.2");
    expect(playheadLabel(TICKS_PER_QUARTER * 3)).toBe("1.4");
    // A whole bar in rolls over to bar 2, beat 1.
    expect(playheadLabel(TICKS_PER_BAR)).toBe("2.1");
    expect(playheadLabel(TICKS_PER_BAR * 4 + TICKS_PER_QUARTER * 2)).toBe("5.3");
  });

  it("ignores a sub-beat offset rather than rounding it up", () => {
    expect(playheadLabel(TICKS_PER_QUARTER + 1)).toBe("1.2");
  });
});

describe("playhead segments", () => {
  it("splits a position into the 1-based bar and beat the label shows", () => {
    expect(playheadSegments(0)).toEqual({ bar: 1, beat: 1 });
    expect(playheadSegments(TICKS_PER_BAR * 4 + TICKS_PER_QUARTER * 2 + 7)).toEqual({
      bar: 5,
      beat: 3,
    });
  });

  it("maps a bar and beat back to the tick at the top of that beat", () => {
    expect(playheadSegmentsToTicks({ bar: 1, beat: 1 })).toBe(0);
    expect(playheadSegmentsToTicks({ bar: 5, beat: 3 })).toBe(
      TICKS_PER_BAR * 4 + TICKS_PER_QUARTER * 2,
    );
  });

  it("clamps a typed position into the song and the 4/4 bar", () => {
    expect(normalizePlayheadSegments(0, 9)).toEqual({ bar: 1, beat: 4 });
    expect(normalizePlayheadSegments(-3, 0)).toEqual({ bar: 1, beat: 1 });
    expect(normalizePlayheadSegments(2.6, 1.4)).toEqual({ bar: 3, beat: 1 });
  });

  it("refuses a segment that is not a number", () => {
    expect(normalizePlayheadSegments(Number.NaN, 1)).toBeNull();
    expect(normalizePlayheadSegments(1, Number.NaN)).toBeNull();
  });
});

describe("focusedTrackId", () => {
  it("is the focused track scope's id", () => {
    const trackId = createSliceFixtureProject().song.tracks[0].id;
    expect(focusedTrackId(selectOnly({ kind: "track", id: trackId }))).toBe(trackId);
  });

  it("is null for an empty selection or a focus that is not a track", () => {
    expect(focusedTrackId(emptySelection())).toBeNull();
    const clipId = createSliceFixtureProject().clips[0].id;
    expect(focusedTrackId(selectOnly({ kind: "clip", id: clipId }))).toBeNull();
  });
});

describe("editedTrack", () => {
  it("is the selected track", () => {
    const project = createDrumMachineFixtureProject();
    const second = project.song.tracks[1];
    expect(editedTrack(project, second.id)?.id).toBe(second.id);
    expect(editedTrack(project, second.id)?.name).toBe("Break");
  });

  it("falls back to the first track with nothing selected", () => {
    const project = createSliceFixtureProject();
    expect(editedTrack(project, null)?.id).toBe(project.song.tracks[0].id);
    expect(editedTrack(project, null)?.name).toBe("BD");
  });

  it("falls back to the first track when the selected one is gone", () => {
    const project = createSliceFixtureProject();
    const removed = createDrumMachineFixtureProject().song.tracks[0].id;
    expect(editedTrack(project, removed)?.id).toBe(project.song.tracks[0].id);
  });

  it("is null with no project open, and for a project with no tracks", () => {
    expect(editedTrack(null, null)).toBeNull();
    const project = createSliceFixtureProject();
    const empty = { ...project, song: { ...project.song, tracks: [] } };
    expect(editedTrack(empty, null)).toBeNull();
  });
});

describe("drumTrack", () => {
  it("is the edited track when it is a drum machine", () => {
    const project = createDrumMachineFixtureProject();
    const found = drumTrack(editedTrack(project, null));
    expect(found?.instrument?.kind).toBe("drumMachine");
    expect(found?.name).toBe("Drums");
  });

  it("is null when the edited track is not a drum machine", () => {
    const project = createDrumMachineFixtureProject();
    // The fixture's second track is an audio track; selecting it must not
    // leave the first track's pads on screen (#228).
    const audioTrack = project.song.tracks[1];
    expect(drumTrack(editedTrack(project, audioTrack.id))).toBeNull();
    expect(drumTrack(editedTrack(createSliceFixtureProject(), null))).toBeNull();
    expect(drumTrack(null)).toBeNull();
  });
});

describe("sampleAssets", () => {
  it("keeps only `sample`-kind assets, dropping loops", () => {
    const project = createDrumMachineFixtureProject();
    // The drum fixture carries two one-shots plus one `loop`-kind asset.
    const assets = sampleAssets(project);
    expect(assets.map((asset) => asset.name)).toEqual(["909 Bass Drum", "909 Clap"]);
    expect(assets.every((asset) => asset.kind === "sample")).toBe(true);
  });

  it("is empty with no project open", () => {
    expect(sampleAssets(null)).toEqual([]);
  });
});

describe("editedClip", () => {
  it("is the clip on the edited track", () => {
    const project = createSliceFixtureProject();
    const clip = editedClip(project, editedTrack(project, null));
    expect(clip?.id).toBe(project.clips[0].id);
    expect(clip?.trackId).toBe(project.song.tracks[0].id);
  });

  it("follows the selection: the audio track's loop, not the drum clip", () => {
    const project = createDrumMachineFixtureProject();
    const audioTrack = project.song.tracks[1];
    const clip = editedClip(project, editedTrack(project, audioTrack.id));
    expect(clip?.content.kind).toBe("audioLoop");
    expect(clip?.trackId).toBe(audioTrack.id);
  });

  it("is null with no project open, and for a track with no clip", () => {
    expect(editedClip(null, null)).toBeNull();
    const project = createSliceFixtureProject();
    expect(editedClip({ ...project, clips: [] }, editedTrack(project, null))).toBeNull();
  });
});

describe("editedInstrument", () => {
  it("is the edited track's instrument", () => {
    const kindOf = (project: Project) =>
      editedInstrument(editedTrack(project, null))?.kind;
    expect(kindOf(createSliceFixtureProject())).toBe("sampler");
    expect(kindOf(createDrumMachineFixtureProject())).toBe("drumMachine");
    expect(kindOf(createPianoRollFixtureProject())).toBe("synth");
  });

  it("is null with no track edited", () => {
    expect(editedInstrument(null)).toBeNull();
  });
});

describe("loopClips", () => {
  it("pairs each audio-loop clip with its resolved asset", () => {
    const project = createDrumMachineFixtureProject();
    const entries = loopClips(project);
    expect(entries).toHaveLength(1);
    expect(entries[0].clip.content.kind).toBe("audioLoop");
    expect(entries[0].asset?.name).toBe("Break loop");
    expect(entries[0].asset?.kind).toBe("loop");
  });

  it("reports a null asset when the loop's asset is missing", () => {
    const project = createDrumMachineFixtureProject();
    const withoutAssets = {
      ...project,
      song: { ...project.song, assets: [] },
    };
    expect(loopClips(withoutAssets)[0].asset).toBeNull();
  });

  it("is empty for a project with no loops, and with no project open", () => {
    expect(loopClips(createSliceFixtureProject())).toEqual([]);
    expect(loopClips(null)).toEqual([]);
  });
});

describe("sampleName", () => {
  it("names the sample the edited sampler is loaded with", () => {
    const project = createSliceFixtureProject();
    expect(sampleName(project, editedTrack(project, null))).toBe("909 Bass Drum");
  });

  it("is null when the edited instrument is not a sampler", () => {
    const drums = createDrumMachineFixtureProject();
    expect(sampleName(drums, editedTrack(drums, null))).toBeNull();
    const synth = createPianoRollFixtureProject();
    expect(sampleName(synth, editedTrack(synth, null))).toBeNull();
    expect(sampleName(null, null)).toBeNull();
  });
});

describe("samplerTrackId", () => {
  it("names the track a dropped or inserted sound loads onto", () => {
    const project = createSliceFixtureProject();
    expect(samplerTrackId(editedTrack(project, null))).toBe(project.song.tracks[0].id);
  });

  it("follows the selected track rather than the project's first (#228)", () => {
    const project = createSliceFixtureProject();
    const first = project.song.tracks[0];
    expect(samplerTrackId(editedTrack(project, first.id))).toBe(first.id);
  });

  it("is null when the edited track has no sampler to load into", () => {
    const drums = createDrumMachineFixtureProject();
    const synth = createPianoRollFixtureProject();
    expect(samplerTrackId(editedTrack(drums, null))).toBeNull();
    expect(samplerTrackId(editedTrack(synth, null))).toBeNull();
    expect(samplerTrackId(null)).toBeNull();
  });
});

describe("showPianoRoll", () => {
  const forProject = (project: Project) => {
    const track = editedTrack(project, null);
    return showPianoRoll(track, editedClip(project, track));
  };

  it("is true for a synth track holding a note clip", () => {
    expect(forProject(createPianoRollFixtureProject())).toBe(true);
  });

  it("is true for a sampler track holding a note clip (#496)", () => {
    expect(forProject(createSliceFixtureProject())).toBe(true);
  });

  it("is false for a drum-machine note clip, which keeps the step grid", () => {
    expect(forProject(createDrumMachineFixtureProject())).toBe(false);
  });

  it("is false for a synth track with no clip", () => {
    const project = createPianoRollFixtureProject();
    expect(forProject({ ...project, clips: [] })).toBe(false);
  });

  it("is false with no project open", () => {
    expect(showPianoRoll(null, null)).toBe(false);
  });
});

describe("openedClip", () => {
  it("resolves the clip and track a placement points at", () => {
    const project = createSliceFixtureProject();
    const [placement] = project.song.placements;
    const opened = openedClip(project, placement.id);
    expect(opened?.clip.id).toBe(placement.clipId);
    expect(opened?.track.id).toBe(placement.trackId);
  });

  it("is null for a placement the project no longer has, which closes the editor", () => {
    const project = createSliceFixtureProject();
    const [placement] = project.song.placements;
    const without = { ...project, song: { ...project.song, placements: [] } };
    expect(openedClip(without, placement.id)).toBeNull();
    expect(openedClip(project, null)).toBeNull();
    expect(openedClip(null, placement.id)).toBeNull();
  });
});

describe("loopEntryFor", () => {
  it("pairs an audio-loop clip with its asset, and ignores a note clip", () => {
    const project = createDrumMachineFixtureProject();
    const loop = project.clips.find((clip) => clip.content.kind === "audioLoop");
    const notes = project.clips.find((clip) => clip.content.kind === "notes");
    expect(loop).toBeDefined();
    expect(loopEntryFor(project, loop ?? null)?.clip.id).toBe(loop?.id);
    expect(loopEntryFor(project, notes ?? null)).toBeNull();
    expect(loopEntryFor(project, null)).toBeNull();
  });
});

describe("instrumentPanelTrackId", () => {
  it("names the edited track, whatever instrument it carries", () => {
    const sampler = createSliceFixtureProject();
    expect(instrumentPanelTrackId(editedTrack(sampler, null))).toBe(
      sampler.song.tracks[0].id,
    );
    const synth = createPianoRollFixtureProject();
    expect(instrumentPanelTrackId(editedTrack(synth, null))).toBe(
      synth.song.tracks[0].id,
    );
  });

  it("names a drum-machine track too, so the kind picker can leave it (#224)", () => {
    const drums = createDrumMachineFixtureProject();
    expect(instrumentPanelTrackId(editedTrack(drums, null))).toBe(
      drums.song.tracks[0].id,
    );
  });

  it("is null with no track edited", () => {
    expect(instrumentPanelTrackId(null)).toBeNull();
  });
});

describe("adjacentTrackId", () => {
  const project = createDrumMachineFixtureProject();
  const [first, second] = project.song.tracks.map((track) => track.id);

  it("steps to the neighbouring track and stops at each end", () => {
    expect(adjacentTrackId(project, first, 1)).toBe(second);
    expect(adjacentTrackId(project, second, -1)).toBe(first);
    expect(adjacentTrackId(project, first, -1)).toBeNull();
    expect(adjacentTrackId(project, second, 1)).toBeNull();
  });

  it("starts from the first track when nothing (or a vanished track) is selected", () => {
    expect(adjacentTrackId(project, null, 1)).toBe(second);
    expect(adjacentTrackId(project, "trk_gone" as typeof first, 1)).toBe(second);
  });

  it("has nowhere to step without a project", () => {
    expect(adjacentTrackId(null, null, 1)).toBeNull();
  });
});
