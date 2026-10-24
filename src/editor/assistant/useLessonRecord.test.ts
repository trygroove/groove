import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import { InMemoryLessonRepository } from "../../persistence/inMemoryLessonRepository";
import { emptyLessonRecord } from "../../persistence/lessonDocuments";
import {
  type LessonRecordFailure,
  type LessonRepository,
  lessonRecordFailure,
} from "../../persistence/lessonRepository";
import { emptyProfile, type ProducerProfile } from "../../persistence/profileDocuments";
import { createManualClock } from "../../shared/clock";
import { startedAt, starterWorld } from "../../testing/lessonWorld";
import { type LessonRecordOwner, useLessonRecord } from "./useLessonRecord";

const settings = { style: "boom_bap" } as const;
const ME = { uid: "user_1", projectId: "prj_1" };

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
  }
}

function profileStore(): ProducerProfileStore {
  const [profile, setProfile] = createSignal<ProducerProfile | null>(emptyProfile(0));
  return {
    profile,
    loaded: () => true,
    failed: () => false,
    current: profile,
    async update(change) {
      const next = change(profile() ?? emptyProfile(0));
      setProfile(next);
      return next;
    },
  };
}

function setup(repository: LessonRepository, owner: LessonRecordOwner | null = ME) {
  const [who, setWho] = createSignal<LessonRecordOwner | null>(owner);
  const profile = profileStore();
  const record = createRoot(() =>
    useLessonRecord({
      owner: who,
      repository: async () => repository,
      profile,
      clock: createManualClock(50),
    }),
  );
  return { record, profile, setWho };
}

describe("the project's lesson record in the editor (GRV-190)", () => {
  it("reads the record once, and writes each transition over it", async () => {
    const repository = new InMemoryLessonRepository({ clock: createManualClock(1) });
    await repository.saveRecord(ME.uid, ME.projectId, {
      ...emptyLessonRecord(),
      finished: { "beat-kick": { how: "did_it", at: 1 } },
    });
    const h = setup(repository);
    await settle();
    expect(h.record.loaded()?.record.finished).toHaveProperty("beat-kick");
    const { state } = startedAt("tour", "tour-mixer", starterWorld(), settings);
    h.record.save(null, { biteId: "tour-mixer", how: "show_me" });
    expect(h.record.current().finished).toHaveProperty("tour-mixer");
    await settle();
    const stored = await repository.loadRecord(ME.uid, ME.projectId);
    expect(stored.ok && stored.record?.finished).toEqual({
      "beat-kick": { how: "did_it", at: 1 },
      "tour-mixer": { how: "show_me", at: 50 },
    });
    expect(h.record.done()).toEqual(["beat-kick", "tour-mixer"]);
    expect(h.profile.profile()?.lessonsDone).toEqual(["beat-kick", "tour-mixer"]);
    h.record.save(state);
    await settle();
    const again = await repository.loadRecord(ME.uid, ME.projectId);
    expect(again.ok && again.record?.underWay?.biteId).toBe("tour-mixer");
  });

  it("writes nothing over a record it could not read", async () => {
    const saved: unknown[] = [];
    const failing: LessonRepository = {
      async loadRecord(): Promise<LessonRecordFailure> {
        return lessonRecordFailure("unavailable", "offline");
      },
      async saveRecord(_uid, _project, record) {
        saved.push(record);
        return { ok: true, record };
      },
    };
    const h = setup(failing);
    await settle();
    h.record.save(null, { biteId: "tour-mixer", how: "did_it" });
    await settle();
    expect(saved).toEqual([]);
    expect(h.record.loaded()).toBeNull();
    // The read is over, though it failed: a lesson may start, from nothing.
    expect(h.record.settled()).toBe(true);
  });

  it("says when the first read for an owner is over, and again for the next", async () => {
    const repository = new InMemoryLessonRepository();
    const h = setup(repository);
    expect(h.record.settled()).toBe(false);
    await settle();
    expect(h.record.settled()).toBe(true);
    h.setWho({ uid: "user_1", projectId: "prj_2" });
    flush();
    expect(h.record.settled()).toBe(false);
    await settle();
    expect(h.record.settled()).toBe(true);
    h.setWho(null);
    flush();
    expect(h.record.settled()).toBe(true);
    expect(setup(repository, null).record.settled()).toBe(true);
  });

  it("keeps nothing without an owner, and starts over for another project", async () => {
    const repository = new InMemoryLessonRepository();
    const h = setup(repository, null);
    h.record.save(null, { biteId: "tour-mixer", how: "did_it" });
    await settle();
    expect(repository.writes).toEqual([]);
    h.setWho(ME);
    await settle();
    expect(h.record.loaded()?.key).toBe("user_1|prj_1");
    expect(h.record.finished()).toEqual({});
  });
});
