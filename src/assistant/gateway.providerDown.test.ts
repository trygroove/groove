/**
 * A provider that is down for everyone (GRV-206): an account out of API
 * credit, or a function with no API key, refuses every turn the same way.
 * Such a turn fails as the provider being unavailable, not as the producer's
 * request refused; it is reported to error monitoring, and every turn that
 * ends on a provider-level failure sends `assistant_provider_down` through
 * the trace sink whatever the producer's analytics consent, as Groove's own
 * server, never as the producer.
 */
import { describe, expect, it } from "vitest";
import { createReferenceProject } from "../domain/fixtures";
import {
  type CallScript,
  createScriptedAssistantProvider,
  replyEvents,
} from "../testing/scriptedAssistantProvider";
import { ASSISTANT_CALL_LIMITS } from "./config";
import {
  type AssistantCaller,
  type AssistantGatewayDeps,
  runAssistantTurn,
} from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import { buildAssistantPayload } from "./payload";
import { AssistantGatewayError, type AssistantTurnRequest } from "./protocol";
import type { ProviderDownKind } from "./provider";
import {
  ASSISTANT_SERVER_DISTINCT_ID,
  type AssistantServerEvent,
  PROVIDER_DOWN_EVENT,
} from "./traces";

const UID = "uid-provider-down";
const SIGNED_IN: AssistantCaller = { uid: UID, signInProvider: "google.com" };

function request(productAnalytics: boolean): AssistantTurnRequest {
  const project = createReferenceProject();
  return {
    projectRevision: project.metadata.revision,
    messages: [{ role: "user", text: "so what do I do now" }],
    context: buildAssistantPayload(project),
    analytics: { productAnalytics },
  };
}

function harness(scripts: readonly CallScript[]) {
  const events: AssistantServerEvent[] = [];
  const down: ProviderDownKind[] = [];
  const provider = createScriptedAssistantProvider(scripts);
  const deps: AssistantGatewayDeps = {
    provider,
    guards: createInMemoryGuardStores(),
    log: () => {},
    now: () => 1_000,
    sleep: async () => {},
    limits: { ...ASSISTANT_CALL_LIMITS, inactivityTimeoutMs: 200 },
    traces: { capture: (event) => events.push(event) },
    onProviderDown: (kind) => down.push(kind),
  };
  return { deps, events, down, provider };
}

async function failed(
  h: ReturnType<typeof harness>,
  productAnalytics = false,
): Promise<AssistantGatewayError> {
  try {
    await runAssistantTurn(h.deps, SIGNED_IN, request(productAnalytics), {
      signal: new AbortController().signal,
      onChunk: () => {},
    });
  } catch (error) {
    if (error instanceof AssistantGatewayError) return error;
    throw error;
  }
  throw new Error("the turn did not fail");
}

const downEvents = (events: readonly AssistantServerEvent[]) =>
  events.filter((event) => event.event === PROVIDER_DOWN_EVENT);

describe("a provider down for everyone (GRV-206)", () => {
  it("fails an out-of-credit turn as the provider unavailable, never retried, and reports it", async () => {
    const h = harness([
      [{ fail: "rejected", status: 400, outOfCredit: true }],
      replyEvents(["unused"]),
    ]);
    const error = await failed(h);
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).not.toMatch(/refuse|could not take/i);
    expect(h.provider.requests).toHaveLength(1);
    expect(h.down).toEqual(["out_of_credit"]);
  });

  it("fails a turn with no API key the same way", async () => {
    const h = harness([[{ fail: "rejected", noApiKey: true }]]);
    const error = await failed(h);
    expect(error.code).toBe("provider_unavailable");
    expect(h.down).toEqual(["no_api_key"]);
  });

  it("sends assistant_provider_down as the server, without the producer's consent", async () => {
    const h = harness([[{ fail: "rejected", status: 400, outOfCredit: true }]]);
    await failed(h, false);
    expect(h.events).toEqual([
      {
        distinctId: ASSISTANT_SERVER_DISTINCT_ID,
        event: PROVIDER_DOWN_EVENT,
        properties: {
          failure_kind: "out_of_credit",
          http_status: 400,
          $process_person_profile: false,
        },
      },
    ]);
    expect(JSON.stringify(h.events)).not.toContain(UID);
  });

  it("names any other refusal, and a provider still failing after its retries", async () => {
    const rejected = harness([[{ fail: "rejected", status: 400 }]]);
    expect((await failed(rejected)).code).toBe("provider_error");
    expect(downEvents(rejected.events).map((event) => event.properties)).toEqual([
      { failure_kind: "rejected", http_status: 400, $process_person_profile: false },
    ]);
    expect(rejected.down).toEqual([]);

    const overloaded = harness(
      Array.from({ length: ASSISTANT_CALL_LIMITS.maxAttempts }, () => [
        { fail: "overloaded" as const, status: 529 },
      ]),
    );
    await failed(overloaded);
    expect(downEvents(overloaded.events).map((event) => event.properties)).toEqual([
      { failure_kind: "overloaded", http_status: 529, $process_person_profile: false },
    ]);
  });

  it("sends one event per failed turn alongside its traces when the producer allows them", async () => {
    const h = harness([[{ fail: "rejected", status: 400, outOfCredit: true }]]);
    await failed(h, true);
    expect(downEvents(h.events)).toHaveLength(1);
    expect(h.events.filter((event) => event.event === "$ai_generation")).toHaveLength(1);
  });

  it("sends nothing for a turn that completes, or one the network or the stream failed", async () => {
    const completed = harness([replyEvents(["Start with a beat."])]);
    await runAssistantTurn(completed.deps, SIGNED_IN, request(false), {
      signal: new AbortController().signal,
      onChunk: () => {},
    });
    expect(completed.events).toEqual([]);

    for (const fail of ["network", "malformed"] as const) {
      const h = harness(
        Array.from({ length: ASSISTANT_CALL_LIMITS.maxAttempts }, () => [{ fail }]),
      );
      await failed(h);
      expect(h.events).toEqual([]);
      expect(h.down).toEqual([]);
    }
  });
});
