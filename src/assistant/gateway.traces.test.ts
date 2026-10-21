/**
 * The gateway's traces (GRV-126): one `$ai_generation` event per provider
 * call, grouped by conversation, sent only with product analytics allowed,
 * and carrying the conversation only for an account whose conversations are
 * kept. Tracing never changes the turn.
 */
import { describe, expect, it } from "vitest";
import { setTrackFlag } from "../commands";
import { createReferenceProject } from "../domain/fixtures";
import {
  type CallScript,
  createScriptedAssistantProvider,
  replyEvents,
  toolUseEvents,
} from "../testing/scriptedAssistantProvider";
import { ASSISTANT_CALL_LIMITS } from "./config";
import {
  type AssistantCaller,
  type AssistantGatewayDeps,
  runAssistantTurn,
} from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import {
  createInMemoryTranscriptStore,
  type InMemoryTranscriptStore,
} from "./inMemoryTranscriptStore";
import { buildAssistantPayload } from "./payload";
import { ASSISTANT_PROMPT_VERSION } from "./prompt";
import { AssistantGatewayError, type AssistantTurnRequest } from "./protocol";
import { toolNameFor } from "./tools";
import type { AiGenerationEvent } from "./traces";
import { ASSISTANT_DISCLOSURE_VERSION } from "./transcripts";

const UID = "uid-trace-1234";
const SIGNED_IN: AssistantCaller = { uid: UID, signInProvider: "google.com" };
const MESSAGE = "Make the bass hit harder";
const CONVERSATION = "conv_abcdefgh";
const TURN = "turn_abcdefgh";
const SESSION_ID = "0192f3a1-7c2b-7d3e-8f00-123456789abc";

/** A change call: the turn goes on to a second step after it. */
function muteCall() {
  const [track] = createReferenceProject().song.tracks;
  if (!track) throw new Error("the reference project has a track");
  const command = setTrackFlag(track.id, "muted", !track.mixer.muted);
  return { name: toolNameFor(command.type), input: command.payload };
}

function request(overrides: Partial<AssistantTurnRequest> = {}): AssistantTurnRequest {
  const project = createReferenceProject();
  return {
    projectRevision: project.metadata.revision,
    messages: [{ role: "user", text: MESSAGE }],
    context: buildAssistantPayload(project),
    session: {
      conversationId: CONVERSATION,
      turnId: TURN,
      projectId: project.metadata.id,
      internal: false,
    },
    analytics: { productAnalytics: true, sessionId: SESSION_ID },
    ...overrides,
  };
}

interface Harness {
  readonly deps: AssistantGatewayDeps;
  readonly events: AiGenerationEvent[];
  readonly transcripts: InMemoryTranscriptStore;
}

function harness(
  scripts: readonly CallScript[],
  overrides: Partial<AssistantGatewayDeps> = {},
): Harness {
  const events: AiGenerationEvent[] = [];
  const transcripts = createInMemoryTranscriptStore();
  let clock = 1_000;
  return {
    events,
    transcripts,
    deps: {
      provider: createScriptedAssistantProvider(scripts),
      guards: createInMemoryGuardStores(),
      log: () => {},
      now: () => {
        clock += 250;
        return clock;
      },
      sleep: async () => {},
      limits: { ...ASSISTANT_CALL_LIMITS, inactivityTimeoutMs: 200 },
      transcripts,
      // The `$ai_generation` events; `assistant_provider_down` has its own
      // tests (`gateway.providerDown.test.ts`).
      traces: {
        capture: (event) => {
          if (event.event === "$ai_generation") events.push(event);
        },
      },
      traceId: () => "generated-trace",
      ...overrides,
    },
  };
}

function run(h: Harness, body: unknown = request(), caller = SIGNED_IN) {
  return runAssistantTurn(h.deps, caller, body, {
    signal: new AbortController().signal,
    onChunk: () => {},
  });
}

async function declineRetention(store: InMemoryTranscriptStore) {
  await store.setPreference(UID, {
    schemaVersion: 1,
    retain: false,
    disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
    answeredAt: 0,
  });
}

const CONTENT_KEYS = ["$ai_input", "$ai_tools", "$ai_output_choices"];

