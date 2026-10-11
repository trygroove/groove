import { describe, expect, it } from "vitest";
import { ASSISTANT_MODEL_ID, ASSISTANT_MODELS, type AssistantModelId } from "./config";
import {
  buildProviderRequest,
  type ProviderRequestParts,
  providerTools,
} from "./providerRequest";
import { assistantTools } from "./tools";

const parts: ProviderRequestParts = {
  system: [{ type: "text", text: "system" }],
  messages: [{ role: "user", content: "hello" }],
  tools: [
    {
      name: "track_setFlag",
      description: "Mute a track.",
      input_schema: { type: "object", properties: {} },
      eager_input_streaming: true,
    },
  ],
  pseudonymousUserId: "abc123",
};

/**
 * One test per configured model (ADR 0006 decision 3). Adding a model to
 * `ASSISTANT_MODELS` without pinning its request here fails the last test.
 */
const PINNED: Record<AssistantModelId, () => void> = {
  "claude-sonnet-5": () => {
    expect(buildProviderRequest(ASSISTANT_MODELS["claude-sonnet-5"], parts)).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 16_000,
      stream: true,
      system: parts.system,
      messages: parts.messages,
      tools: parts.tools,
      metadata: { user_id: "abc123" },
      // Summarized, so a long think streams rather than going silent (GRV-6).
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
    });
  },
  "claude-haiku-4-5": () => {
    const body = buildProviderRequest(ASSISTANT_MODELS["claude-haiku-4-5"], parts);
    expect(body).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 16_000,
      stream: true,
      system: parts.system,
      messages: parts.messages,
      tools: parts.tools,
      metadata: { user_id: "abc123" },
      thinking: { type: "enabled", budget_tokens: 4_096 },
    });
    // Haiku 4.5 rejects `effort`; the budget must sit under `max_tokens`.
    expect(body).not.toHaveProperty("output_config");
    expect(body.thinking.type === "enabled" && body.thinking.budget_tokens).toBeLessThan(
      body.max_tokens,
    );
  },
};

describe("buildProviderRequest", () => {
  it("shapes Claude Sonnet 5's request: adaptive thinking and an effort", () => {
    PINNED["claude-sonnet-5"]();
  });

  it("shapes Claude Haiku 4.5's request: a thinking budget and no effort", () => {
    PINNED["claude-haiku-4-5"]();
  });

  it("pins a request shape for every configured model", () => {
    expect(Object.keys(PINNED).sort()).toEqual(Object.keys(ASSISTANT_MODELS).sort());
  });

  it("answers with a configured model", () => {
    expect(ASSISTANT_MODELS[ASSISTANT_MODEL_ID]).toBeDefined();
  });
});

describe("providerTools", () => {
  it("puts every assistant tool in the wire shape, with an object input", () => {
    const tools = providerTools(assistantTools());
    expect(tools.map((tool) => tool.name)).toEqual(
      assistantTools().map((tool) => tool.name),
    );
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema).not.toHaveProperty("$schema");
      // A large proposal streams as it is written, not after a silence (GRV-6).
      expect(tool.eager_input_streaming).toBe(true);
    }
  });

  it("refuses a tool whose input is not an object", () => {
    const [tool] = assistantTools();
    expect(() => providerTools([{ ...tool, inputSchema: { type: "string" } }])).toThrow(
      TypeError,
    );
  });
});
