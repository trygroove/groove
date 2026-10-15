/**
 * {@link TranscriptStore} in memory (GRV-8): for unit tests, and for the mock
 * backend, which runs the gateway in the page. Satisfies the same contract
 * suite (`transcriptStoreContract.ts`) as the Firestore store the Cloud
 * Functions use (`functions/src/transcriptStore.ts`).
 */
import type {
  RetentionPreference,
  TranscriptRecord,
  TranscriptStore,
} from "./transcripts";
import { MAX_OUTCOMES, transcriptExpired } from "./transcripts";

export interface InMemoryTranscriptStore extends TranscriptStore {
  /** Every record held, for assertions. */
  records(): TranscriptRecord[];
  /** Makes the next preference read throw, as an unreachable store would. */
  failPreferenceReads(fail: boolean): void;
}

export function createInMemoryTranscriptStore(): InMemoryTranscriptStore {
  const records = new Map<string, TranscriptRecord>();
  const preferences = new Map<string, RetentionPreference>();
  let failReads = false;
  // Serialises every operation the way a transaction would.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => T): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };
  const key = (uid: string, turnId: string) => `${uid}_${turnId}`;
  const readPreference = (uid: string) => {
    if (failReads) throw new Error("preference unreadable");
    return preferences.get(uid) ?? null;
  };
  const deleteWhere = (match: (record: TranscriptRecord) => boolean) =>
    serial(() => {
      let deleted = 0;
      for (const [id, record] of records) {
        if (match(record)) {
          records.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    });

  return {
    records: () => [...records.values()].map((record) => structuredClone(record)),
    failPreferenceReads(fail) {
      failReads = fail;
    },
    preference: (uid) => serial(() => readPreference(uid)),
    setPreference: (uid, preference) =>
      serial(() => {
        preferences.set(uid, { ...preference });
      }),
    writeIfPermitted: (record, permits) =>
      serial(() => {
        if (!permits(readPreference(record.uid))) return false;
        records.set(key(record.uid, record.turnId), structuredClone(record));
        return true;
      }),
    addOutcomeIfPermitted: (uid, turnId, outcome, permits) =>
      serial(() => {
        if (!permits(readPreference(uid))) return false;
        const record = records.get(key(uid, turnId));
        if (!record || record.uid !== uid || record.outcomes.length >= MAX_OUTCOMES) {
          return false;
        }
        records.set(key(uid, turnId), {
          ...record,
          outcomes: [...record.outcomes, outcome],
        });
        return true;
      }),
    recent: (filter, limit) =>
      serial(() =>
        [...records.values()]
          .filter(
            (record) =>
              (filter.uid === undefined || record.uid === filter.uid) &&
              (filter.projectId === undefined || record.projectId === filter.projectId),
          )
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit)
          .map((record) => structuredClone(record)),
      ),
    read: (uid, turnId) =>
      serial(() => {
        const record = records.get(key(uid, turnId));
        return record ? structuredClone(record) : null;
      }),
    deleteForUser: (uid) => deleteWhere((record) => record.uid === uid),
    deleteForProject: (projectId) =>
      deleteWhere((record) => record.projectId === projectId),
    deleteExpired: (now) => deleteWhere((record) => transcriptExpired(record, now)),
    deletePreference: (uid) =>
      serial(() => {
        preferences.delete(uid);
      }),
  };
}
