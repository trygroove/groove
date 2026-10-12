/**
 * The assistant's transcript store (GRV-8, PRD AI-09, ADR 0003 and ADR 0007
 * decision 5): what Groove keeps of a conversation so the team can read it
 * and make the assistant better, for how long, and the account's say in it.
 *
 * Its own collection behind the gateway, never the analytics catalog: a
 * transcript holds exactly the free text the catalog's parameter tests
 * forbid, so nothing here reaches `src/analytics` or error reporting.
 *
 * Two top-level collections, written only by the Cloud Functions with the
 * admin credential. `firestore.rules` denies every client both of them, the
 * owner included, so no browser can write a transcript, widen its own
 * preference past what the callable allows, or read anyone's records. An
 * account with the `admin` claim reads them through the
 * `assistantTranscriptsAdmin` callable (`transcriptAdmin.ts`, GRV-98), never
 * through the rules.
 *
 * - `assistantTranscripts/{uid}_{turnId}`: one completed turn
 *   ({@link TranscriptRecord}): the user's message, the reply, the proposal
 *   shown and what became of it, the producer's rating of the reply
 *   (GRV-103), the project's ID and revision, timestamps.
 * - `assistantPreferences/{uid}`: whether the account lets Groove keep them
 *   ({@link RetentionPreference}), keyed by uid so it survives sign-out,
 *   sign-in, and a guest linking an account (which keeps the uid).
 *
 * Keeping is the default (GRV-97, ADR 0007 decision 9): an account that has
 * not answered is kept, and only its explicit "don't keep" stops it.
 *
 * The rules a store follows are here, Firebase-free, and run as one contract
 * suite against the in-memory store and the Firestore one
 * (`transcriptStoreContract.ts`):
 *
 * - **Read before every write.** A record is written only inside the same
 *   transaction that reads the preference and finds it permits retention
 *   ({@link permitsRetention}); absent, malformed or stale (answered against
 *   another disclosure) means yes, an explicit `retain: false` at any
 *   disclosure version means no, and a preference the store cannot read
 *   keeps nothing.
 * - **Opting out deletes.** Setting retention off removes every record the
 *   account has, and a turn racing it either lands before (and is deleted)
 *   or reads the new preference (and is not written).
 * - **Expiry deletes.** A record is deleted once {@link TRANSCRIPT_RETENTION_MS}
 *   has passed since its message; nothing is archived or summarised.
 * - **Project and account deletion delete** that project's or account's
 *   records (`functions/src/index.ts` wires the triggers).
 */
import { z } from "zod";
import { ASSISTANT_LIMITS } from "./config";
import { PROPOSAL_ISSUE_CODES } from "./proposalIssues";

export const ASSISTANT_TRANSCRIPTS_COLLECTION = "assistantTranscripts";
export const ASSISTANT_PREFERENCES_COLLECTION = "assistantPreferences";

/** How long a transcript is kept, from the message that produced it. */
export const TRANSCRIPT_RETENTION_DAYS = ASSISTANT_LIMITS.transcriptRetentionDays;
export const TRANSCRIPT_RETENTION_MS = TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * The disclosure an answer was given against. Bump it when the copy changes
 * what it promises: every earlier answer becomes stale, so the browser shows
 * the notice again. A stale answer never widens retention past what the
 * account said: a stale "don't keep" still stops it (see
 * {@link permitsRetention}).
 */
export const ASSISTANT_DISCLOSURE_VERSION = 1;

export function transcriptDocPath(uid: string, turnId: string): string {
  return `${ASSISTANT_TRANSCRIPTS_COLLECTION}/${uid}_${turnId}`;
}

export function preferenceDocPath(uid: string): string {
  return `${ASSISTANT_PREFERENCES_COLLECTION}/${uid}`;
}

/** An ID the browser makes up: a turn's or a conversation's. */
export const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/**
 * What the browser says about a turn for the transcript, beside the request
 * the provider sees. Never sent to the provider: the project's ID stays here
 * (ADR 0007 decision 1 does not list it).
 */
