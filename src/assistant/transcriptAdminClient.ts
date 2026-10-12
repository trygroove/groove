/**
 * The admin page's door to the `assistantTranscriptsAdmin` callable (GRV-98):
 * list kept turns and open one. Firebase-free, like `retentionClient.ts`: the
 * call is injected. The app's is the callable
 * (`src/firebaseAssistantTransport.ts`); the mock backend runs
 * `handleTranscriptAdminRequest` in the page over its in-memory store. Every
 * answer is parsed here, so a bad one is a failure, never an undefined read.
 */
import { z } from "zod";
import type {
  TranscriptAdminRequest,
  TranscriptOutcomeFilter,
  TranscriptSummary,
} from "./transcriptAdmin";
import {
  PROPOSAL_OUTCOMES,
  REPLY_RATINGS,
  type ReplyRating,
  type TranscriptRecord,
  transcriptRecordSchema,
} from "./transcripts";

/** One call to the callable: the request out, the raw answer back. */
export type TranscriptAdminCall = (request: TranscriptAdminRequest) => Promise<unknown>;

/** What a listing narrows to; every field is optional. */
export interface TranscriptListQuery {
  readonly uid?: string;
  readonly projectId?: string;
  readonly outcome?: TranscriptOutcomeFilter;
  /** Only turns whose reply was rated so (GRV-103). */
  readonly rating?: ReplyRating;
  readonly internal?: boolean;
}

export interface TranscriptAdminClient {
  list(query: TranscriptListQuery): Promise<readonly TranscriptSummary[]>;
  /** One turn in full, or `null` when there is no such turn. */
  get(uid: string, turnId: string): Promise<TranscriptRecord | null>;
}

const summarySchema = z.looseObject({
  uid: z.string(),
  turnId: z.string(),
  conversationId: z.string(),
  projectId: z.string(),
  internal: z.boolean(),
  createdAt: z.number(),
  message: z.string(),
  callCount: z.number(),
  outcome: z.enum(PROPOSAL_OUTCOMES).nullable(),
  issueCodes: z.array(z.string()),
  // A callable deployed before ratings (GRV-103) sends none.
  rating: z.enum(REPLY_RATINGS).nullable().default(null),
  model: z.string(),
});

const listSchema = z.looseObject({ turns: z.array(summarySchema) });
const getSchema = z.looseObject({ turn: transcriptRecordSchema.nullable() });

/** The query without its empty fields, which the callable's strict schema would refuse. */
function requestFor(query: TranscriptListQuery): TranscriptAdminRequest {
  return {
    op: "list",
    ...(query.uid ? { uid: query.uid } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.outcome ? { outcome: query.outcome } : {}),
    ...(query.rating ? { rating: query.rating } : {}),
    ...(query.internal !== undefined ? { internal: query.internal } : {}),
  };
}

export function createTranscriptAdminClient(
  call: TranscriptAdminCall,
): TranscriptAdminClient {
  return {
    async list(query) {
      return listSchema.parse(await call(requestFor(query))).turns;
    },
    async get(uid, turnId) {
      return getSchema.parse(await call({ op: "get", uid, turnId })).turn;
    },
  };
}
