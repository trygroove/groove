/**
 * What Groove does with an account's retention answer (GRV-8): keeps a
 * completed turn unless the account said no (GRV-97: keeping is the
 * default), adds a proposal's outcome to
 * it, deletes everything on a no, and answers the `assistantRetention`
 * callable. Firebase-free, over a {@link TranscriptStore}; the Cloud Functions
 * (`functions/src/retentionHandler.ts`, `functions/src/index.ts`) supply the
 * Firestore store, and the mock backend an in-memory one.
 *
 * Nothing here logs or reports what a transcript says. Keeping one is never
 * allowed to fail the turn it records: the assistant behaves the same whether
 * or not anything is kept.
 */
import { z } from "zod";
import {
  ASSISTANT_DISCLOSURE_VERSION,
  type CompletedTurn,
  checkTranscriptRecord,
  PROPOSAL_OUTCOMES,
  type ProposalOutcome,
  permitsRetention,
  type RetentionPreference,
  readPreference,
  sessionIdSchema,
  TRANSCRIPT_RETENTION_DAYS,
  type TranscriptStore,
  transcriptRecordFor,
} from "./transcripts";

/** How one attempt to keep a turn went. Never the turn's content. */
export type TranscriptWrite =
  /** Kept. */
  | "kept"
  /** The account has said no. */
  | "not_permitted"
  /** The record failed {@link checkTranscriptRecord}: it carried something forbidden. */
  | "refused"
  /** The store failed; nothing was kept. */
  | "failed";

/**
 * Keeps a completed turn unless the account's stored preference declines it
 * at the moment of writing ({@link permitsRetention}). A preference the store
 * cannot read keeps nothing. Never throws.
 */
export async function recordTurn(
  store: TranscriptStore,
  turn: CompletedTurn,
): Promise<TranscriptWrite> {
  const check = checkTranscriptRecord(transcriptRecordFor(turn));
  if (!check.ok) return "refused";
  try {
    return (await store.writeIfPermitted(check.record, permitsRetention))
      ? "kept"
      : "not_permitted";
  } catch {
    return "failed";
  }
}

/**
 * Stores the account's answer. A no also deletes every transcript the account
 * has: the preference is written first, so no turn can be kept after the
 * deletion runs, and any kept before it goes with the rest.
 */
export async function setRetention(
  store: TranscriptStore,
  uid: string,
  retain: boolean,
  now: number,
): Promise<RetentionPreference> {
  const preference: RetentionPreference = {
    schemaVersion: 1,
    retain,
    disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
    answeredAt: now,
  };
  await store.setPreference(uid, preference);
  if (!retain) await store.deleteForUser(uid);
  return preference;
}

/** Adds what became of a proposal to its kept turn, if there is one to add to. */
export async function recordOutcome(
  store: TranscriptStore,
  uid: string,
  turnId: string,
  outcome: ProposalOutcome,
  now: number,
): Promise<boolean> {
  try {
    return await store.addOutcomeIfPermitted(
      uid,
      turnId,
      { outcome, at: now },
      permitsRetention,
    );
  } catch {
    return false;
  }
}

/** The callable's name, as the browser calls it. */
export const ASSISTANT_RETENTION_CALLABLE = "assistantRetention";

export const retentionRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("get") }),
  z.strictObject({
    op: z.literal("set"),
    retain: z.boolean(),
    /** The disclosure the answer was given against; must be the current one. */
    disclosureVersion: z.int().min(1),
  }),
  z.strictObject({
    op: z.literal("outcome"),
    turnId: sessionIdSchema,
    outcome: z.enum(PROPOSAL_OUTCOMES),
  }),
]);
export type RetentionRequest = z.infer<typeof retentionRequestSchema>;

/** What `get` and `set` answer. */
export interface RetentionState {
  /** The account's answer, or `null` if it has not given one. */
  readonly preference: RetentionPreference | null;
  /** The disclosure an answer must be given against to count. */
  readonly disclosureVersion: number;
  readonly retentionDays: number;
}

export type RetentionResponse = RetentionState | { readonly recorded: boolean };

export const RETENTION_ERROR_CODES = [
  "unauthenticated",
  "invalid_request",
  "stale_disclosure",
] as const;
export type RetentionErrorCode = (typeof RETENTION_ERROR_CODES)[number];

export class RetentionRequestError extends Error {
  readonly code: RetentionErrorCode;
  constructor(code: RetentionErrorCode, message: string) {
    super(message);
    this.name = "RetentionRequestError";
    this.code = code;
  }
}

function stateOf(preference: RetentionPreference | null): RetentionState {
  return {
    preference,
    disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
    retentionDays: TRANSCRIPT_RETENTION_DAYS,
  };
}

/**
 * One `assistantRetention` call. Any signed-in identity may answer, a guest
 * included, so an answer given before linking an account is still there
 * after (linking keeps the uid).
 */
export async function handleRetentionRequest(
  store: TranscriptStore,
  uid: string | null,
  raw: unknown,
  now: number,
): Promise<RetentionResponse> {
  if (!uid) throw new RetentionRequestError("unauthenticated", "Sign in first.");
  const parsed = retentionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RetentionRequestError("invalid_request", "The request was not valid.");
  }
  const request = parsed.data;
  switch (request.op) {
    case "get":
      return stateOf(readPreference(await store.preference(uid)));
    case "set":
      if (request.disclosureVersion !== ASSISTANT_DISCLOSURE_VERSION) {
        throw new RetentionRequestError(
          "stale_disclosure",
          "The disclosure has changed. Read it again before answering.",
        );
      }
      return stateOf(await setRetention(store, uid, request.retain, now));
    case "outcome":
      return {
        recorded: await recordOutcome(store, uid, request.turnId, request.outcome, now),
      };
  }
}
