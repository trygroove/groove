/**
 * The lesson record of the project open in the editor (GRV-190): read once
 * per account and project, and written on every transition of the lesson, so
 * a reload, another tab or another device brings the lesson back at the same
 * step. Writes run one at a time, each over the record as the last one left
 * it, and none runs before the first read has finished, so a lesson started
 * while the record is still loading is written over what was stored, never
 * the stored record over it. When the read fails nothing is written: a
 * record that could not be read is never replaced with an empty one.
 *
 * As a bite finishes, the profile's `lessonsDone` is written as well, derived
 * from the record's finished bites (`withLessonsDone`): the list across
 * projects that the Lessons list and onboarding read. Nothing reads it to
 * find where a lesson is.
 */
import { type Accessor, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { getLessonRepository } from "../../lessonRepositoryClient";
import type { BiteEnding, BiteId } from "../../lessons/ids";
import {
  doneBites,
  finishedBites,
  recordWith,
  withLessonsDone,
} from "../../lessons/record";
import type { LessonState } from "../../lessons/session";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import { emptyLessonRecord, type LessonRecord } from "../../persistence/lessonDocuments";
import type { LessonRepository } from "../../persistence/lessonRepository";
import { type Clock, systemClock } from "../../shared/clock";

/** Whose record, for which project; null while there is no one or no project. */
export interface LessonRecordOwner {
  readonly uid: string;
  readonly projectId: string;
}

export interface UseLessonRecordOptions {
  readonly owner: Accessor<LessonRecordOwner | null>;
  readonly repository?: () => Promise<LessonRepository>;
  /** Where the derived `lessonsDone` is written. */
  readonly profile?: ProducerProfileStore;
  readonly clock?: Clock;
}

/** The record as it was read for one owner. */
export interface LoadedLessonRecord {
  /** Which owner it was read for, as `uid|projectId`. */
  readonly key: string;
  readonly record: LessonRecord;
}

export interface LessonRecordStore {
  /** The record as read, once the first read for the owner succeeded. */
  readonly loaded: Accessor<LoadedLessonRecord | null>;
  /**
   * Whether the first read for the owner is over, whether or not it worked
   * (true at once with no owner): until then `current()` is only the empty
   * record, so nothing should start a lesson from it.
   */
  readonly settled: Accessor<boolean>;
  /** The record as it stands now, past any write not yet stored. */
  current(): LessonRecord;
  /** How each bite finished in this project ended, skipped ones included. */
  readonly finished: Accessor<Partial<Record<BiteId, BiteEnding>>>;
  /** The bites done in this project, by the producer or by Show me. */
  readonly done: Accessor<readonly BiteId[]>;
  /**
   * Writes the lesson under way (`null` once it ended or was left) and, when
   * a bite just finished, that bite and how.
   */
  save(
    state: LessonState | null,
    finished?: { readonly biteId: BiteId; readonly how: BiteEnding },
  ): void;
}

export function useLessonRecord(options: UseLessonRecordOptions): LessonRecordStore {
  const repository = options.repository ?? getLessonRepository;
  const clock = options.clock ?? systemClock;
  const keyOf = (next: LessonRecordOwner | null) =>
    next ? `${next.uid}|${next.projectId}` : null;
  const [loaded, setLoaded] = createSignal<LoadedLessonRecord | null>(null);
  const [settled, setSettled] = createSignal(keyOf(untrack(options.owner)) === null);
  const [shown, setShown] = createSignal<LessonRecord>(emptyLessonRecord());
  // A plain copy: Solid 2 batches writes, and the next write must see the last.
  let latest: LessonRecord = emptyLessonRecord();
  /** Whether this owner's record was written to before its read came back. */
  let dirty = false;
  let owner: LessonRecordOwner | null = null;
  /** Settles once the read for `owner` has; whether writes may be stored. */
  let ready: Promise<boolean> = Promise.resolve(false);
  /** The last write queued: the next waits for it. */
  let queue: Promise<unknown> = Promise.resolve();
  let generation = 0;

  function set(next: LessonRecord): void {
    latest = next;
    setShown(next);
  }

  /** Stores the record as it stands once the write before has settled. */
  function store(since: number): void {
    queue = queue
      .then(async () => {
        const target = owner;
        if (!(await ready) || since !== generation || !target) return;
        const repo = await repository();
        await repo.saveRecord(target.uid, target.projectId, latest);
      })
      .catch(() => undefined);
  }

  let openKey: string | null = null;

  /**
   * Starts over for `next`: nothing written, and its record read. The first
   * owner starts from the signals' own empty values, as the hook is made.
   */
  function open(next: LessonRecordOwner | null, first = false): void {
    const key = keyOf(next);
    openKey = key;
    generation += 1;
    const since = generation;
    owner = next;
    dirty = false;
    if (!first) {
      set(emptyLessonRecord());
      setLoaded(null);
      setSettled(!key);
    }
    if (!key || !next) {
      ready = Promise.resolve(false);
      return;
    }
    ready = repository()
      .then((repo) => repo.loadRecord(next.uid, next.projectId))
      .then(
        (result) => {
          if (since !== generation) return false;
          setSettled(true);
          if (!result.ok) return false;
          const stored = result.record ?? emptyLessonRecord();
          // What this page wrote meanwhile goes over what was stored.
          set(
            dirty
              ? {
                  underWay: latest.underWay,
                  finished: { ...stored.finished, ...latest.finished },
                  updatedAt: latest.updatedAt,
                }
              : stored,
          );
          setLoaded({ key, record: stored });
          return true;
        },
        () => {
          if (since === generation) setSettled(true);
          return false;
        },
      );
  }

  // The owner is known from the start, so a lesson started straight away is
  // kept; a change of account or project starts over.
  open(untrack(options.owner), true);
  createEffect(
    () => keyOf(options.owner()),
    (key) => {
      if (key !== openKey) open(untrack(options.owner));
    },
  );

  function save(
    state: LessonState | null,
    finished?: { readonly biteId: BiteId; readonly how: BiteEnding },
  ): void {
    dirty = true;
    set(recordWith(latest, state, clock.now(), finished));
    store(generation);
    if (!finished || finished.how === "skipped" || !owner) return;
    const record = latest;
    void options.profile?.update((profile) => ({
      ...profile,
      lessonsDone: withLessonsDone(profile.lessonsDone, record),
    }));
  }

  const finished = createMemo(() => finishedBites(shown()));
  const done = createMemo(() => doneBites(shown()));
  return { loaded, settled, current: () => latest, finished, done, save };
}
