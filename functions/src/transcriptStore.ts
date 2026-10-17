/**
 * The assistant's transcript store over Firestore, with the admin credential
 * (GRV-8). `src/assistant/transcripts.ts` owns the paths, the shapes and the
 * rules; this only connects them to documents. Runs the same contract suite
 * as the in-memory store, against the emulator
 * (`tests/emulator/assistantTranscripts.emulator.test.ts`).
 *
 * Each read-then-write runs in one transaction, which locks the preference
 * document it read: an opt-out cannot land between a turn reading "yes" and
 * that turn's record being written.
 */
import type { Firestore, Query } from "firebase-admin/firestore";
import {
  ASSISTANT_TRANSCRIPTS_COLLECTION,
  MAX_OUTCOMES,
  preferenceDocPath,
  type TranscriptRecord,
  type TranscriptStore,
  transcriptDocPath,
} from "../../src/assistant/transcripts";

/**
 * The most records a filtered listing reads before sorting them newest first
 * (GRV-98). A filter on one field and an order on another would need a
 * composite index; an account's or a project's records within the 30-day
 * window are few enough to sort here instead.
 */
const FILTERED_READ_LIMIT = 1_000;

/** Documents deleted per batch; Firestore takes at most 500 writes in one. */
const DELETE_PAGE = 400;

async function deleteAll(db: Firestore, query: Query): Promise<number> {
  let deleted = 0;
  while (true) {
    const page = await query.limit(DELETE_PAGE).get();
    if (page.empty) return deleted;
    const batch = db.batch();
    for (const doc of page.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += page.size;
    if (page.size < DELETE_PAGE) return deleted;
  }
}

export function firestoreTranscriptStore(db: Firestore): TranscriptStore {
  const transcripts = db.collection(ASSISTANT_TRANSCRIPTS_COLLECTION);
  return {
    async preference(uid) {
      const snapshot = await db.doc(preferenceDocPath(uid)).get();
      return snapshot.exists ? snapshot.data() : null;
    },
    async setPreference(uid, preference) {
      await db.doc(preferenceDocPath(uid)).set({ ...preference });
    },
    writeIfPermitted(record, permits) {
      const preference = db.doc(preferenceDocPath(record.uid));
      const ref = db.doc(transcriptDocPath(record.uid, record.turnId));
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(preference);
        if (!permits(snapshot.exists ? snapshot.data() : null)) return false;
        tx.set(ref, record);
        return true;
      });
    },
    addOutcomeIfPermitted(uid, turnId, outcome, permits) {
      const preference = db.doc(preferenceDocPath(uid));
      const ref = db.doc(transcriptDocPath(uid, turnId));
      return db.runTransaction(async (tx) => {
        const [prefSnapshot, recordSnapshot] = await Promise.all([
          tx.get(preference),
          tx.get(ref),
        ]);
        if (!permits(prefSnapshot.exists ? prefSnapshot.data() : null)) return false;
        if (!recordSnapshot.exists) return false;
        const record = recordSnapshot.data() as TranscriptRecord;
        if (record.uid !== uid || record.outcomes.length >= MAX_OUTCOMES) return false;
        tx.update(ref, { outcomes: [...record.outcomes, outcome] });
        return true;
      });
    },
    setRatingIfPermitted(uid, turnId, rating, permits) {
      const preference = db.doc(preferenceDocPath(uid));
      const ref = db.doc(transcriptDocPath(uid, turnId));
      return db.runTransaction(async (tx) => {
        const [prefSnapshot, recordSnapshot] = await Promise.all([
          tx.get(preference),
          tx.get(ref),
        ]);
        if (!permits(prefSnapshot.exists ? prefSnapshot.data() : null)) return false;
        if (!recordSnapshot.exists) return false;
        const record = recordSnapshot.data() as TranscriptRecord;
        if (record.uid !== uid) return false;
        tx.update(ref, { rating });
        return true;
      });
    },
    async recent(filter, limit) {
      if (filter.uid === undefined && filter.projectId === undefined) {
        const page = await transcripts.orderBy("createdAt", "desc").limit(limit).get();
        return page.docs.map((doc) => doc.data());
      }
      let query: Query = transcripts;
      if (filter.uid !== undefined) query = query.where("uid", "==", filter.uid);
      if (filter.projectId !== undefined) {
        query = query.where("projectId", "==", filter.projectId);
      }
      const page = await query.limit(FILTERED_READ_LIMIT).get();
      return page.docs
        .map((doc) => doc.data())
        .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
        .slice(0, limit);
    },
    async read(uid, turnId) {
      const snapshot = await db.doc(transcriptDocPath(uid, turnId)).get();
      return snapshot.exists ? snapshot.data() : null;
    },
    deleteForUser: (uid) => deleteAll(db, transcripts.where("uid", "==", uid)),
    deleteForProject: (projectId) =>
      deleteAll(db, transcripts.where("projectId", "==", projectId)),
    deleteExpired: (now) => deleteAll(db, transcripts.where("expiresAt", "<=", now)),
    async deletePreference(uid) {
      await db.doc(preferenceDocPath(uid)).delete();
    },
  };
}
