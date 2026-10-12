/**
 * The browser's door to the `assistantRetention` callable (GRV-8): read the
 * account's answer about keeping its assistant conversations, give one, and
 * say what became of a proposal, or how the producer rated a reply (GRV-103),
 * so a kept turn records it.
 *
 * Firebase-free, like `assistantClient.ts`: the call is injected. The app's
 * is the callable (`src/firebaseAssistantTransport.ts`); the mock backend
 * runs `handleRetentionRequest` in the page over an in-memory store. The
 * answer is parsed here, so a bad one is a failure, never an undefined read.
 */
import { z } from "zod";
import type { RetentionRequest, RetentionState } from "./retention";
import {
  ASSISTANT_DISCLOSURE_VERSION,
  type ProposalOutcome,
  type ReplyRating,
  retentionPreferenceSchema,
  type TranscriptIssue,
} from "./transcripts";

/** One call to the callable: the request out, the raw answer back. */
export type RetentionCall = (request: RetentionRequest) => Promise<unknown>;

export interface AssistantRetentionClient {
  /** The account's answer, or `null` preference if it has not given one. */
  get(): Promise<RetentionState>;
  /** Gives the account's answer to the current disclosure. A no deletes what was kept. */
  set(retain: boolean): Promise<RetentionState>;
  /**
   * Tells a kept turn what became of its proposal, and for a rejected one
   * why (GRV-98). Never rejects.
   */
  outcome(
    turnId: string,
    outcome: ProposalOutcome,
    issues?: readonly TranscriptIssue[],
  ): Promise<void>;
  /**
   * Tells a kept turn how the producer rated its reply, or with `null` that
   * the rating was cleared (GRV-103). Never rejects.
   */
  rate(turnId: string, rating: ReplyRating | null): Promise<void>;
}

const stateSchema = z.looseObject({
  preference: retentionPreferenceSchema.nullable(),
  disclosureVersion: z.int().min(1),
  retentionDays: z.int().min(1),
});

function parseState(raw: unknown): RetentionState {
  return stateSchema.parse(raw);
}

export function createRetentionClient(call: RetentionCall): AssistantRetentionClient {
  return {
    async get() {
      return parseState(await call({ op: "get" }));
    },
    async set(retain) {
      return parseState(
        await call({
          op: "set",
          retain,
          disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
        }),
      );
    },
    async outcome(turnId, outcome, issues) {
      try {
        await call({
          op: "outcome",
          turnId,
          outcome,
          ...(outcome === "rejected" && issues ? { issues: [...issues] } : {}),
        });
      } catch {
        // A kept turn missing an outcome is the cost of a dropped call; the
        // producer's action itself is already done.
      }
    },
    async rate(turnId, rating) {
      try {
        await call({ op: "rate", turnId, rating });
      } catch {
        // As for an outcome: the rating on screen stands either way.
      }
    },
  };
}

/** Whether a state's answer counts: given, and to the disclosure on screen. */
export function answered(state: RetentionState | null): boolean {
  return state?.preference?.disclosureVersion === ASSISTANT_DISCLOSURE_VERSION;
}
