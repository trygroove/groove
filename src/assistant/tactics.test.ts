import { describe, expect, it } from "vitest";
import { createReferenceProject } from "../domain/fixtures";
import {
  createScriptedAssistantProvider,
  replyEvents,
} from "../testing/scriptedAssistantProvider";
import { ASSISTANT_MODELS } from "./config";
import { runAssistantTurn } from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import { buildAssistantPayload } from "./payload";
import { buildProviderRequest, type ProviderRequestParts } from "./providerRequest";
import {
  describeTactics,
  nonDefaultTactics,
  parseTacticAssignment,
  parseTacticOverrides,
  resolveTactics,
  TACTIC_DEFAULTS,
  TACTIC_IDS,
  TACTICS,
  type TacticOverrides,
} from "./tactics";

/**
 * These tests are written against production's current default, never a
 * literal, so the framework's win PR (which flips a default) leaves them
 * green. `OFF` is a value that is not the default.
 */
const DEFAULT = TACTIC_DEFAULTS.thinkingEffort;
const OFF = TACTICS.thinkingEffort.values.find((value) => value !== DEFAULT) as string;

const parts: ProviderRequestParts = {
  system: [{ type: "text", text: "system" }],
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  pseudonymousUserId: "abc123",
};

/** The JSON of the request one gateway turn opens with, under `tactics`. */
async function openingRequest(tactics?: TacticOverrides): Promise<string> {
  const provider = createScriptedAssistantProvider([replyEvents(["Sure."])]);
  const project = createReferenceProject();
  await runAssistantTurn(
    {
      provider,
      guards: createInMemoryGuardStores(),
      log: () => {},
      now: () => 1_000,
      idStem: () => "stem",
      ...(tactics === undefined ? {} : { tactics }),
    },
    { uid: "uid-1", signInProvider: "google.com" },
    {
      projectRevision: project.metadata.revision,
      messages: [{ role: "user", text: "Make the bass hit harder" }],
      context: buildAssistantPayload(project),
    },
    { signal: new AbortController().signal, onChunk: () => {} },
  );
  return JSON.stringify(provider.requests[0]);
}

describe("the tactic registry", () => {
  it("gives every tactic a one-line description, its values and a default among them", () => {
    expect(TACTIC_IDS).toContain("thinkingEffort");
    for (const id of TACTIC_IDS) {
      const tactic = TACTICS[id];
      expect(tactic.description).not.toMatch(/\n/);
      expect(tactic.description.length).toBeGreaterThan(0);
      expect(new Set(tactic.values).size).toBe(tactic.values.length);
      expect(tactic.values as readonly string[]).toContain(tactic.default);
      expect(tactic.alters.length).toBeGreaterThan(0);
    }
  });

  it("offers thinkingEffort as low, medium and high, production's default among them", () => {
    expect(TACTICS.thinkingEffort.values).toEqual(["low", "medium", "high"]);
    expect(TACTICS.thinkingEffort.values as readonly string[]).toContain(DEFAULT);
  });

  it("resolves overrides over the defaults, and names only the values that differ", () => {
    expect(resolveTactics()).toEqual(TACTIC_DEFAULTS);
    const off = { thinkingEffort: OFF } as TacticOverrides;
    expect(resolveTactics(off)).toEqual({ ...TACTIC_DEFAULTS, ...off });
    expect(nonDefaultTactics({ thinkingEffort: DEFAULT })).toEqual({});
    expect(nonDefaultTactics(off)).toEqual(off);
    expect(describeTactics(TACTIC_DEFAULTS)).toBe(`thinkingEffort=${DEFAULT}`);
    expect(describeTactics(off)).toBe(`thinkingEffort=${OFF} (default ${DEFAULT})`);
  });

  it("parses id=value, and refuses an unknown tactic or value", () => {
    expect(parseTacticAssignment("thinkingEffort=high")).toEqual({
      thinkingEffort: "high",
    });
    expect(() => parseTacticAssignment("thinkingEffort")).toThrow(/id=value/);
    expect(() => parseTacticAssignment("=low")).toThrow(/id=value/);
    expect(() => parseTacticAssignment("thinkingEffort=")).toThrow(/id=value/);
    expect(() => parseTacticOverrides({ thinkingEffort: "max" })).toThrow(
      /takes low \| medium \| high/,
    );
    expect(() => parseTacticOverrides({ verbosity: "low", thinkingEffort: 3 })).toThrow(
      /Unknown tactic "verbosity".*not 3/,
    );
  });
});

describe("a tactic's default", () => {
  it("leaves the provider request byte-for-byte as production builds it", () => {
    for (const model of Object.values(ASSISTANT_MODELS)) {
      const production = JSON.stringify(buildProviderRequest(model, parts));
      expect(JSON.stringify(buildProviderRequest(model, parts, resolveTactics()))).toBe(
        production,
      );
      expect(
        JSON.stringify(
          buildProviderRequest(model, parts, resolveTactics({ thinkingEffort: DEFAULT })),
        ),
      ).toBe(production);
    }
    // Pinned as production sent it before tactics existed, built with that
    // effort spelled out so a later change of default leaves the pin standing.
    expect(
      JSON.stringify(
        buildProviderRequest(
          ASSISTANT_MODELS["claude-sonnet-5"],
          parts,
          resolveTactics({ thinkingEffort: "medium" }),
        ),
      ),
    ).toBe(
      '{"model":"claude-sonnet-5","max_tokens":16000,"stream":true,"system":[{"type":"text","text":"system","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"hello"}],"cache_control":{"type":"ephemeral"},"tools":[],"metadata":{"user_id":"abc123"},"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":"medium"}}',
    );
  });

  it("leaves the gateway's whole request unchanged, and a value changes only what it says", async () => {
    const production = await openingRequest();
    expect(await openingRequest({})).toBe(production);
    expect(await openingRequest(TACTIC_DEFAULTS)).toBe(production);
    const off = await openingRequest({ thinkingEffort: OFF } as TacticOverrides);
    expect(off).not.toBe(production);
    expect(off.replace(`"effort":"${OFF}"`, `"effort":"${DEFAULT}"`)).toBe(production);
  });

  it("is not an effort a budget-thinking model is sent", () => {
    const body = buildProviderRequest(
      ASSISTANT_MODELS["claude-haiku-4-5"],
      parts,
      resolveTactics({ thinkingEffort: "low" }),
    );
    expect(body).not.toHaveProperty("output_config");
  });
});
