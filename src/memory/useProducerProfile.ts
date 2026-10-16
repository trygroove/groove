/**
 * One producer's profile, loaded for whoever is signed in and saved whole
 * (GRV-25): what the editor's memory cards and the Memory page read and
 * change. Changes run one at a time, and each reads the stored profile again
 * just before it applies, so two in flight together never lose one another,
 * and neither does a change made elsewhere (the Memory page in another tab
 * forgetting everything) get written back over by this page's older copy.
 * None runs until the profile has loaded, and none saves when its read
 * fails, so a change can never write an empty profile over one that could
 * not be read.
 */
import { type Accessor, createEffect, createSignal } from "solid-js";
import { emptyProfile, type ProducerProfile } from "../persistence/profileDocuments";
import type { ProfileRepository } from "../persistence/profileRepository";
import { getProfileRepository } from "../profileRepositoryClient";
import { type Clock, systemClock } from "../shared/clock";

export interface ProducerProfileStore {
  /** The profile, or null before it loads (or for someone with none yet). */
  readonly profile: Accessor<ProducerProfile | null>;
  /** Whether the first read has finished, either way. */
  readonly loaded: Accessor<boolean>;
  /** Whether the first read failed. */
  readonly failed: Accessor<boolean>;
  /** The profile as it stands now, past any change not yet drawn. */
  current(): ProducerProfile | null;
  /**
   * Saves `change` applied to the stored profile, read again once any
   * change already on its way has settled (an empty profile for someone
   * with none). Resolves with the saved profile, or null when nothing
   * changed: the read or the save failed, `change` threw, or the profile has
   * not loaded, or failed to.
   */
  update(
    change: (profile: ProducerProfile) => ProducerProfile,
  ): Promise<ProducerProfile | null>;
}

export interface UseProducerProfileOptions {
  readonly uid: Accessor<string | null>;
  readonly repository?: () => Promise<ProfileRepository>;
  readonly clock?: Clock;
}

export function useProducerProfile(
  options: UseProducerProfileOptions,
): ProducerProfileStore {
  const repository = options.repository ?? getProfileRepository;
  const clock = options.clock ?? systemClock;
  const [profile, setProfile] = createSignal<ProducerProfile | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  // A plain copy: Solid 2 batches writes, so a read straight after one would
  // still see the profile from before it.
  let now: ProducerProfile | null = null;
  let owner: string | null = null;
  /** Whether `now` is the stored profile: the load finished and succeeded. */
  let ready = false;
  /** Bumped on every sign-in change, so a change queued before it lapses. */
  let generation = 0;
  /** The last change queued: the next one waits for it to settle. */
  let queue: Promise<unknown> = Promise.resolve();

  createEffect(
    () => options.uid(),
    (uid) => {
      owner = uid;
      now = null;
      ready = false;
      generation += 1;
      setProfile(null);
      setLoaded(false);
      setFailed(false);
      if (!uid) return;
      let cancelled = false;
      repository()
        .then((store) => store.loadProfile(uid))
        .then(
          (result) => {
            if (cancelled) return;
            if (result.ok) {
              now = result.profile;
              ready = true;
              setProfile(result.profile);
            } else {
              setFailed(true);
            }
            setLoaded(true);
          },
          () => {
            if (cancelled) return;
            setFailed(true);
            setLoaded(true);
          },
        );
      return () => {
        cancelled = true;
      };
    },
  );

  async function apply(
    uid: string,
    since: number,
    change: (current: ProducerProfile) => ProducerProfile,
  ): Promise<ProducerProfile | null> {
    if (!ready || since !== generation) return null;
    try {
      const store = await repository();
      // The copy here may be stale: another page may have saved since.
      const fresh = await store.loadProfile(uid);
      if (!fresh.ok || since !== generation) return null;
      const next = change(fresh.profile ?? emptyProfile(clock.now()));
      const result = await store.saveProfile(uid, next);
      if (!result.ok || since !== generation) return null;
      now = result.profile;
      setProfile(result.profile);
      return result.profile;
    } catch {
      return null;
    }
  }

  function update(
    change: (current: ProducerProfile) => ProducerProfile,
  ): Promise<ProducerProfile | null> {
    const uid = owner;
    if (!uid || !ready) return Promise.resolve(null);
    const since = generation;
    const run = queue.then(() => apply(uid, since, change));
    // A change that throws rejects its own caller only, never the ones after.
    queue = run.catch(() => null);
    return run;
  }

  return { profile, loaded, failed, current: () => now, update };
}
