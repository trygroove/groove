import { describe, expect, it } from "vitest";
import { BITE_IDS } from "../lessons/ids";
import { emptyProfile, type ProducerProfile } from "../persistence/profileDocuments";
import { localDay, nudgeBite, nudgeDue, nudgeWords } from "./nudge";

const DAY = 86_400_000;
const NOON = new Date(2026, 9, 11, 12).getTime();

const onboarded = (
  at: number,
  extra: Partial<ProducerProfile> = {},
): ProducerProfile => ({
  ...emptyProfile(at),
  onboarding: "completed",
  onboardedAt: at,
  ...extra,
});

describe("Coproducer's daily nudge (GRV-25)", () => {
  it("names the local day", () => {
    expect(localDay(NOON)).toBe("2026-10-11");
  });

  it("waits until the day after onboarding", () => {
    expect(nudgeDue(onboarded(NOON - 60_000), NOON)).toBe(false);
    expect(nudgeDue(onboarded(NOON - DAY), NOON)).toBe(true);
  });

  it("nudges at most once a day", () => {
    expect(nudgeDue(onboarded(NOON - DAY, { lastNudgeDay: "2026-10-11" }), NOON)).toBe(
      false,
    );
    expect(nudgeDue(onboarded(NOON - DAY, { lastNudgeDay: "2026-10-10" }), NOON)).toBe(
      true,
    );
  });

  it("never nudges someone who has not been through onboarding", () => {
    expect(nudgeDue(null, NOON)).toBe(false);
    expect(nudgeDue(emptyProfile(NOON - 5 * DAY), NOON)).toBe(false);
  });

  it("offers the next bite not yet done, from the chapter the goal suggests (GRV-43)", () => {
    const profile = onboarded(1, {
      memory: { ...emptyProfile(1).memory, goal: "sound_design" },
    });
    expect(nudgeBite(profile)?.title).toBe("Pick a wave");
    expect(nudgeBite({ ...profile, lessonsDone: ["sound-wave"] })?.title).toBe(
      "Darken it",
    );
    expect(nudgeBite({ ...profile, lessonsDone: [...BITE_IDS] })).toBeNull();
  });
});

describe("the nudge for Finish a track (GRV-44)", () => {
  it("offers to pick it up at the chapter it was left in, while it is under way", () => {
    const profile = onboarded(NOON - DAY, {
      lessonsDone: ["bass-key", "bass-line", "bass-sound", "chords-loop"],
    });
    const offered = nudgeBite(profile);
    expect(offered?.id).toBe("chords-hook");
    if (!offered) throw new Error("nothing offered");
    expect(nudgeWords(offered)).toBe(
      'Pick up chapter 3 of "Finish a track", "Chords and hook"?',
    );
  });

  it("offers a bite as before when it is not under way", () => {
    const offered = nudgeBite(onboarded(NOON - DAY));
    if (!offered) throw new Error("nothing offered");
    expect(nudgeWords(offered)).toBe(`Want to try "${offered.title}"?`);
  });
});
