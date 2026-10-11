import { describe, expect, it } from "vitest";
import {
  buildAssistantLibrary,
  DRUM_PACK_ID,
  FX_PACK_ID,
} from "../testing/assistantLibrary";
import { assistantLibraryContextSchema, assistantTurnRequestSchema } from "./protocol";
import {
  RECOMMEND_SOUNDS_TOOL,
  recommendationTool,
  splitRecommendations,
  validateRecommendation,
} from "./recommendation";
import { assistantTools } from "./tools";

const library = buildAssistantLibrary();

describe("validateRecommendation", () => {
  it("accepts a pack and its sounds by the library's IDs, best first", () => {
    const result = validateRecommendation(
      {
        packId: DRUM_PACK_ID,
        soundIds: ["kick-dusty", "kick-warm"],
        reason: "Softer, grittier kicks.",
        trackId: "trk_bd",
        padId: "pad_bd",
      },
      library,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.recommendation.pack.name).toBe("Core Drums");
    expect(result.recommendation.sounds.map((sound) => sound.name)).toEqual([
      "Dusty Kick",
      "Warm Kick",
    ]);
    expect(result.recommendation.reason).toBe("Softer, grittier kicks.");
    expect(result.recommendation.trackId).toBe("trk_bd");
    expect(result.recommendation.padId).toBe("pad_bd");
  });

  it("names no track or pad when the call names none, and drops a repeated sound", () => {
    const result = validateRecommendation(
      { packId: DRUM_PACK_ID, soundIds: ["kick-warm", "kick-warm"], reason: "Warm." },
      library,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.recommendation.trackId).toBeNull();
    expect(result.recommendation.padId).toBeNull();
    expect(result.recommendation.sounds).toHaveLength(1);
  });

  it("refuses a pack the library does not hold", () => {
    const result = validateRecommendation(
      { packId: "pak_invented", soundIds: ["kick-dusty"], reason: "Dusty." },
      library,
    );
    expect(result).toMatchObject({ ok: false, code: "unknown_pack" });
  });

  it("refuses a sound the library does not hold", () => {
    const result = validateRecommendation(
      { packId: DRUM_PACK_ID, soundIds: ["kick-dusty", "kick-invented"], reason: "x" },
      library,
    );
    expect(result).toMatchObject({ ok: false, code: "unknown_sound" });
  });

  it("refuses a sound from another pack than the one it names", () => {
    const result = validateRecommendation(
      { packId: FX_PACK_ID, soundIds: ["kick-dusty"], reason: "x" },
      library,
    );
    expect(result).toMatchObject({ ok: false, code: "unknown_sound" });
  });

  it("refuses a call that is not a recommendation", () => {
    for (const input of [
      null,
      { packId: DRUM_PACK_ID, soundIds: [], reason: "x" },
      { packId: DRUM_PACK_ID, soundIds: ["a", "b", "c", "d"], reason: "x" },
      { packId: DRUM_PACK_ID, soundIds: ["kick-dusty"], reason: "  " },
      { packId: DRUM_PACK_ID, soundIds: ["kick-dusty"] },
    ]) {
      expect(validateRecommendation(input, library)).toMatchObject({
        ok: false,
        code: "malformed",
      });
    }
  });
});

describe("splitRecommendations", () => {
  const recommend = { id: "t1", name: RECOMMEND_SOUNDS_TOOL, input: {} };
  const change = { id: "t2", name: "parameter_set", input: {} };

  it("takes the recommendations out of the changes, keeping both in order", () => {
    const split = splitRecommendations({
      baseRevision: 4,
      toolsetVersion: 3,
      calls: [change, recommend],
    });
    expect(split.proposal).toEqual({
      baseRevision: 4,
      toolsetVersion: 3,
      calls: [change],
    });
    expect(split.recommendations).toEqual([recommend]);
  });

  it("leaves no proposal when every call is a recommendation", () => {
    const split = splitRecommendations({
      baseRevision: 4,
      toolsetVersion: 3,
      calls: [recommend],
    });
    expect(split.proposal).toBeNull();
    expect(split.recommendations).toHaveLength(1);
  });
});

describe("the recommendation tool", () => {
  it("takes an object, under a provider-safe name no command tool uses", () => {
    const tool = recommendationTool();
    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(tool.input_schema.type).toBe("object");
    expect(assistantTools().map((entry) => entry.name)).not.toContain(tool.name);
    expect(JSON.stringify(tool.input_schema)).toContain("soundIds");
  });
});

describe("the library a turn carries", () => {
  it("is optional on a turn, and strict: no audio, URL or storage field passes", () => {
    expect(assistantLibraryContextSchema.safeParse(library).success).toBe(true);
    const withUrl = buildAssistantLibrary();
    (withUrl.packs[0].sounds[0] as unknown as Record<string, unknown>).url =
      "https://example.com/kick.wav";
    expect(assistantLibraryContextSchema.safeParse(withUrl).success).toBe(false);
    const turn = {
      projectRevision: 1,
      messages: [{ role: "user", text: "hi" }],
      context: {},
    };
    // The context is incomplete here, so only the library's own issues matter.
    const parsed = assistantTurnRequestSchema.safeParse({ ...turn, library: withUrl });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "library")).toBe(true);
    }
  });
});
