import { createRoot, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryProfileRepository } from "../persistence/inMemoryProfileRepository";
import {
  EMPTY_MEMORY,
  emptyProfile,
  type MemoryNote,
  type ProducerProfile,
} from "../persistence/profileDocuments";
import { profileFailure } from "../persistence/profileRepository";
import { type ProducerProfileStore, useProducerProfile } from "./useProducerProfile";

const UID = "user-1";
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
});

function open(profiles: InMemoryProfileRepository): ProducerProfileStore {
  const store = createRoot((disposeRoot) => {
    disposers.push(disposeRoot);
    return useProducerProfile({
      uid: () => UID,
      repository: () => Promise.resolve(profiles),
    });
  });
  flush();
  return store;
}

async function loaded(store: ProducerProfileStore): Promise<void> {
  await vi.waitFor(() => {
    flush();
    expect(store.loaded()).toBe(true);
  });
}

const note = (id: string, text: string): MemoryNote => ({ id, text, createdAt: 1 });
const remember =
  (added: MemoryNote) =>
  (profile: ProducerProfile): ProducerProfile => ({
    ...profile,
    notes: [...profile.notes, added],
  });

describe("useProducerProfile (GRV-25)", () => {
  it("keeps both of two changes made while the first is still saving", async () => {
    const profiles = new InMemoryProfileRepository();
    await profiles.saveProfile(UID, { ...emptyProfile(1), onboarding: "completed" });
    const store = open(profiles);
    await loaded(store);

    const [first, second] = await Promise.all([
      store.update(remember(note("n1", "Likes swung hats"))),
      store.update(remember(note("n2", "Works in D minor"))),
    ]);

    expect(first?.notes.map(({ id }) => id)).toEqual(["n1"]);
    expect(second?.notes.map(({ id }) => id)).toEqual(["n1", "n2"]);
    const stored = await profiles.loadProfile(UID);
    expect(stored.ok && stored.profile?.notes.map(({ id }) => id)).toEqual(["n1", "n2"]);
    expect(store.current()?.notes).toHaveLength(2);
  });

  it("carries on after a failed change, from the profile as last saved", async () => {
    const profiles = new InMemoryProfileRepository();
    await profiles.saveProfile(UID, emptyProfile(1));
    const store = open(profiles);
    await loaded(store);
    const save = profiles.saveProfile.bind(profiles);
    vi.spyOn(profiles, "saveProfile")
      .mockResolvedValueOnce(profileFailure("unavailable", "offline"))
      .mockImplementation(save);

    const [failed, kept] = await Promise.all([
      store.update(remember(note("n1", "Lost"))),
      store.update(remember(note("n2", "Kept"))),
    ]);

    expect(failed).toBeNull();
    expect(kept?.notes.map(({ id }) => id)).toEqual(["n2"]);
  });

  it("changes nothing before the profile has loaded", async () => {
    const profiles = new InMemoryProfileRepository();
    await profiles.saveProfile(UID, {
      ...emptyProfile(1),
      notes: [note("n0", "Already here")],
    });
    const store = open(profiles);
    const saveProfile = vi.spyOn(profiles, "saveProfile");

    expect(await store.update(remember(note("n1", "Too soon")))).toBeNull();
    expect(saveProfile).not.toHaveBeenCalled();
    await loaded(store);
    const stored = await profiles.loadProfile(UID);
    expect(stored.ok && stored.profile?.notes.map(({ id }) => id)).toEqual(["n0"]);
  });

  it("never writes an empty profile over one it could not read", async () => {
    const profiles = new InMemoryProfileRepository();
    vi.spyOn(profiles, "loadProfile").mockResolvedValue(
      profileFailure("unavailable", "offline"),
    );
    const saveProfile = vi.spyOn(profiles, "saveProfile");
    const store = open(profiles);
    await loaded(store);
    expect(store.failed()).toBe(true);

    expect(await store.update(remember(note("n1", "Would erase")))).toBeNull();
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it("starts from an empty profile for someone who has none yet", async () => {
    const profiles = new InMemoryProfileRepository();
    const store = open(profiles);
    await loaded(store);

    const saved = await store.update(remember(note("n1", "First note")));
    expect(saved?.notes.map(({ id }) => id)).toEqual(["n1"]);
  });

  it("never brings back what another open page forgot", async () => {
    const profiles = new InMemoryProfileRepository();
    await profiles.saveProfile(UID, {
      ...emptyProfile(1),
      onboarding: "completed",
      memory: { ...EMPTY_MEMORY, taste: ["House"] },
      notes: [note("n0", "Likes swung hats")],
    });
    // The editor and the Memory page, each with its own copy.
    const editor = open(profiles);
    const memoryPage = open(profiles);
    await loaded(editor);
    await loaded(memoryPage);

    await memoryPage.update((profile) => ({
      ...profile,
      memory: EMPTY_MEMORY,
      notes: [],
    }));
    const confirmed = await editor.update(remember(note("n1", "Works in D minor")));

    expect(confirmed?.notes.map(({ id }) => id)).toEqual(["n1"]);
    const stored = await profiles.loadProfile(UID);
    expect(stored.ok && stored.profile).toMatchObject({
      memory: { taste: [] },
      notes: [{ id: "n1" }],
    });
  });

  it("saves nothing when the profile cannot be read again", async () => {
    const profiles = new InMemoryProfileRepository();
    await profiles.saveProfile(UID, emptyProfile(1));
    const store = open(profiles);
    await loaded(store);
    vi.spyOn(profiles, "loadProfile").mockResolvedValue(
      profileFailure("unavailable", "offline"),
    );
    const saveProfile = vi.spyOn(profiles, "saveProfile");

    expect(await store.update(remember(note("n1", "Offline")))).toBeNull();
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it("carries on after a change that throws", async () => {
    const profiles = new InMemoryProfileRepository();
    await profiles.saveProfile(UID, emptyProfile(1));
    const store = open(profiles);
    await loaded(store);

    const thrown = store.update(() => {
      throw new Error("bad change");
    });
    const kept = store.update(remember(note("n2", "Kept")));

    expect(await thrown).toBeNull();
    expect((await kept)?.notes.map(({ id }) => id)).toEqual(["n2"]);
  });
});
