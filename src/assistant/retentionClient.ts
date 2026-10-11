/**
 * The browser's door to the `assistantRetention` callable (GRV-8): read the
 * account's answer about keeping its assistant conversations, give one, and
 * say what became of a proposal so a kept turn records it.
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
  retentionPreferenceSchema,
} from "./transcripts";

/** One call to the callable: the request out, the raw answer back. */
export type RetentionCall = (request: RetentionRequest) => Promise<unknown>;

export interface AssistantRetentionClient {
  /** The account's answer, or `null` preference if it has not given one. */
  get(): Promise<RetentionState>;
  /** Gives the account's answer to the current disclosure. A no deletes what was kept. */
  set(retain: boolean): Promise<RetentionState>;
  /** Tells a kept turn what became of its proposal. Never rejects. */
  outcome(turnId: string, outcome: ProposalOutcome): Promise<void>;
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
    async outcome(turnId, outcome) {
      try {
        await call({ op: "outcome", turnId, outcome });
      } catch {
        // A kept turn missing an outcome is the cost of a dropped call; the
        // producer's action itself is already done.
      }
    },
  };
}

/** Whether a state's answer counts: given, and to the disclosure on screen. */
export function answered(state: RetentionState | null): boolean {
  return state?.preference?.disclosureVersion === ASSISTANT_DISCLOSURE_VERSION;
}