describe("the gateway's traces", () => {
  it("sends one event per provider call, as the turn's UID, in its turn's trace and its conversation's session", async () => {
    const h = harness([replyEvents(["Here ", "you go."], { inputTokens: 120 })]);
    const result = await run(h);

    expect(h.events).toHaveLength(1);
    const [event] = h.events;
    expect(event?.event).toBe("$ai_generation");
    expect(event?.distinctId).toBe(UID);
    expect(event?.properties).toMatchObject({
      $ai_trace_id: TURN,
      $ai_session_id: CONVERSATION,
      $ai_span_id: `${TURN}-1`,
      $ai_model: result.model,
      $ai_provider: "anthropic",
      $ai_input_tokens: 120,
      $ai_output_tokens: 20,
      $ai_cache_read_input_tokens: 0,
      $ai_cache_creation_input_tokens: 0,
      $ai_latency: 0.25,
      $ai_is_error: false,
      $ai_http_status: 200,
      $ai_stop_reason: "end_turn",
      $session_id: SESSION_ID,
      prompt_version: ASSISTANT_PROMPT_VERSION,
      outcome: "completed",
      attempt: 1,
      failure_kind: null,
      internal: "false",
    });
  });

  it("sends a retried call's failure and its retry, in one trace", async () => {
    const h = harness([[{ fail: "overloaded", status: 529 }], replyEvents(["Fine."])]);
    await run(h);

    expect(h.events).toHaveLength(2);
    const [failed, retried] = h.events.map((event) => event.properties);
    expect(new Set(h.events.map((event) => event.properties.$ai_trace_id))).toEqual(
      new Set([TURN]),
    );
    expect(new Set(h.events.map((event) => event.properties.$ai_session_id))).toEqual(
      new Set([CONVERSATION]),
    );
    expect(failed).toMatchObject({
      $ai_span_id: `${TURN}-1`,
      $ai_is_error: true,
      $ai_http_status: 529,
      $ai_stop_reason: null,
      attempt: 1,
      failure_kind: "overloaded",
      outcome: "completed",
    });
    expect(failed).not.toHaveProperty("$ai_output_choices");
    expect(retried).toMatchObject({
      $ai_span_id: `${TURN}-2`,
      $ai_is_error: false,
      attempt: 2,
      failure_kind: null,
    });
  });

  it("sends a failed turn's calls with the turn's error as their outcome", async () => {
    const h = harness([[{ fail: "rejected", status: 400 }]]);
    await expect(run(h)).rejects.toBeInstanceOf(AssistantGatewayError);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.properties).toMatchObject({
      $ai_is_error: true,
      $ai_http_status: 400,
      failure_kind: "rejected",
      outcome: "provider_error",
    });
  });

  it("sends a call for each step of a turn that goes on after its tool calls", async () => {
    const h = harness([toolUseEvents("Muting it.", [muteCall()])]);
    await run(h);
    expect(h.events.map((event) => event.properties.attempt)).toEqual([1, 2]);
    expect(h.events.map((event) => event.properties.$ai_span_id)).toEqual([
      `${TURN}-1`,
      `${TURN}-2`,
    ]);
    expect(h.events.map((event) => event.properties.$ai_stop_reason)).toEqual([
      "tool_use",
      "end_turn",
    ]);
  });

  it("traces a turn with no session under an ID of its own, in no AI session", async () => {
    const h = harness([replyEvents(["Hi."])]);
    await run(h, request({ session: undefined }));
    expect(h.events[0]?.properties).toMatchObject({
      $ai_trace_id: "generated-trace",
      $ai_session_id: null,
      $ai_span_id: "generated-trace-1",
    });
  });

  it("puts a conversation's turns in one AI session, each its own trace", async () => {
    const h = harness([replyEvents(["Hi."]), replyEvents(["Again."])]);
    const first = request();
    if (!first.session) throw new Error("the request has a session");
    await run(h, first);
    await run(h, request({ session: { ...first.session, turnId: "turn_secondtt" } }));
    expect(h.events.map((event) => event.properties.$ai_session_id)).toEqual([
      CONVERSATION,
      CONVERSATION,
    ]);
    expect(h.events.map((event) => event.properties.$ai_trace_id)).toEqual([
      TURN,
      "turn_secondtt",
    ]);
  });

  it("marks internal traffic, by the account's claim or the browser's flag", async () => {
    const byClaim = harness([replyEvents(["Hi."])]);
    await run(byClaim, request(), { ...SIGNED_IN, internalAccount: true });
    expect(byClaim.events[0]?.properties.internal).toBe("true");

    const byFlag = harness([replyEvents(["Hi."])]);
    const body = request();
    await run(byFlag, {
      ...body,
      session: { ...body.session, internal: true },
    });
    expect(byFlag.events[0]?.properties.internal).toBe("true");
  });

  it("leaves out the session when the browser sent none", async () => {
    const h = harness([replyEvents(["Hi."])]);
    await run(h, request({ analytics: { productAnalytics: true } }));
    expect(h.events[0]?.properties).not.toHaveProperty("$session_id");
  });
});

