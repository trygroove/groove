import { describe, expect, it } from "vitest";
import { createReferenceProject } from "../domain/fixtures";
import { ASSISTANT_MODELS } from "./config";
import { buildAssistantPayload } from "./payload";
import { assistantTurnRequestSchema, turnAnalytics } from "./protocol";
import { buildProviderRequest } from "./providerRequest";
import {
  type GenerationCall,
  generationEvent,
  type TraceTurn,
  traceConsent,
  traceIdFor,
  traceInput,
} from "./traces";

const model = Object.values(ASSISTANT_MODELS)[0];
if (!model) throw new Error("a model is configured");

const request = buildProviderRequest(model, {
  system: [{ type: "text", text: "You are Cue." }],
  messages: [
    { role: "user", content: "Hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "opaque-signature" },
        { type: "redacted_thinking", data: "opaque-data" },
        { type: "tool_use", id: "toolu_1", name: "track_mute", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "added" }],
    },
  ],
  tools: [],
  pseudonymousUserId: "pseudo",
});

const TURN: TraceTurn = {
  uid: "uid-1",
  traceId: "conv_1",
  turnKey: "turn_1",
  sessionId: null,
  model: model.id,
  promptVersion: "v1",
  outcome: "timeout",
  internal: false,
  includeContent: true,
};

function call(result: GenerationCall["result"]): GenerationCall {
  return {
    attempt: 3,
    request,
    startedAt: 10_000,
    endedAt: 11_500,
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
    },
    result,
  };
}

describe("generationEvent", () => {
  it("maps tokens, latency in seconds, and the span", () => {
    const { properties } = generationEvent(TURN, call({ kind: "timed_out" }));
    expect(properties).toMatchObject({
      $ai_span_id: "turn_1-3",
      $ai_input_tokens: 1,
      $ai_output_tokens: 2,
      $ai_cache_creation_input_tokens: 3,
      $ai_cache_read_input_tokens: 4,
      $ai_latency: 1.5,
    });
  });

  it.each([
    [{ kind: "timed_out" } as const, "timeout"],
    [{ kind: "cancelled" } as const, "cancelled"],
  ])("marks a call that ended %o as an error with no status", (result, kind) => {
    const { properties } = generationEvent(TURN, call(result));
    expect(properties.$ai_is_error).toBe(true);
    expect(properties.failure_kind).toBe(kind);
    expect(properties).not.toHaveProperty("$ai_http_status");
    expect(properties).not.toHaveProperty("$ai_output_choices");
  });

  it("leaves out a failure's status when it had none", () => {
    const { properties } = generationEvent(
      TURN,
      call({ kind: "failed", failure: "network", status: null }),
    );
    expect(properties.failure_kind).toBe("network");
    expect(properties).not.toHaveProperty("$ai_http_status");
  });

  it("leaves out no content field it was not allowed", () => {
    const { properties } = generationEvent(
      { ...TURN, includeContent: false },
      call({ kind: "completed", text: "Hi", stopReason: "end_turn", toolCalls: [] }),
    );
    for (const key of Object.keys(properties)) {
      expect(["$ai_input", "$ai_tools", "$ai_output_choices"]).not.toContain(key);
    }
  });
});

describe("traceInput", () => {
  it("puts the system prompt first and leaves thinking's opaque blobs out", () => {
    const input = traceInput(request);
    expect(input[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "You are Cue." }],
    });
    const text = JSON.stringify(input);
    expect(text).toContain('"thinking":"hmm"');
    expect(text).not.toContain("opaque-signature");
    expect(text).not.toContain("opaque-data");
    expect(text).toContain("tool_result");
  });
});

describe("the turn's analytics (GRV-126)", () => {
  const project = createReferenceProject();
  const turn = {
    projectRevision: project.metadata.revision,
    messages: [{ role: "user", text: "Hi" }],
    context: buildAssistantPayload(project),
  };

  it("is optional, and refuses a field it does not name", () => {
    expect(assistantTurnRequestSchema.safeParse(turn).success).toBe(true);
    expect(
      assistantTurnRequestSchema.safeParse({
        ...turn,
        analytics: { productAnalytics: true, sessionId: "0192f3a1-7c2b" },
      }).success,
    ).toBe(true);
    expect(
      assistantTurnRequestSchema.safeParse({
        ...turn,
        analytics: { productAnalytics: true, email: "a@b.c" },
      }).success,
    ).toBe(false);
    expect(
      assistantTurnRequestSchema.safeParse({
        ...turn,
        analytics: { sessionId: "not a session id" },
      }).success,
    ).toBe(false);
  });

  it("counts a missing flag as declined", () => {
    const parsed = assistantTurnRequestSchema.parse(turn);
    expect(traceConsent(parsed)).toBe(false);
    expect(traceConsent({ ...parsed, analytics: {} })).toBe(false);
    expect(traceConsent({ ...parsed, analytics: { productAnalytics: true } })).toBe(true);
  });

  it("is traced under its conversation, or the fallback", () => {
    const parsed = assistantTurnRequestSchema.parse(turn);
    expect(traceIdFor(parsed, "fallback")).toBe("fallback");
    expect(
      traceIdFor(
        {
          ...parsed,
          session: {
            conversationId: "conv_abcdefgh",
            turnId: "turn_abcdefgh",
            projectId: "p",
            internal: false,
          },
        },
        "fallback",
      ),
    ).toBe("conv_abcdefgh");
  });

  it("is sent with the session only while analytics is allowed and the ID fits", () => {
    expect(turnAnalytics(true, "0192f3a1-7c2b")).toEqual({
      productAnalytics: true,
      sessionId: "0192f3a1-7c2b",
    });
    expect(turnAnalytics(false, "0192f3a1-7c2b")).toEqual({ productAnalytics: false });
    expect(turnAnalytics(true, null)).toEqual({ productAnalytics: true });
    expect(turnAnalytics(true, "has spaces in it")).toEqual({ productAnalytics: true });
  });
});
