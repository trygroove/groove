import { describe, expect, it } from "vitest";
import {
  checkNoAbsentTrack,
  checkNoDeniedTrack,
  isReplyCheck,
  REPLY_CHECK_IDS,
  runReplyCheck,
} from "./caseChecksContext";

const SNARE = { present: ["snare", "SD"] };
const CLOSED_HAT = { absent: ["closed hat", "hi-hat", "hat"] };

describe("checkNoDeniedTrack (GRV-150)", () => {
  it.each([
    // What QA saw, word for word up to the cut.
    "There's no snare track in the project yet — I never actually added it, so there's nothing to brighten.",
    "There’s no SD track in the song, so I can't brighten it.",
    "You don't have a snare yet. Want me to add one first?",
    "The SD track doesn't exist yet, so let me make it.",
    "The snare was never added: that proposal didn't go through.",
    "I can't find the snare — it isn't in the project.",
    "Looks like the snare hasn't been added yet.",
  ])("fails a reply that says the snare is missing: %s", (reply) => {
    const result = checkNoDeniedTrack(reply, SNARE);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/^Says a track the project has is missing: "/);
  });

  it.each([
    "I'll brighten the SD by opening up its filter a little.",
    "There's no EQ on the SD yet, so I'll add one with a gentle high shelf.",
    "I'll lift the snare's top end with an EQ on the SD track. No other track changes.",
    "Brighter snare coming up: a high shelf at 5 kHz, +3 dB, on SD.",
    "Nothing is muted: BD and SD are both playing.",
  ])("passes a reply that works on the snare it has: %s", (reply) => {
    expect(checkNoDeniedTrack(reply, SNARE).status).toBe("pass");
  });

  it("passes when the case names no track it has", () => {
    expect(checkNoDeniedTrack("There's no snare.")).toEqual({
      status: "pass",
      detail: "The case names no track the project has",
    });
  });
});

describe("checkNoAbsentTrack (GRV-150)", () => {
  it.each([
    "Nothing is muted. BD, SD and the 'Closed Hat' track I just proposed are both playing normally.",
    "BD, SD and Closed Hat are all unmuted.",
    "No — the kick, the snare and the hi-hats are all playing.",
    "Nothing's muted; the hats are in too.",
  ])("fails a reply that mentions the cancelled closed hat: %s", (reply) => {
    const result = checkNoAbsentTrack(reply, CLOSED_HAT);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/^Mentions a track the project does not have: "/);
  });

  it.each([
    "Nothing is muted right now: BD and SD are both playing.",
    "No. Both tracks, BD and SD, are unmuted and nothing is soloed.",
    "What's playing: the BD on every beat and the SD on 2 and 4. Nothing is muted.",
  ])("passes a reply about the tracks the song has: %s", (reply) => {
    expect(checkNoAbsentTrack(reply, CLOSED_HAT).status).toBe("pass");
  });

  it("passes when the case names no track it lacks", () => {
    expect(checkNoAbsentTrack("The closed hat is muted.").status).toBe("pass");
  });
});

describe("the reply checks", () => {
  it("run by their IDs, and are known as reply checks", () => {
    expect(REPLY_CHECK_IDS.every(isReplyCheck)).toBe(true);
    expect(isReplyCheck("endsAt")).toBe(false);
    expect(runReplyCheck("noDeniedTrack", "There's no snare.", SNARE).status).toBe(
      "fail",
    );
    expect(runReplyCheck("noAbsentTrack", "The hats are in.", CLOSED_HAT).status).toBe(
      "fail",
    );
  });
});
