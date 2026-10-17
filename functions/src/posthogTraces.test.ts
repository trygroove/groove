/**
 * The assistant's traces to PostHog (GRV-126): queued as the turn ends,
 * flushed once it is over within a short limit, and never able to fail or
 * hold up the turn. A failure is reported as a code only.
 */
import type { CallableRequest } from "firebase-functions/v2/https";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryGuardStores } from "../../src/assistant/inMemoryGuardStores";
import { createInMemoryTranscriptStore } from "../../src/assistant/inMemoryTranscriptStore";
import type { AssistantTurnRequest } from "../../src/assistant/protocol";
import type { AiGenerationEvent } from "../../src/assistant/traces";
import {
  createScriptedAssistantProvider,
  MINIMAL_ASSISTANT_CONTEXT,
  replyEvents,
} from "../../src/testing/scriptedAssistantProvider";
import { createAssistantHandler } from "./assistantHandler";
import {
  createPostHogTraces,
  type TraceClient,
  type TraceFailure,
} from "./posthogTraces";

const EVENT: AiGenerationEvent = {
  distinctId: "uid-1",
  event: "$ai_generation",
  properties: { $ai_trace_id: "conv_1", $ai_model: "m" },
};

interface FakeClient extends TraceClient {
  readonly captured: unknown[];
  emitError(error: unknown): void;
}

function fakeClient(
  flush: () => Promise<void> = async () => {},
  capture?: () => void,
): FakeClient {
  const captured: unknown[] = [];
  let onError: (error: unknown) => void = () => {};
  return {
    captured,
    capture(message) {
      capture?.();
      captured.push(message);
    },
    flush,
    on(_event, listener) {
      onError = listener;
    },
    emitError: (error) => onError(error),
  };
}

function traces(client: TraceClient, timeoutMs = 50) {
  const failures: TraceFailure[] = [];
  const sink = createPostHogTraces({
    client,
    onFailure: (failure) => failures.push(failure),
    timeoutMs,
  });
  return { sink, failures };
}

describe("createPostHogTraces", () => {
  it("hands each event to the client as it is", () => {
    const client = fakeClient();
    traces(client).sink.capture(EVENT);
    expect(client.captured).toEqual([
      { distinctId: "uid-1", event: "$ai_generation", properties: EVENT.properties },
    ]);
  });

  it("logs a capture that throws as a code, and does not throw", () => {
    const client = fakeClient(undefined, () => {
      throw new Error("the prompt said something");
    });
    const { sink, failures } = traces(client);
    expect(() => sink.capture(EVENT)).not.toThrow();
    expect(failures).toEqual(["capture_failed"]);
  });

  it("gives up on a flush that hangs, within the limit", async () => {
    const { sink, failures } = traces(
      fakeClient(() => new Promise(() => {})),
      30,
    );
    const started = Date.now();
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(failures).toEqual(["flush_timeout"]);
  });

  it("logs a flush that fails, and resolves anyway", async () => {
    const { sink, failures } = traces(
      fakeClient(() => Promise.reject(new Error("503 with the payload in it"))),
    );
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(failures).toEqual(["flush_failed"]);
  });

  it("logs a flush that throws before it starts", async () => {
    const { sink, failures } = traces(
      fakeClient(() => {
        throw new Error("boom");
      }),
    );
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(failures).toEqual(["flush_failed"]);
  });

  it("logs the client's own send errors as a code", () => {
    const client = fakeClient();
    const { failures } = traces(client);
    client.emitError(new Error("the request body"));
    expect(failures).toEqual(["send_failed"]);
  });
});

describe("the assistant callable's traces", () => {
  const turn: AssistantTurnRequest = {
    projectRevision: 0,
    messages: [{ role: "user", text: "hello" }],
    context: MINIMAL_ASSISTANT_CONTEXT,
    analytics: { productAnalytics: true },
  };
  const request = {
    data: turn,
    auth: { uid: "uid-1", token: { firebase: { sign_in_provider: "google.com" } } },
    acceptsStreaming: false,
    rawRequest: {},
  } as unknown as CallableRequest<unknown>;

  function handler(client: TraceClient) {
    const { sink, failures } = traces(client);
    const flush = vi.spyOn(sink, "flush");
    const handle = createAssistantHandler(() => ({
      provider: createScriptedAssistantProvider([replyEvents(["Hi there."])]),
      guards: createInMemoryGuardStores(),
      transcripts: createInMemoryTranscriptStore(),
      log: () => {},
      sleep: async () => {},
      traces: sink,
    }));
    return { handle, flush, failures };
  }

  it("flushes the turn's events before it returns", async () => {
    const client = fakeClient();
    const { handle, flush } = handler(client);
    const result = await handle(request);
    expect(result.text).toBe("Hi there.");
    expect(client.captured).toHaveLength(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("returns the same reply when PostHog fails or hangs", async () => {
    const working = await handler(fakeClient()).handle(request);
    const failing = handler(fakeClient(() => Promise.reject(new Error("down"))));
    const hanging = handler(fakeClient(() => new Promise(() => {})));
    await expect(failing.handle(request)).resolves.toEqual(working);
    await expect(hanging.handle(request)).resolves.toEqual(working);
    expect(failing.failures).toEqual(["flush_failed"]);
    expect(hanging.failures).toEqual(["flush_timeout"]);
  });

  it("flushes after a turn that failed, and still reports the turn's error", async () => {
    const client = fakeClient();
    const { sink } = traces(client);
    const flush = vi.spyOn(sink, "flush");
    const handle = createAssistantHandler(() => ({
      provider: createScriptedAssistantProvider([[{ fail: "rejected", status: 400 }]]),
      guards: createInMemoryGuardStores(),
      log: () => {},
      sleep: async () => {},
      traces: sink,
    }));
    await expect(handle(request)).rejects.toMatchObject({ code: "failed-precondition" });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(client.captured).toHaveLength(1);
  });
});
