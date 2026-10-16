import { describe, expect, it } from "vitest";
import { emptyProfile, type ProducerProfile } from "../persistence/profileDocuments";
import { localDay, nudgeDue, nudgeLesson } from "./nudge";

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

describe("Cue's daily nudge (GRV-25)", () => {
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

  it("offers the first lesson the goal suggests", () => {
    const profile = onboarded(1, {
      memory: { ...emptyProfile(1).memory, goal: "sound_design" },
    });
    expect(nudgeLesson(profile)).toBe("Shape a sound from scratch");
  });
});
