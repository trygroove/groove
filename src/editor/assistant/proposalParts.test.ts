import { describe, expect, it } from "vitest";
import type { AssistantProposalPart, AssistantToolCall } from "../../assistant/protocol";
import { ASSISTANT_TOOLSET_VERSION, CREATE_EXAMPLES } from "../../assistant/tools";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { SONG_SWING } from "../../domain/parameters";
import { TICKS_PER_BAR } from "../../domain/time";
import {
  applyCommands,
  barsText,
  partLineText,
  partNeeds,
  type ResolvedPart,
  resolvePart,
} from "./proposalParts";

const part = (call: Omit<AssistantToolCall, "id">, index = 0): AssistantProposalPart => ({
  index,
  toolsetVersion: ASSISTANT_TOOLSET_VERSION,
  call: { id: `toolu_${index}`, ...call },
});

const TRACK = part({ name: "track_create", input: CREATE_EXAMPLES.track });
const CLIP = part({ name: "clip_create", input: CREATE_EXAMPLES.clip }, 1);
const PLACEMENT = part({ name: "placement_create", input: CREATE_EXAMPLES.placement }, 2);

function resolved(resolution: ReturnType<typeof resolvePart>): ResolvedPart {
  if (!resolution.ok) throw new Error(resolution.reason);
  return resolution;
}

describe("a streamed proposal's parts (GRV-144)", () => {
  const project = createSliceFixtureProject();

  it("reads a track it makes as new, and a clip or placement as its track and length", () => {
    const track = resolved(resolvePart(project, TRACK));
    expect(partLineText(track.line)).toBe("Bass · new track");
    const withTrack = applyCommands(project, track.commands) ?? project;
    const clip = resolved(resolvePart(withTrack, CLIP));
    expect(partLineText(clip.line)).toBe("Bass · 1 bar");
    const withClip = applyCommands(withTrack, clip.commands) ?? withTrack;
    expect(partLineText(resolved(resolvePart(withClip, PLACEMENT)).line)).toBe(
      "Bass · 1 bar at bar 1",
    );
  });

  it("reads any other part as the controls it changes, old to new", () => {
    const swing = resolved(
      resolvePart(
        project,
        part({
          name: "parameter_set",
          input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 58 },
        }),
      ),
    );
    expect(swing.line).toMatchObject({ name: "Swing 50% to 58%", detail: null });
    expect(swing.line.rows).toEqual([
      expect.objectContaining({ label: "Swing", from: "50%", to: "58%" }),
    ]);
  });

  it("knows what a part makes, and which earlier parts a later one needs", () => {
    const track = resolved(resolvePart(project, TRACK));
    expect(track.creates).toEqual(new Set([CREATE_EXAMPLES.track.id]));
    const withTrack = applyCommands(project, track.commands) ?? project;
    const clip = resolved(resolvePart(withTrack, CLIP));
    expect(clip.creates.has(CREATE_EXAMPLES.clip.id)).toBe(true);
    // Its note too, so a later part on that note needs it.
    expect(clip.creates.has(CREATE_EXAMPLES.clip.content.events[0].id)).toBe(true);
    const withClip = applyCommands(withTrack, clip.commands) ?? withTrack;
    const placement = resolved(resolvePart(withClip, PLACEMENT));
    const earlier = [
      { index: 0, creates: track.creates },
      { index: 1, creates: clip.creates },
    ];
    expect(partNeeds(clip.commands, earlier.slice(0, 1))).toEqual([0]);
    expect(partNeeds(placement.commands, earlier)).toEqual([0, 1]);
    expect(partNeeds(track.commands, [])).toEqual([]);
  });

  it("refuses a part that does not fit the song, in plain words", () => {
    // A clip on a track nobody made.
    const refused = resolvePart(project, CLIP);
    expect(refused).toMatchObject({
      ok: false,
      reason: "The assistant's change to a clip doesn't fit with the rest of your song.",
      // As the one-call proposal it was checked as, with the validator's reasons.
      input: { baseRevision: project.metadata.revision, calls: [CLIP.call] },
      issues: [expect.objectContaining({ code: expect.any(String) })],
    });
    const tooFar = resolvePart(
      project,
      part({
        name: "parameter_set",
        input: { target: { scope: "song", parameterId: SONG_SWING.id }, value: 99 },
      }),
    );
    expect(tooFar).toMatchObject({ ok: false, reason: expect.stringContaining("range") });
  });

  it("adds a new drum machine's starter kit with it, and a later one reuses it (GRV-192)", () => {
    const drums = (id: string, padId: string, index: number) =>
      part(
        {
          name: "track_create",
          input: {
            ...CREATE_EXAMPLES.track,
            id,
            name: `Drums ${index}`,
            order: project.song.tracks.length + index,
            instrument: {
              kind: "drumMachine",
              parameters: {},
              pads: [
                {
                  id: padId,
                  name: "Kick",
                  assetId: null,
                  chokeGroup: null,
                  parameters: {},
                  mixer: { volume: 0, pan: 0, muted: false, soloed: false },
                },
              ],
            },
          },
        },
        index,
      );
    const first = resolved(
      resolvePart(
        project,
        drums("trk_Drums1000000000000000", "pad_Kick10000000000000000", 0),
      ),
    );
    expect(first.commands.map((command) => command.type)).toEqual([
      "asset.add",
      "asset.add",
      "asset.add",
      "asset.add",
      "track.create",
    ]);
    expect(partLineText(first.line)).toBe("Drums 0 · new track");
    const withFirst = applyCommands(project, first.commands) ?? project;
    const second = resolved(
      resolvePart(
        withFirst,
        drums("trk_Drums2000000000000000", "pad_Kick20000000000000000", 1),
      ),
    );
    expect(second.commands.map((command) => command.type)).toEqual(["track.create"]);
    expect(partNeeds(second.commands, [{ index: 0, creates: first.creates }])).toEqual([
      0,
    ]);
  });

  it("counts bars, and a part of one", () => {
    expect(barsText(TICKS_PER_BAR)).toBe("1 bar");
    expect(barsText(TICKS_PER_BAR * 8)).toBe("8 bars");
    expect(barsText(TICKS_PER_BAR * 1.5)).toBe("1.5 bars");
  });
});
