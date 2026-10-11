import { beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../domain/serialize";
import type { ManualClock } from "../shared/clock";
import {
  emptyProfile,
  MAX_MEMORY_NOTES,
  type ProducerProfile,
  profileDocumentPath,
} from "./profileDocuments";
import type { ProfileRepository } from "./profileRepository";

/**
 * The profile contract suite (GRV-25).
 *
 * The in-memory and Firestore stores both run it, so a component test that
 * saves a profile through the fake is evidence about the real backend.
 * Anything specific to one store (its write log, the security rules) lives in
 * that store's own suite.
 */

export const PROFILE_OWNER = "user_profile";
export const PROFILE_OTHER_OWNER = "user_other_profile";

/** A profile with every field filled in. */
export function filledProfile(now: number): ProducerProfile {
  return {
    onboarding: "completed",
    onboardedAt: now,
    memory: {
      taste: ["House", "Techno"],
      artists: "Floating Points, Four Tet",
      experience: "played_around",
      goal: "first_track",
      learn: ["Drums and beats", "Arranging a whole track"],
      gear: ["Ableton Move", "Roland T-8"],
    },
    notes: [{ id: "note-1", text: "Making more trap lately", createdAt: now }],
    laterQuestions: ["gear"],
    validationConsent: true,
    lastNudgeDay: "2026-10-10",
    modifiedAt: now,
  };
}

export interface ProfileContractHarness {
  /** A repository acting as `uid`, as a separately signed-in session. */
  repositoryFor(uid: string): ProfileRepository;
  readonly clock: ManualClock;
  reset(): Promise<void>;
  /** Writes a document verbatim, bypassing the repository and the rules. */
  seedStoredDocument(path: string, data: JsonObject): Promise<void>;
}

export function describeProfileRepositoryContract(
  label: string,
  createHarness: () => Promise<ProfileContractHarness> | ProfileContractHarness,
): void {
  describe(`${label}: ProfileRepository contract`, () => {
    let harness: ProfileContractHarness;
    let repository: ProfileRepository;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
      harness.clock.set(1_700_000_000_000);
      repository = harness.repositoryFor(PROFILE_OWNER);
    });

    it("has no profile for someone who never had one", async () => {
      expect(await repository.loadProfile(PROFILE_OWNER)).toEqual({
        ok: true,
        profile: null,
      });
    });

    it("round-trips every field, stamping when it was written", async () => {
      const profile = filledProfile(1_600_000_000_000);
      const saved = await repository.saveProfile(PROFILE_OWNER, profile);
      expect(saved).toEqual({
        ok: true,
        profile: { ...profile, modifiedAt: 1_700_000_000_000 },
      });

      const loaded = await harness
        .repositoryFor(PROFILE_OWNER)
        .loadProfile(PROFILE_OWNER);
      expect(loaded).toEqual({
        ok: true,
        profile: { ...profile, modifiedAt: 1_700_000_000_000 },
      });
    });

    it("round-trips an empty profile", async () => {
      await repository.saveProfile(PROFILE_OWNER, emptyProfile(0));
      expect(await repository.loadProfile(PROFILE_OWNER)).toEqual({
        ok: true,
        profile: emptyProfile(1_700_000_000_000),
      });
    });

    it("replaces the whole profile on a save", async () => {
      await repository.saveProfile(PROFILE_OWNER, filledProfile(1));
      await repository.saveProfile(PROFILE_OWNER, {
        ...filledProfile(1),
        notes: [],
        memory: { ...filledProfile(1).memory, gear: [] },
      });
      const loaded = await repository.loadProfile(PROFILE_OWNER);
      expect(loaded.ok && loaded.profile?.notes).toEqual([]);
      expect(loaded.ok && loaded.profile?.memory.gear).toEqual([]);
    });

    it("refuses a profile over the note cap and writes nothing", async () => {
      const notes = Array.from({ length: MAX_MEMORY_NOTES + 1 }, (_, index) => ({
        id: `note-${index}`,
        text: `Note ${index}`,
        createdAt: 1,
      }));
      const result = await repository.saveProfile(PROFILE_OWNER, {
        ...emptyProfile(1),
        notes,
      });
      expect(result).toMatchObject({ ok: false, reason: "invalid_profile" });
      expect(await repository.loadProfile(PROFILE_OWNER)).toEqual({
        ok: true,
        profile: null,
      });
    });

    it("reports a stored profile it cannot read, rather than a fresh one", async () => {
      await harness.seedStoredDocument(profileDocumentPath(PROFILE_OWNER), {
        schemaVersion: 99,
      });
      expect(await repository.loadProfile(PROFILE_OWNER)).toMatchObject({
        ok: false,
        reason: "unreadable",
      });
    });

    it("keeps each user's profile to themselves", async () => {
      await repository.saveProfile(PROFILE_OWNER, filledProfile(1));
      const other = harness.repositoryFor(PROFILE_OTHER_OWNER);
      expect(await other.loadProfile(PROFILE_OTHER_OWNER)).toEqual({
        ok: true,
        profile: null,
      });
    });
  });
}
