import { describe, expect, it } from "vitest";
import { isEntityId } from "../../domain/ids";
import { assertProject } from "../../domain/parse";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";
import { generateProjectName } from "./projectName";
import { createStarterProject } from "./starterProject";

describe("createStarterProject", () => {
  it("builds a valid schema-v1 project", () => {
    const project = createStarterProject("user_1");
    // Throws if invalid; a successful call is the assertion.
    expect(() => assertProject(project)).not.toThrow();
  });

  it("starts with a visible Limiter on the master, in place of the hidden one (#937)", () => {
    const project = createStarterProject("user_1");

    expect(project.song.master.safetyLimiter).toBe(false);
    expect(project.song.master.devices).toEqual([
      expect.objectContaining({
        type: "limiter",
        order: 0,
        bypassed: false,
        parameters: { drive: 0, ceiling: -0.3, release: 0.1 },
      }),
    ]);
  });

  it("starts with the loop on over bars 1-2 (LOOP-017)", () => {
    const project = createStarterProject("user_1");

    expect(project.song.loop).toEqual({
      startTicks: 0,
      endTicks: TICKS_PER_BAR,
      enabled: true,
    });
  });

  it("has one drum-machine track with a BD pad whose asset resolves through a pack", () => {
    const project = createStarterProject("user_1");

    expect(project.song.tracks).toHaveLength(1);
    const track = project.song.tracks[0];
    expect(track.name).toBe("BD");
    if (track.instrument?.kind !== "drumMachine")
      throw new Error("expected drum machine");
    expect(track.instrument.pads.map((pad) => pad.name)).toEqual(["BD"]);

    expect(project.song.assets).toHaveLength(1);
    const asset = project.song.assets[0];
    expect(track.instrument.pads[0].assetId).toBe(asset.id);

    expect(project.metadata.packDependencies).toEqual([
      { packId: asset.packId, version: asset.packVersion },
    ]);
  });

  it("has a one-bar four-on-the-floor note clip placed once", () => {
    const project = createStarterProject("user_1");

    expect(project.clips).toHaveLength(1);
    const clip = project.clips[0];
    expect(clip.content.kind).toBe("notes");
    if (clip.content.kind === "notes") {
      expect(clip.content.events).toHaveLength(4);
      // Every hit triggers the BD pad, on steps 1, 5, 9, 13.
      const track = project.song.tracks[0];
      const padId =
        track.instrument?.kind === "drumMachine" ? track.instrument.pads[0].id : null;
      expect(clip.content.events.map((event) => event.trigger)).toEqual(
        Array(4).fill({ kind: "pad", padId }),
      );
      expect(
        clip.content.events.map((event) => event.startTicks / TICKS_PER_SIXTEENTH),
      ).toEqual([0, 4, 8, 12]);
    }
    expect(project.song.placements).toHaveLength(1);
    expect(project.song.placements[0].clipId).toBe(clip.id);
  });

  it("builds independent projects on each call", () => {
    const a = createStarterProject("user_1");
    const b = createStarterProject("user_1");
    expect(a.metadata.id).not.toBe(b.metadata.id);
    expect(isEntityId("project", a.metadata.id)).toBe(true);
  });

  it("names the project with a generated track-style name", () => {
    const project = createStarterProject("user_1", () => 0);
    expect(project.metadata.name).toBe(generateProjectName(() => 0));
    expect(project.metadata.name).not.toMatch(/untitled/i);
  });

  it("owns the project by the given user", () => {
    const project = createStarterProject("user_42");
    expect(project.metadata.ownerId).toBe("user_42");
  });
});
