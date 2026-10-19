import { describe, expect, it } from "vitest";
import { createReferenceProject } from "../domain/fixtures";
import type { EventId, PlacementId } from "../domain/ids";
import { resolveScope, scopedContext } from "../editor/assistant/assistantScope";
import { buildAssistantPayload } from "./payload";
import type { AssistantTurnRequest } from "./protocol";
import {
  type BundleSignals,
  bundleSignals,
  chooseToolBundle,
  toolBundleFor,
} from "./toolBundleRule";

const song = (message: string): BundleSignals => ({
  level: "song",
  trackKinds: [],
  message,
});
const onTrack = (
  message: string,
  kind: BundleSignals["trackKinds"][number] = "synth",
): BundleSignals => ({ level: "track", trackKinds: [kind], message });
const onNotes = (message: string): BundleSignals => ({
  level: "selection",
  trackKinds: ["drumMachine"],
  message,
});

describe("chooseToolBundle (GRV-143)", () => {
  it.each([
    ["Make the kick louder", song("Make the kick louder")],
    ["Pan the hats a little left", song("Pan the hats a little left")],
    ["Add some reverb to the snare", onTrack("Add some reverb to the snare")],
    ["Mute the bass", song("Mute the bass")],
    ["Make the lead brighter", onTrack("Make the lead brighter")],
    ["Sidechain the pad to the kick", song("Sidechain the pad to the kick")],
  ])("gives a mixing or sound request the mix bundle: %s", (_, signals) => {
    expect(chooseToolBundle(signals)).toBe("mix");
  });

  it.each([
    ["Quantize these to 16ths", onNotes("Quantize these to 16ths")],
    ["Humanize the velocities", onNotes("Humanise the velocities")],
    ["Transpose it up an octave", onTrack("Transpose it up an octave")],
    ["Tighten the timing on the whole song", song("Tighten the timing")],
  ])("gives a note edit the notes bundle at any scope: %s", (_, signals) => {
    expect(chooseToolBundle(signals)).toBe("notes");
  });

  it("writes a new part with the notes bundle on an instrument track in scope", () => {
    expect(chooseToolBundle(onTrack("Write a bassline for this"))).toBe("notes");
    expect(chooseToolBundle(onNotes("Give it a fill at the end"))).toBe("notes");
  });

  it("writes a new part with every tool where it may need a track first", () => {
    // The whole song: there may be no track for the part yet.
    expect(chooseToolBundle(song("Write a bassline"))).toBe("everything");
    // A track with no instrument cannot hold notes.
    expect(chooseToolBundle(onTrack("Write a melody here", null))).toBe("everything");
  });

  it.each([
    ["Make the drop longer", song("Make the drop longer")],
    ["Speed it up to 128 bpm", song("Speed it up to 128 bpm")],
    ["Add more swing", song("Add more swing")],
    ["Duplicate the chorus", song("Duplicate the chorus")],
    ["Delete the track", onTrack("Delete the track")],
  ])("gives an arrangement or tempo request the arrange bundle: %s", (_, signals) => {
    expect(chooseToolBundle(signals)).toBe("arrange");
  });

  it.each([
    ["a whole new part", song("Add a new track with a pad")],
    ["a sketch", song("Make me a house beat")],
    ["a song", onTrack("Turn this into a full song")],
    ["two families at once", song("Make the kick louder and quantize the hats")],
    ["no family at all", onNotes("Make it groovier")],
    ["an answer with no words to read", song("2")],
    ["an empty message", song("   ")],
  ])("falls back to everything for %s", (_, signals) => {
    expect(chooseToolBundle(signals)).toBe("everything");
  });

  it("reads words whatever their case, hyphens or punctuation", () => {
    expect(chooseToolBundle(song("LOUDER!!"))).toBe("mix");
    expect(chooseToolBundle(onTrack("re-quantise, please"))).toBe("notes");
    expect(chooseToolBundle(song("Add a build-up"))).toBe("arrange");
  });

  it("is pure: the same signals always pick the same bundle", () => {
    const signals = onTrack("Write a bassline for this");
    expect(new Set([1, 2, 3].map(() => chooseToolBundle(signals))).size).toBe(1);
  });
});

describe("bundleSignals (GRV-143)", () => {
  const project = createReferenceProject();
  const track = project.song.tracks[0] ?? null;
  const clip = project.clips.find((entry) => entry.trackId === track?.id);
  const firstEvent =
    clip?.content.kind === "notes" ? (clip.content.events[0]?.id ?? null) : null;
  const placement = project.song.placements.find((entry) => entry.trackId === track?.id);

  function turn(
    message: string,
    context: AssistantTurnRequest["context"],
  ): AssistantTurnRequest {
    return {
      projectRevision: 1,
      messages: [
        { role: "user", text: "Earlier, with other words: louder" },
        { role: "assistant", text: "Done." },
        { role: "user", text: message },
      ],
      context,
    };
  }

  it("reads the whole song from a context with no selection", () => {
    const signals = bundleSignals(turn("hi", buildAssistantPayload(project)));
    expect(signals).toEqual({ level: "song", trackKinds: [], message: "hi" });
  });

  it("reads the composer's track scope, and the track's kind", () => {
    const scope = resolveScope({ selection: null, track }, "track");
    const signals = bundleSignals(turn("hi", scopedContext(project, scope)));
    expect(signals.level).toBe("track");
    expect(signals.trackKinds).toEqual([track?.instrument?.kind ?? null]);
  });

  it("reads selected notes or clips as a selection, on the tracks they are on", () => {
    expect(firstEvent).not.toBeNull();
    const notes = resolveScope(
      {
        selection: { kind: "notes", eventIds: [firstEvent as EventId] },
        track,
      },
      "selection",
    );
    const signals = bundleSignals(turn("hi", scopedContext(project, notes)));
    expect(signals.level).toBe("selection");
    expect(signals.trackKinds).toEqual([track?.instrument?.kind ?? null]);

    expect(placement).toBeDefined();
    const clips = resolveScope(
      {
        selection: { kind: "clips", placementIds: [placement?.id as PlacementId] },
        track,
      },
      "selection",
    );
    expect(bundleSignals(turn("hi", scopedContext(project, clips))).level).toBe(
      "selection",
    );
  });

  it("reads only the producer's last message", () => {
    const context = buildAssistantPayload(project);
    expect(toolBundleFor(turn("Quantize everything", context))).toBe("notes");
    expect(toolBundleFor(turn("ok", context))).toBe("everything");
  });
});
