/**
 * Reading kept assistant transcripts, for admins (GRV-98): what the
 * `assistantTranscriptsAdmin` callable answers, so the team can see why a
 * proposal failed and how often.
 *
 * Only an account with the `admin` claim gets anything. `firestore.rules`
 * still denies every client the collection, admins included: this callable,
 * run with the admin credential, is the one way in, and it only reads.
 *
 * - `list`: the newest turns, as summaries (no tool inputs, the message cut
 *   short), narrowed by account, project, outcome, the producer's rating of
 *   the reply (GRV-103) and whether the turn was internal.
 * - `get`: one turn in full: the message, the reply, every tool call with its
 *   input, the outcomes and a rejection's issues.
 *
 * Firebase-free, over a {@link TranscriptStore}; the Cloud Function
 * (`functions/src/transcriptAdminHandler.ts`) supplies the Firestore store,
 * and the mock backend an in-memory one. Nothing here logs what a transcript
 * says.
 */
import { z } from "zod";
import {
  PROPOSAL_OUTCOMES,
  type ProposalOutcome,
  REPLY_RATINGS,
  type ReplyRating,
  sessionIdSchema,
  type TranscriptRecord,
  type TranscriptStore,
  transcriptRecordSchema,
} from "./transcripts";

/** The callable's name, as the browser calls it. */
export const TRANSCRIPT_ADMIN_CALLABLE = "assistantTranscriptsAdmin";

/** The most turns one listing returns. */
export const TRANSCRIPT_LIST_LIMIT = 100;

/**
 * How many of the newest records a listing reads before narrowing them by
 * outcome, rating and traffic, which the store cannot filter on.
 */
const TRANSCRIPT_SCAN_LIMIT = 500;

/** How much of the message a summary shows. */
export const SUMMARY_MESSAGE_CHARS = 140;

/** A turn's last outcome, or `none` while nothing became of it (no proposal, or undecided). */
export const TRANSCRIPT_OUTCOME_FILTERS = [...PROPOSAL_OUTCOMES, "none"] as const;
export type TranscriptOutcomeFilter = (typeof TRANSCRIPT_OUTCOME_FILTERS)[number];

const uidSchema = z.string().min(1).max(128);

export const transcriptAdminRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("list"),
    uid: uidSchema.optional(),
    projectId: z.string().min(1).max(64).optional(),
    outcome: z.enum(TRANSCRIPT_OUTCOME_FILTERS).optional(),
    /** Only turns whose reply the producer rated so (GRV-103). */
    rating: z.enum(REPLY_RATINGS).optional(),
    internal: z.boolean().optional(),
  }),
  z.strictObject({
    op: z.literal("get"),
    uid: uidSchema,
    turnId: sessionIdSchema,
  }),
]);
export type TranscriptAdminRequest = z.infer<typeof transcriptAdminRequestSchema>;

/** One turn in a listing. */
export interface TranscriptSummary {
  readonly uid: string;
  readonly turnId: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly internal: boolean;
  readonly createdAt: number;
  /** The message, cut to {@link SUMMARY_MESSAGE_CHARS}. */
  readonly message: string;
  readonly callCount: number;
  readonly outcome: ProposalOutcome | null;
  /** A rejection's issue codes, without repeats. */
  readonly issueCodes: readonly string[];
  /** How the producer rated the reply (GRV-103), or `null` if it is unrated. */
  readonly rating: ReplyRating | null;
  readonly model: string;
}

export type TranscriptAdminResponse =
  | { readonly turns: readonly TranscriptSummary[] }
  | { readonly turn: TranscriptRecord | null };

export const TRANSCRIPT_ADMIN_ERROR_CODES = [
  "unauthenticated",
  "not_admin",
  "invalid_request",
] as const;
export type TranscriptAdminErrorCode = (typeof TRANSCRIPT_ADMIN_ERROR_CODES)[number];

export class TranscriptAdminError extends Error {
  readonly code: TranscriptAdminErrorCode;
  constructor(code: TranscriptAdminErrorCode, message: string) {
    super(message);
    this.name = "TranscriptAdminError";
    this.code = code;
  }
}

/** Who is asking: `null` when nobody is signed in. */
export interface TranscriptAdminCaller {
  readonly admin: boolean;
}

/** A stored record, or `null` for one that does not parse (it is left out, not shown half-read). */
function parseRecord(raw: unknown): TranscriptRecord | null {
  const parsed = transcriptRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function lastOutcome(record: TranscriptRecord) {
  return record.outcomes[record.outcomes.length - 1] ?? null;
}

export function summarizeTranscript(record: TranscriptRecord): TranscriptSummary {
  const last = lastOutcome(record);
  const rejection = [...record.outcomes]
    .reverse()
    .find((entry) => entry.outcome === "rejected");
  return {
    uid: record.uid,
    turnId: record.turnId,
    conversationId: record.conversationId,
    projectId: record.projectId,
    internal: record.internal,
    createdAt: record.createdAt,
    message:
      record.userMessage.length > SUMMARY_MESSAGE_CHARS
        ? `${record.userMessage.slice(0, SUMMARY_MESSAGE_CHARS - 1)}…`
        : record.userMessage,
    callCount: record.proposal?.calls.length ?? 0,
    outcome: last?.outcome ?? null,
    issueCodes: [...new Set(rejection?.issues?.map((issue) => issue.code) ?? [])],
    rating: record.rating?.rating ?? null,
    model: record.model,
  };
}

function matches(
  summary: TranscriptSummary,
  request: Extract<TranscriptAdminRequest, { op: "list" }>,
): boolean {
  if (request.internal !== undefined && summary.internal !== request.internal) {
    return false;
  }
  if (request.rating !== undefined && summary.rating !== request.rating) return false;
  if (request.outcome === undefined) return true;
  return request.outcome === "none"
    ? summary.outcome === null
    : summary.outcome === request.outcome;
}

/**
 * One `assistantTranscriptsAdmin` call. Refuses anyone without the `admin`
 * claim before the store is touched.
 */
export async function handleTranscriptAdminRequest(
  store: TranscriptStore,
  caller: TranscriptAdminCaller | null,
  raw: unknown,
): Promise<TranscriptAdminResponse> {
  if (!caller) throw new TranscriptAdminError("unauthenticated", "Sign in first.");
  if (!caller.admin) {
    throw new TranscriptAdminError("not_admin", "Only an admin can read transcripts.");
  }
  const parsed = transcriptAdminRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TranscriptAdminError("invalid_request", "The request was not valid.");
  }
  const request = parsed.data;
  if (request.op === "get") {
    return { turn: parseRecord(await store.read(request.uid, request.turnId)) };
  }
  const narrowed =
    request.outcome !== undefined ||
    request.rating !== undefined ||
    request.internal !== undefined;
  const raws = await store.recent(
    { uid: request.uid, projectId: request.projectId },
    narrowed ? TRANSCRIPT_SCAN_LIMIT : TRANSCRIPT_LIST_LIMIT,
  );
  const turns = raws
    .map(parseRecord)
    .filter((record): record is TranscriptRecord => record !== null)
    .map(summarizeTranscript)
    .filter((summary) => matches(summary, request))
    .slice(0, TRANSCRIPT_LIST_LIMIT);
  return { turns };
}
