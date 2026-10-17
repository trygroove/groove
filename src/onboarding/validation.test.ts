import { describe, expect, it } from "vitest";
import { EMPTY_MEMORY, type ProducerMemory } from "../persistence/profileDocuments";
import { logValidation } from "./validation";

const MEMORY: ProducerMemory = {
  ...EMPTY_MEMORY,
  taste: ["Techno"],
  artists: "Four Tet",
  experience: "finished_a_few",
  goal: "first_track",
  learn: ["Drums and beats", "Something I typed"],
  gear: ["Ableton Move", "A synth"],
};

function recorder() {
  const logged: { name: string; params: Record<string, unknown> }[] = [];
  return {
    logged,
    analytics: {
      log: (name: string, params: Record<string, unknown>) => {
        logged.push({ name, params });
      },
    } as unknown as Parameters<typeof logValidation>[0],
  };
}

describe("the consented validation event (GRV-25)", () => {
  it("logs nothing without consent", () => {
    const { logged, analytics } = recorder();
    expect(logValidation(analytics, { memory: MEMORY, validationConsent: false })).toBe(
      false,
    );
    expect(logged).toEqual([]);
  });

  it("logs the fixed choices, and only those, with consent", () => {
    const { logged, analytics } = recorder();
    expect(logValidation(analytics, { memory: MEMORY, validationConsent: true })).toBe(
      true,
    );
    expect(logged).toEqual([
      {
        name: "onboarding_validation",
        params: { experience: "finished_a_few", goal: "first_track" },
      },
      { name: "onboarding_validation_chip", params: { group: "learn", chip: "drums" } },
      {
        name: "onboarding_validation_chip",
        params: { group: "gear", chip: "ableton_move" },
      },
      { name: "onboarding_validation_chip", params: { group: "gear", chip: "synth" } },
    ]);
    const sent = JSON.stringify(logged);
    expect(sent).not.toContain("Four Tet");
    expect(sent).not.toContain("Techno");
    expect(sent).not.toContain("Something I typed");
  });
});
