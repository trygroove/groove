/**
 * The production provider over the real SDK, with the network replaced by a
 * scripted `fetch` answering in the Messages API's own wire format. No key,
 * no network: what is under test is how the SDK's stream and its errors map
 * onto the gateway's `ProviderFailure`s, and that the gateway's validation
 * holds over a real SDK stream.
 */
import { describe, expect, it } from "vitest";
import { ASSISTANT_MODELS } from "../../src/assistant/config";
import { type AssistantGatewayDeps, runAssistantTurn } from "../../src/assistant/gateway";
import { createInMemoryGuardStores } from "../../src/assistant/inMemoryGuardStores";
import {
  AssistantGatewayError,
  type AssistantTurnRequest,
} from "../../src/assistant/protocol";
import { ProviderFailure } from "../../src/assistant/provider";
import { buildProviderRequest, providerTools } from "../../src/assistant/providerRequest";
import type { AssistantTurnLog } from "../../src/assistant/telemetry";
import { assistantTools } from "../../src/assistant/tools";
import { MINIMAL_ASSISTANT_CONTEXT } from "../../src/testing/scriptedAssistantProvider";
import { createAnthropicProvider } from "./anthropicProvider";

const request = buildProviderRequest(ASSISTANT_MODELS["claude-sonnet-5"], {
  system: [{ type: "text", text: "system" }],
  messages: [{ role: "user", content: "hello" }],
  // The real tool set, so the body sent over the wire is checked with it.
  tools: providerTools(assistantTools()),
  pseudonymousUserId: "abc",
});

function sse(events: readonly [string, unknown][], tail = ""): string {
  return (
    events
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("") + tail
  );
}

const REPLY: [string, unknown][] = [
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
  ],
  [
    "content_block_start",
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ],
  ["ping", { type: "ping" }],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } },
  ],
  [
    "content_block_delta",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "there" },
    },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
];

interface Sent {
  url: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null;
}

function scriptedFetch(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal ?? null,
    };
    sent.push(call);
    return respond(call);
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const streamResponse = (body: string | ReadableStream<Uint8Array>) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

