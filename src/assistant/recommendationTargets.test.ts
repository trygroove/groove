import { describe, expect, it } from "vitest";
import {
  createDenseStepFixtureProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import { buildAssistantPayload } from "./payload";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import {
  contextTargets,
  createdTargets,
  misaimedRecommendation,
  namedTarget,
  targetsAfter,
} from "./recommendationTargets";
import { CREATE_EXAMPLES } from "./tools";

const kitProject = createDenseStepFixtureProject();
const [kit] = kitProject.song.tracks;
if (kit?.instrument?.kind !== "drumMachine") throw new Error("not a kit");
const pads = kit.instrument.pads;

const NEW_KIT = "trk_FirstBeatSnareHat0001";
const NEW_PAD = "pad_FirstBeatSnare0000001";
const createKit = {
  name: "track_create",
  input: {
    ...CREATE_EXAMPLES.track,
    id: NEW_KIT,
    instrument: {
      kind: "drumMachine",
      parameters: {},
      pads: [
        {
          id: NEW_PAD,
          name: "Snare",
          assetId: null,
          chokeGroup: null,
          parameters: {},
          mixer: { volume: 0, pan: 0, muted: false, soloed: false },
        },
      ],
    },
  },
};
const recommend = (target: { trackId?: string; padId?: string }) => ({
  name: RECOMMEND_SOUNDS_TOOL,
  input: { packId: "pak_x", soundIds: ["a"], reason: "Fits.", ...target },
});

describe("recommendation targets (GRV-129)", () => {
  it("lists the context's tracks with their pads, and none on a sampler", () => {
    const targets = contextTargets(buildAssistantPayload(kitProject));
    expect([...(targets.get(kit.id) ?? [])]).toEqual(pads.map((pad) => pad.id));
    const slice = createSliceFixtureProject();
    const sampler = slice.song.tracks[0];
    expect(
      contextTargets(buildAssistantPayload(slice)).get(sampler?.id ?? "")?.size,
    ).toBe(0);
  });

  it("adds what a track_create or an instrument_change makes, and nothing for other calls", () => {
    const created = createdTargets([createKit]);
    expect([...(created.get(NEW_KIT) ?? [])]).toEqual([NEW_PAD]);
    const changed = createdTargets([
      {
        name: "instrument_change",
        input: { trackId: kit.id, instrument: createKit.input.instrument },
      },
    ]);
    expect([...(changed.get(kit.id) ?? [])]).toEqual([NEW_PAD]);
    expect(createdTargets([{ name: "track_create", input: { id: "bad" } }]).size).toBe(0);
    expect(createdTargets([recommend({ trackId: NEW_KIT })]).size).toBe(0);
  });

  it("accepts a track and pad in the project or made earlier in the turn", () => {
    const targets = targetsAfter(contextTargets(buildAssistantPayload(kitProject)), [
      createKit,
    ]);
    expect(misaimedRecommendation(recommend({}), targets)).toBeNull();
    expect(
      misaimedRecommendation(recommend({ trackId: kit.id, padId: pads[0]?.id }), targets),
    ).toBeNull();
    expect(
      misaimedRecommendation(recommend({ trackId: NEW_KIT, padId: NEW_PAD }), targets),
    ).toBeNull();
    expect(misaimedRecommendation(recommend({ padId: NEW_PAD }), targets)).toBeNull();
  });

  it("refuses a track or pad that is in neither, and a pad its track lacks", () => {
    const targets = contextTargets(buildAssistantPayload(kitProject));
    expect(misaimedRecommendation(recommend({ trackId: NEW_KIT }), targets)).toMatch(
      /no track/,
    );
    expect(
      misaimedRecommendation(recommend({ trackId: kit.id, padId: NEW_PAD }), targets),
    ).toMatch(/has no pad/);
    expect(misaimedRecommendation(recommend({ padId: NEW_PAD }), targets)).toMatch(
      /no pad/,
    );
  });

  it("ignores a pad named on a track that has no pads, as the editor does", () => {
    const slice = createSliceFixtureProject();
    const sampler = slice.song.tracks[0];
    const targets = contextTargets(buildAssistantPayload(slice));
    expect(
      misaimedRecommendation(
        recommend({ trackId: sampler?.id, padId: NEW_PAD }),
        targets,
      ),
    ).toBeNull();
  });

  it("reads the track and pad a call names, and null for each it does not", () => {
    expect(namedTarget({ trackId: NEW_KIT, padId: NEW_PAD })).toEqual({
      trackId: NEW_KIT,
      padId: NEW_PAD,
    });
    expect(namedTarget({ trackId: 3 })).toEqual({ trackId: null, padId: null });
    expect(namedTarget(null)).toEqual({ trackId: null, padId: null });
  });
});
