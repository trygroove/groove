import { describe, expect, it } from "vitest";
import { createCommandTestProject } from "../../commands/testProjects";
import { controlHome, focusTargetOf } from "./controlReveal";

/**
 * Where each kind of address lives (`UI-004`): the view a reveal opens, the
 * track it selects, the clip it opens, and the owner it falls back to.
 */
const fixture = createCommandTestProject();
const { project } = fixture;
const trackA = fixture.trackAId;
const trackB = fixture.trackBId;
const header = (trackId: string) => ({ entity: trackId, param: "header" });

describe("controlHome", () => {
  it("sends a track's volume, pan and sends to the mixer, on that track", () => {
    for (const param of ["volume", "pan", `sendLevel.${fixture.returnId}`]) {
      expect(controlHome(project, { entity: trackA, param })).toEqual({
        view: "mixer",
        trackId: trackA,
        padId: null,
        placementId: undefined,
        fallback: header(trackA),
      });
    }
  });

  it("sends an instrument parameter, and the instrument itself, to the instrument view", () => {
    for (const param of ["pitch", "filterCutoff", "instrument", "sample", "devices"]) {
      expect(controlHome(project, { entity: trackA, param })).toMatchObject({
        view: "instrument",
        trackId: trackA,
      });
    }
  });

  it("selects a track for its header, mute or solo, in whichever view is open", () => {
    for (const param of ["header", "muted", "soloed"]) {
      expect(controlHome(project, { entity: trackB, param })).toEqual({
        view: null,
        trackId: trackB,
        padId: null,
        placementId: undefined,
        fallback: header(trackB),
      });
    }
  });

  it("leaves the view alone for tempo and swing, which the header always shows", () => {
    for (const param of ["tempo", "swing", "name"]) {
      expect(controlHome(project, { entity: "song", param })).toMatchObject({
        view: null,
        trackId: null,
        placementId: undefined,
        fallback: null,
      });
    }
    expect(controlHome(project, { entity: "song", param: "tracks" }).view).toBe(
      "arrangement",
    );
  });

  it("finds a device's track, and keeps the master's chain in the mixer", () => {
    expect(controlHome(project, { entity: fixture.deviceId, param: "time" })).toEqual({
      view: "instrument",
      trackId: trackA,
      padId: null,
      placementId: undefined,
      fallback: header(trackA),
    });
    expect(controlHome(project, { entity: "master", param: "volume" }).view).toBe(
      "mixer",
    );
    expect(controlHome(project, { entity: fixture.returnId, param: "volume" }).view).toBe(
      "mixer",
    );
  });

  it("selects a pad on its drum track", () => {
    const [kick] = fixture.padIds;
    expect(controlHome(project, { entity: kick, param: "pitch" })).toEqual({
      view: "instrument",
      trackId: trackB,
      padId: kick,
      placementId: undefined,
      fallback: header(trackB),
    });
  });

  it("opens a clip's notes in the sequence view, from its placement", () => {
    expect(controlHome(project, { entity: fixture.clipAId, param: "notes" })).toEqual({
      view: "sequence",
      trackId: trackA,
      padId: null,
      placementId: fixture.placementAId,
      fallback: header(trackA),
    });
    // Its name is on the timeline, not in the sequence view.
    expect(
      controlHome(project, { entity: fixture.clipAId, param: "name" }),
    ).toMatchObject({ view: "arrangement", placementId: undefined });
  });

  it("lands an unplaced clip on its track", () => {
    const unplaced = {
      ...project,
      song: { ...project.song, placements: [] },
    };
    expect(controlHome(unplaced, { entity: fixture.clipAId, param: "notes" })).toEqual({
      view: "arrangement",
      trackId: trackA,
      padId: null,
      placementId: undefined,
      fallback: header(trackA),
    });
  });

  it("shows a placement on the arrangement, on its track", () => {
    expect(
      controlHome(project, { entity: fixture.placementAId, param: "placement" }),
    ).toMatchObject({ view: "arrangement", trackId: trackA });
  });

  it("lands an address nothing owns on the arrangement, never nowhere", () => {
    expect(controlHome(project, { entity: "trk_gone", param: "volume" })).toEqual({
      view: "arrangement",
      trackId: null,
      padId: null,
      placementId: undefined,
      fallback: null,
    });
  });
});

describe("focusTargetOf", () => {
  it("focuses a slider's range rather than its value field", () => {
    const part = document.createElement("div");
    part.innerHTML = '<input type="text"><input type="range">';
    expect(focusTargetOf(part)).toBe(part.querySelector('input[type="range"]'));
  });

  it("focuses a part that takes focus itself, else the first thing in it that does", () => {
    const button = document.createElement("button");
    expect(focusTargetOf(button)).toBe(button);
    const cell = document.createElement("div");
    cell.innerHTML = '<span></span><button type="button">BD</button>';
    expect(focusTargetOf(cell)).toBe(cell.querySelector("button"));
    const bare = document.createElement("div");
    expect(focusTargetOf(bare)).toBe(bare);
  });
});
