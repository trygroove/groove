/**
 * A retention client for tests (GRV-8): the real `assistantRetention` logic
 * (`handleRetentionRequest`) over an in-memory store, so a test sees exactly
 * what the callable would answer. `answered` sets the account's answer up
 * front, for tests about the conversation rather than the disclosure.
 */
import { createInMemoryTranscriptStore } from "../assistant/inMemoryTranscriptStore";
import { handleRetentionRequest, type RetentionRequest } from "../assistant/retention";
import {
  type AssistantRetentionClient,
  createRetentionClient,
} from "../assistant/retentionClient";
import { ASSISTANT_DISCLOSURE_VERSION } from "../assistant/transcripts";

export interface FakeRetentionClient extends AssistantRetentionClient {
  /** Every request made, in order. */
  readonly requests: RetentionRequest[];
  /** Makes every later call fail, as a callable that cannot be reached. */
  failCalls(fail: boolean): void;
}

export function createFakeRetentionClient(
  options: { readonly uid?: string; readonly answered?: boolean | null } = {},
): FakeRetentionClient {
  const uid = options.uid ?? "u1";
  const store = createInMemoryTranscriptStore();
  const requests: RetentionRequest[] = [];
  let fail = false;
  let at = 0;
  if (options.answered !== undefined && options.answered !== null) {
    void store.setPreference(uid, {
      schemaVersion: 1,
      retain: options.answered,
      disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
      answeredAt: 0,
    });
  }
  const client = createRetentionClient(async (request) => {
    requests.push(request);
    if (fail) throw { code: "functions/unavailable" };
    at += 1;
    return handleRetentionRequest(store, uid, request, at);
  });
  return {
    ...client,
    requests,
    failCalls(next) {
      fail = next;
    },
  };
}