export const assistantTurnSessionSchema = z.strictObject({
  conversationId: sessionIdSchema,
  turnId: sessionIdSchema,
  projectId: z.string().min(1).max(64),
  /** The browser's internal-traffic flag (`src/shared/internalTraffic.ts`). */
  internal: z.boolean(),
});
export type AssistantTurnSession = z.infer<typeof assistantTurnSessionSchema>;

/** The account's answer to the disclosure. */
export const retentionPreferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  retain: z.boolean(),
  disclosureVersion: z.int().min(1),
  answeredAt: z.int().min(0),
});
export type RetentionPreference = z.infer<typeof retentionPreferenceSchema>;

/**
 * Whether a stored preference lets Groove keep a transcript (GRV-97: keeping
 * is the default). Only an explicit "don't keep" stops it: any stored
 * document whose `retain` is `false`, whatever disclosure it answered and
 * however well-formed the rest of it is. No answer, a yes, and a malformed or
 * stale document that does not say `retain: false` all keep.
 */
export function permitsRetention(raw: unknown): boolean {
  return !declinesRetention(raw);
}

function declinesRetention(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { readonly retain?: unknown }).retain === false
  );
}

/** A stored preference as the browser may see it, or `null` for none or a bad one. */
export function readPreference(raw: unknown): RetentionPreference | null {
  const parsed = retentionPreferenceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * What became of a proposal. `rejected` (GRV-98): it never reached the
 * producer as something to apply, because it did not fit the song (or the
 * song had moved on); the outcome carries why ({@link TranscriptIssue}).
 */
export const PROPOSAL_OUTCOMES = ["applied", "cancelled", "undone", "rejected"] as const;
export type ProposalOutcome = (typeof PROPOSAL_OUTCOMES)[number];

/** The most issues one rejected outcome keeps. */
export const MAX_TRANSCRIPT_ISSUES = 20;

/**
 * One reason a proposal was rejected, as the browser's validator found it
 * (`ProposalIssue` in `proposal.ts`, GRV-98): its code, the tool call it blames
 * (by the call's ID and tool name, both the model's), and where the validator
 * and the kernel say so, the path and message they wrote. Never the
 * producer's words: those are machine-generated, and a path or message that
 * carries anything {@link checkTranscriptOutcome} forbids is dropped.
 */
export const transcriptIssueSchema = z.strictObject({
  code: z.enum(PROPOSAL_ISSUE_CODES),
  callId: z.string().max(200).nullable(),
  callName: z.string().max(200).nullable(),
  path: z.string().max(300).nullable(),
  message: z.string().max(500).nullable(),
});
export type TranscriptIssue = z.infer<typeof transcriptIssueSchema>;

/** One outcome as a record keeps it; only `rejected` carries issues. */
export const transcriptOutcomeSchema = z
  .strictObject({
    outcome: z.enum(PROPOSAL_OUTCOMES),
    at: z.int().min(0),
    issues: z.array(transcriptIssueSchema).max(MAX_TRANSCRIPT_ISSUES).optional(),
  })
  .refine((entry) => entry.issues === undefined || entry.outcome === "rejected", {
    message: "only a rejected outcome carries issues",
  });
export type TranscriptOutcome = z.infer<typeof transcriptOutcomeSchema>;

/**
 * How the producer rated a reply (GRV-103): thumbs up or down. One rating per
 * turn, which a later click changes or clears.
 */
export const REPLY_RATINGS = ["up", "down"] as const;
export type ReplyRating = (typeof REPLY_RATINGS)[number];

/** A turn's rating as a record keeps it, and when it was given. */
export const transcriptRatingSchema = z.strictObject({
  rating: z.enum(REPLY_RATINGS),
  at: z.int().min(0),
});
export type TranscriptRating = z.infer<typeof transcriptRatingSchema>;

const text = z.string().max(64_000);

/** One proposal as the card showed it: the tool calls the model made. */
const transcriptProposalSchema = z.strictObject({
  baseRevision: z.int().min(0),
  toolsetVersion: z.int().min(0),
  calls: z
    .array(
      z.strictObject({
        id: z.string().max(200),
        name: z.string().max(200),
        input: z.unknown(),
      }),
    )
    .max(200),
});

/**
 * One kept turn. Strict: a field this does not name (the project context,
 * the song, a clip, audio, a credential) is refused, not stored.
 */
export const transcriptRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  uid: z.string().min(1).max(128),
  conversationId: sessionIdSchema,
  turnId: sessionIdSchema,
  projectId: z.string().min(1).max(64),
  projectRevision: z.int().min(0),
  /** Team or test traffic, so review can leave it out. */
  internal: z.boolean(),
  userMessage: text,
  reply: text,
  stopReason: z.enum(["end_turn", "max_tokens", "refusal", "tool_use"]),
  proposal: transcriptProposalSchema.nullable(),
  outcomes: z.array(transcriptOutcomeSchema).max(50),
  /**
   * The producer's rating of the reply (GRV-103): absent until it is rated,
   * `null` once a rating has been cleared.
   */
  rating: transcriptRatingSchema.nullable().optional(),
  model: z.string().max(100),
  promptVersion: z.string().max(100),
  /** When the message arrived, ms since the epoch: the retention clock. */
  createdAt: z.int().min(0),
  /** When it must be gone: `createdAt` plus the retention window. */
  expiresAt: z.int().min(0),
});
export type TranscriptRecord = z.infer<typeof transcriptRecordSchema>;