const errorResponse = (status: number, type: string, message = "echo of the request") =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function failureOf(promise: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderFailure) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("createAnthropicProvider", () => {
  it("sends the gateway's body as it is, with the key in a header", async () => {
    const { sent, fetchImpl } = scriptedFetch(() => streamResponse(sse(REPLY)));
    const provider = createAnthropicProvider({ apiKey: "sk-test-key", fetch: fetchImpl });
    const events = await drain(provider.stream(request, new AbortController().signal));
    expect(events).toHaveLength(REPLY.length - 1); // the SDK swallows pings
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toMatch(/\/v1\/messages$/);
    expect(sent[0].headers.get("x-api-key")).toBe("sk-test-key");
    expect(sent[0].body).toEqual(request);
  });

  it.each([
    [429, "rate_limit_error", "rate_limited"],
    [529, "overloaded_error", "overloaded"],
    [500, "api_error", "server_error"],
    [400, "invalid_request_error", "rejected"],
    [401, "authentication_error", "rejected"],
  ] as const)(
    "maps a %i answer to %s, making one call and no SDK retry",
    async (status, type, kind) => {
      const { sent, fetchImpl } = scriptedFetch(() => errorResponse(status, type));
      const provider = createAnthropicProvider({ apiKey: "k", fetch: fetchImpl });
      const failure = await failureOf(
        drain(provider.stream(request, new AbortController().signal)),
      );
      expect(failure).toMatchObject({ kind, status });
      expect(failure.message).not.toContain("echo of the request");
      expect(sent).toHaveLength(1);
    },
  );

  it("tells an account out of credit apart from any other refusal", async () => {
    const credit = scriptedFetch(() =>
      errorResponse(
        400,
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
    );
    const out = await failureOf(
      drain(
        createAnthropicProvider({ apiKey: "k", fetch: credit.fetchImpl }).stream(
          request,
          new AbortController().signal,
        ),
      ),
    );
    expect(out).toMatchObject({ kind: "rejected", status: 400, outOfCredit: true });
    expect(out.message).not.toContain("credit");

    const other = scriptedFetch(() => errorResponse(400, "invalid_request_error"));
    const refused = await failureOf(
      drain(
        createAnthropicProvider({ apiKey: "k", fetch: other.fetchImpl }).stream(
          request,
          new AbortController().signal,
        ),
      ),
    );
    expect(refused.outOfCredit).toBe(false);
  });

  it("maps an error event inside an open stream", async () => {
    const body =
      sse(REPLY.slice(0, 2)) +
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "x" } })}\n\n`;
    const { fetchImpl } = scriptedFetch(() => streamResponse(body));
    const provider = createAnthropicProvider({ apiKey: "k", fetch: fetchImpl });
    const failure = await failureOf(
      drain(provider.stream(request, new AbortController().signal)),
    );
    expect(failure.kind).toBe("overloaded");
  });

  it("maps a stream of bad JSON to malformed", async () => {
    const body =
      sse(REPLY.slice(0, 1)) + "event: content_block_delta\ndata: {not json\n\n";
    const { fetchImpl } = scriptedFetch(() => streamResponse(body));
    const provider = createAnthropicProvider({ apiKey: "k", fetch: fetchImpl });
    const failure = await failureOf(
      drain(provider.stream(request, new AbortController().signal)),
    );
    expect(failure.kind).toBe("malformed");
  });

  it("refuses every call, without the network, when the secret has no value", async () => {
    const { sent, fetchImpl } = scriptedFetch(() => streamResponse(sse(REPLY)));
    const provider = createAnthropicProvider({ apiKey: "", fetch: fetchImpl });
    const failure = await failureOf(
      drain(provider.stream(request, new AbortController().signal)),
    );
    expect(failure.kind).toBe("rejected");
    expect(sent).toHaveLength(0);
  });

  it("maps a refused connection to network", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const provider = createAnthropicProvider({ apiKey: "k", fetch: fetchImpl });
    const failure = await failureOf(
      drain(provider.stream(request, new AbortController().signal)),
    );
    expect(failure.kind).toBe("network");
  });

  it("stops quietly when aborted mid-stream", async () => {
    // The first events, then a stream that stays open, as a real one would
    // while the model writes. Like real `fetch`, it errors once aborted.
    const encoder = new TextEncoder();
    const { fetchImpl } = scriptedFetch((call) =>
      streamResponse(
        new ReadableStream<Uint8Array>({
          start(body) {
            body.enqueue(encoder.encode(sse(REPLY.slice(0, 4))));
            call.signal?.addEventListener("abort", () =>
              body.error(new DOMException("aborted", "AbortError")),
            );
          },
        }),
      ),
    );
    const provider = createAnthropicProvider({ apiKey: "k", fetch: fetchImpl });
    const controller = new AbortController();
    const seen: unknown[] = [];
    for await (const event of provider.stream(request, controller.signal)) {
      seen.push(event);
      if (seen.length === 2) controller.abort();
    }
    // It ends rather than hanging or throwing; events already buffered may
    // still arrive, which the gateway ignores once it has aborted.
    expect(seen.length).toBeLessThanOrEqual(3);
  });
});

describe("the gateway over the real SDK", () => {
  const turn: AssistantTurnRequest = {
    projectRevision: 0,
    messages: [{ role: "user", text: "hello" }],
    context: MINIMAL_ASSISTANT_CONTEXT,
  };

  function deps(fetchImpl: typeof fetch, logs: AssistantTurnLog[]): AssistantGatewayDeps {
    return {
      provider: createAnthropicProvider({ apiKey: "k", fetch: fetchImpl }),
      guards: createInMemoryGuardStores(),
      log: (record) => logs.push(record),
      now: Date.now,
      sleep: async () => {},
    };
  }

  it("streams a reply end to end", async () => {
    const logs: AssistantTurnLog[] = [];
    const { fetchImpl } = scriptedFetch(() => streamResponse(sse(REPLY)));
    const chunks: unknown[] = [];
    const result = await runAssistantTurn(
      deps(fetchImpl, logs),
      { uid: "u", signInProvider: "google.com" },
      turn,
      { signal: new AbortController().signal, onChunk: (chunk) => chunks.push(chunk) },
    );
    expect(result.text).toBe("Hi there");
    expect(chunks).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      outcome: "completed",
      inputTokens: 12,
      outputTokens: 3,
    });
  });

  it("counts each retry as its own provider call", async () => {
    const logs: AssistantTurnLog[] = [];
    let calls = 0;
    const { sent, fetchImpl } = scriptedFetch(() => {
      calls += 1;
      return calls === 1
        ? errorResponse(529, "overloaded_error")
        : streamResponse(sse(REPLY));
    });
    await runAssistantTurn(
      deps(fetchImpl, logs),
      { uid: "u", signInProvider: "google.com" },
      turn,
      { signal: new AbortController().signal, onChunk: () => {} },
    );
    expect(sent).toHaveLength(2);
    expect(logs[0]).toMatchObject({ attempts: 2, failures: ["overloaded"] });
  });

  it("fails a truncated stream as malformed", async () => {
    const logs: AssistantTurnLog[] = [];
    const { fetchImpl } = scriptedFetch(() => streamResponse(sse(REPLY.slice(0, 2))));
    const error = await runAssistantTurn(
      deps(fetchImpl, logs),
      { uid: "u", signInProvider: "google.com" },
      turn,
      { signal: new AbortController().signal, onChunk: () => {} },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(AssistantGatewayError);
    expect((error as AssistantGatewayError).code).toBe("malformed_response");
  });
});