describe("what a trace carries", () => {
  it("carries the request and the reply for a kept account that allows analytics", async () => {
    const h = harness([replyEvents(["Here ", "you go."])]);
    await run(h);

    const properties = h.events[0]?.properties ?? {};
    const input = JSON.stringify(properties.$ai_input);
    expect(input).toContain(MESSAGE);
    // The system prompt, with the project context in it.
    expect((properties.$ai_input as { role: string }[])[0]?.role).toBe("system");
    expect(input).toContain(createReferenceProject().metadata.name);
    expect(Array.isArray(properties.$ai_tools)).toBe(true);
    expect(properties.$ai_output_choices).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Here you go." }] },
    ]);
    // The browser's own session fields never reach the provider, or the trace's input.
    expect(input).not.toContain(SESSION_ID);
  });

  it("carries a reply's tool calls among its output", async () => {
    const h = harness([toolUseEvents("Muting it.", [muteCall()])]);
    await run(h);
    const output = JSON.stringify(h.events[0]?.properties.$ai_output_choices);
    expect(output).toContain('"type":"tool_use"');
    expect(output).toContain(muteCall().name);
    // The second step's input carries the first step's reply and its result.
    expect(JSON.stringify(h.events[1]?.properties.$ai_input)).toContain("tool_result");
  });

  it("carries no content for an account that said not to keep its conversations", async () => {
    const h = harness([replyEvents(["Here you go."])]);
    await declineRetention(h.transcripts);
    await run(h);

    expect(h.events).toHaveLength(1);
    for (const key of CONTENT_KEYS)
      expect(h.events[0]?.properties).not.toHaveProperty(key);
    expect(JSON.stringify(h.events)).not.toContain(MESSAGE);
    expect(JSON.stringify(h.events)).not.toContain("Here you go.");
  });

  it("carries no content when the preference cannot be read", async () => {
    const h = harness([replyEvents(["Here you go."])]);
    h.transcripts.failPreferenceReads(true);
    await run(h);
    for (const key of CONTENT_KEYS)
      expect(h.events[0]?.properties).not.toHaveProperty(key);
  });

  it("carries no content without a transcript store to ask", async () => {
    const h = harness([replyEvents(["Here you go."])], { transcripts: undefined });
    await run(h);
    expect(h.events).toHaveLength(1);
    for (const key of CONTENT_KEYS)
      expect(h.events[0]?.properties).not.toHaveProperty(key);
  });

  it.each([
    ["declined", { analytics: { productAnalytics: false, sessionId: SESSION_ID } }],
    ["missing", { analytics: undefined }],
    ["a block without the flag", { analytics: { sessionId: SESSION_ID } }],
  ])("sends nothing at all when product analytics is %s", async (_, overrides) => {
    const h = harness([replyEvents(["Here you go."])]);
    const result = await run(h, request(overrides as Partial<AssistantTurnRequest>));
    expect(result.text).toBe("Here you go.");
    expect(h.events).toEqual([]);
  });
});

describe("tracing never changes the turn", () => {
  it("returns the same reply, and logs the same turn, when the sink throws", async () => {
    const quiet = harness([replyEvents(["Here you go."])], { traces: undefined });
    const broken = harness([replyEvents(["Here you go."])], {
      traces: {
        capture() {
          throw new Error("posthog down");
        },
      },
    });
    const expected = await run(quiet);
    await expect(run(broken)).resolves.toEqual(expected);
  });

  it("reports the turn's own failure, not the sink's", async () => {
    const h = harness([[{ fail: "rejected", status: 400 }]], {
      traces: {
        capture() {
          throw new Error("posthog down");
        },
      },
    });
    const error = await run(h).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AssistantGatewayError);
    expect((error as AssistantGatewayError).code).toBe("provider_error");
  });

  it("never sends the analytics block or the session to the provider", async () => {
    const provider = createScriptedAssistantProvider([replyEvents(["Hi."])]);
    const h = harness([], { provider });
    await run(h);
    const sent = JSON.stringify(provider.requests);
    expect(sent).not.toContain(SESSION_ID);
    expect(sent).not.toContain("productAnalytics");
    expect(sent).not.toContain(CONVERSATION);
  });
});