/**
 * What no transcript may hold anywhere, however deep: a URL (an asset's or
 * any other), or something shaped like a credential or token. A message that
 * carries one is not kept at all; trimming it would keep a record that no
 * longer says what was said.
 */
const FORBIDDEN_TEXT: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S/i,
  /\bgs:\/\//i,
  /\bsk-ant-[A-Za-z0-9_-]+/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
];

/** Keys that name audio or a credential, wherever they appear. */
const FORBIDDEN_KEYS = new Set([
  "audio",
  "audiourl",
  "asseturl",
  "downloadurl",
  "storagepath",
  "url",
  "apikey",
  "token",
  "idtoken",
  "accesstoken",
  "refreshtoken",
  "secret",
  "password",
]);

function forbiddenContent(value: unknown, depth = 0): string | null {
  if (depth > 32) return "nested too deeply";
  if (typeof value === "string") {
    return FORBIDDEN_TEXT.some((pattern) => pattern.test(value))
      ? "a URL or credential"
      : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = forbiddenContent(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) return `a "${key}" field`;
      const found = forbiddenContent(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** A free-text issue field, or `null` when it carries anything forbidden. */
function cleanIssueField(value: string | null): string | null {
  return value !== null && forbiddenContent(value) ? null : value;
}

/**
 * The gate an outcome passes before a store adds it to a record (GRV-98):
 * the strict shape, then nothing forbidden. Every free-text field of an issue
 * (the call's ID and name, which come from the client, and the path and
 * message) is dropped on its own when it carries something forbidden, keeping
 * the code, so a rejection is never kept without its reason codes and never
 * with a URL or a credential. Returns `null` for anything that is not an
 * outcome.
 */
export function checkTranscriptOutcome(raw: unknown): TranscriptOutcome | null {
  const parsed = transcriptOutcomeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { issues, ...rest } = parsed.data;
  if (!issues) return rest;
  return {
    ...rest,
    issues: issues.map((issue) => ({
      code: issue.code,
      callId: cleanIssueField(issue.callId),
      callName: cleanIssueField(issue.callName),
      path: cleanIssueField(issue.path),
      message: cleanIssueField(issue.message),
    })),
  };
}

export type TranscriptCheck =
  | { readonly ok: true; readonly record: TranscriptRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * The one gate a record passes before any store writes it: the strict shape,
 * then nothing forbidden anywhere inside it.
 */
export function checkTranscriptRecord(raw: unknown): TranscriptCheck {
  const parsed = transcriptRecordSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "not a transcript record" };
  const found = forbiddenContent(parsed.data);
  if (found) return { ok: false, reason: `it carries ${found}` };
  if (parsed.data.expiresAt !== parsed.data.createdAt + TRANSCRIPT_RETENTION_MS) {
    return { ok: false, reason: "its expiry is not the retention window" };
  }
  return { ok: true, record: parsed.data };
}

/** A proposal as the gateway returned it (`AssistantProposal`). */
export interface AssistantProposalShown {
  readonly baseRevision: number;
  readonly toolsetVersion: number;
  readonly calls: readonly { id: string; name: string; input: unknown }[];
}

/** What one completed turn gives the transcript. */
export interface CompletedTurn {
  readonly uid: string;
  readonly session: AssistantTurnSession;
  /** Whether the account is a team or test one (`isInternalAccount`). */
  readonly internalAccount: boolean;
  readonly projectRevision: number;
  readonly userMessage: string;
  readonly reply: string;
  readonly stopReason: TranscriptRecord["stopReason"];
  readonly proposal: AssistantProposalShown | null;
  readonly model: string;
  readonly promptVersion: string;
  /** When the message arrived. */
  readonly receivedAt: number;
}

export function transcriptRecordFor(turn: CompletedTurn): TranscriptRecord {
  return {
    schemaVersion: 1,
    uid: turn.uid,
    conversationId: turn.session.conversationId,
    turnId: turn.session.turnId,
    projectId: turn.session.projectId,
    projectRevision: turn.projectRevision,
    internal: turn.internalAccount || turn.session.internal,
    userMessage: turn.userMessage,
    reply: turn.reply,
    stopReason: turn.stopReason,
    proposal: turn.proposal
      ? {
          baseRevision: turn.proposal.baseRevision,
          toolsetVersion: turn.proposal.toolsetVersion,
          calls: turn.proposal.calls.map((call) => ({
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        }
      : null,
    outcomes: [],
    model: turn.model,
    promptVersion: turn.promptVersion,
    createdAt: turn.receivedAt,
    expiresAt: turn.receivedAt + TRANSCRIPT_RETENTION_MS,
  };
}

/** Whether a record's window has passed at `now`. */
export function transcriptExpired(record: { expiresAt: number }, now: number): boolean {
  return record.expiresAt <= now;
}

/**
 * Where transcripts and preferences are kept. Each read-then-write method is
 * one transaction, so a preference change can never slip between the read
 * and the write.
 */
export interface TranscriptStore {
  /** The stored preference document, unparsed, or `null`. May throw. */
  preference(uid: string): Promise<unknown>;
  /** Stores the account's answer. */
  setPreference(uid: string, preference: RetentionPreference): Promise<void>;
  /**
   * Writes `record` if, in the same transaction, `permits` approves the
   * account's stored preference. Returns whether it wrote.
   */
  writeIfPermitted(
    record: TranscriptRecord,
    permits: (preference: unknown) => boolean,
  ): Promise<boolean>;
  /**
   * Adds an outcome to the account's record for `turnId`, if the record
   * exists, is the account's, and `permits` still approves the preference.
   */
  addOutcomeIfPermitted(
    uid: string,
    turnId: string,
    outcome: TranscriptOutcome,
    permits: (preference: unknown) => boolean,
  ): Promise<boolean>;
  /**
   * Sets, or with `null` clears, the rating on the account's record for
   * `turnId` (GRV-103), if the record exists, is the account's, and `permits`
   * still approves the preference.
   */
  setRatingIfPermitted(
    uid: string,
    turnId: string,
    rating: TranscriptRating | null,
    permits: (preference: unknown) => boolean,
  ): Promise<boolean>;
  /**
   * The newest records, unparsed, newest first: every account's, or only the
   * account's or the project's when the filter names one (GRV-98, the admin
   * viewer). At most `limit`.
   */
  recent(filter: TranscriptListFilter, limit: number): Promise<unknown[]>;
  /** One record, unparsed, by its account and turn, or `null`. */
  read(uid: string, turnId: string): Promise<unknown>;
  /** Deletes every record the account has. Returns how many. */
  deleteForUser(uid: string): Promise<number>;
  /** Deletes every record about the project. Returns how many. */
  deleteForProject(projectId: string): Promise<number>;
  /** Deletes every record whose window has passed at `now`. Returns how many. */
  deleteExpired(now: number): Promise<number>;
  /** Deletes the account's preference (account deletion). */
  deletePreference(uid: string): Promise<void>;
}

/** What {@link TranscriptStore.recent} narrows to; an empty filter is every account. */
export interface TranscriptListFilter {
  readonly uid?: string;
  readonly projectId?: string;
}

/** Records are capped per outcome list; a record never holds more. */
export const MAX_OUTCOMES = 50;
