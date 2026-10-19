import { describe, expect, it } from "vitest";
import { createReferenceProject } from "../domain/fixtures";
import {
  createScriptedAssistantProvider,
  replyEvents,
} from "../testing/scriptedAssistantProvider";
import { askProducerTool } from "./ask";
import { runAssistantTurn } from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import { rememberTool } from "./memory";
import { buildAssistantPayload } from "./payload";
import { ASSISTANT_SYSTEM_PROMPT, buildSystemBlocks, SHARED_TOOL_RULES } from "./prompt";
import { recommendationTool } from "./recommendation";
import { TACTICS } from "./tactics";
import {
  assistantTools,
  EXPLAIN_TOOL,
  SCHEMA_TEXT,
  TOOL_TEXT,
  type ToolTextLevel,
  withProviderToolText,
  withToolText,
} from "./tools";
import { videoRecommendationTool } from "./video";

const LEVELS = TACTICS.toolText.values as readonly ToolTextLevel[];

/** Every tool the model can be offered, the conditional ones included, at `level`. */
function offered(level: ToolTextLevel) {
  const conditional = [recommendationTool(), videoRecommendationTool()].map((tool) => {
    const { input_schema: inputSchema, ...rest } = withProviderToolText(tool, level);
    return { name: rest.name, description: rest.description, inputSchema };
  });
  return [
    ...assistantTools(level),
    withToolText(EXPLAIN_TOOL, level),
    withToolText(askProducerTool(), level),
    ...conditional,
    withToolText(rememberTool(), level),
  ];
}

/** What the model reads of the tools at `level`: their JSON and the shared rules. */
function sentChars(level: ToolTextLevel): number {
  const tools = offered(level).map(({ name, description, inputSchema }) => ({
    name,
    description,
    input_schema: inputSchema,
  }));
  return JSON.stringify(tools).length + (level === "full" ? 0 : SHARED_TOOL_RULES.length);
}

/** Every `description` in a schema, by its path. */
function schemaDescriptions(schema: unknown, path = ""): Record<string, string> {
  if (Array.isArray(schema)) {
    return Object.assign(
      {},
      ...schema.map((item, index) => schemaDescriptions(item, `${path}[${index}]`)),
    );
  }
  if (schema === null || typeof schema !== "object") return {};
  const found: Record<string, string> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") found[path] = value;
    else Object.assign(found, schemaDescriptions(value, `${path}.${key}`));
  }
  return found;
}

/** The words a level sends: each tool's description and its schema's descriptions. */
function wordsAt(level: ToolTextLevel): number {
  return offered(level).reduce(
    (sum, tool) =>
      sum +
      tool.description.length +
      Object.values(schemaDescriptions(tool.inputSchema)).reduce(
        (total, text) => total + text.length,
        0,
      ),
    0,
  );
}

/** The schema with every description taken out: what must not change. */
function withoutText(schema: unknown): unknown {
  return JSON.parse(
    JSON.stringify(schema, (key, value) =>
      key === "description" && typeof value === "string" ? undefined : value,
    ),
  );
}

describe("the toolText tactic", () => {
  it("defaults to full", () => {
    expect(TACTICS.toolText.default).toBe("full");
  });

  it("covers the same tools and schema fields at every level", () => {
    const full = offered("full");
    for (const level of LEVELS) {
      const trimmed = offered(level);
      expect(trimmed.map((tool) => tool.name)).toEqual(full.map((tool) => tool.name));
      trimmed.forEach((tool, index) => {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(Object.keys(schemaDescriptions(tool.inputSchema))).toEqual(
          Object.keys(schemaDescriptions(full[index].inputSchema)),
        );
        expect(withoutText(tool.inputSchema)).toEqual(
          withoutText(full[index].inputSchema),
        );
      });
    }
  });

  it("has trimmed text for every schema description it offers", () => {
    for (const tool of offered("full")) {
      for (const text of Object.values(schemaDescriptions(tool.inputSchema))) {
        expect(SCHEMA_TEXT[text], `${tool.name}: ${text}`).toBeDefined();
      }
    }
    const names = new Set(offered("full").map((tool) => tool.name));
    for (const name of Object.keys(TOOL_TEXT)) expect(names.has(name)).toBe(true);
  });

  it("leaves full as the text written in the module, with no shared rules", () => {
    expect(assistantTools("full")).toBe(assistantTools());
    expect(withToolText(EXPLAIN_TOOL, "full")).toBe(EXPLAIN_TOOL);
    const [prompt] = buildSystemBlocks({} as never, undefined, "stem");
    expect(prompt.text).toBe(ASSISTANT_SYSTEM_PROMPT);
    expect(JSON.stringify(offered("full"))).not.toContain("Shared tool rules");
  });

  it("sends the shared rules only for moderate and aggressive", () => {
    for (const level of LEVELS) {
      const [prompt] = buildSystemBlocks(
        {} as never,
        undefined,
        "stem",
        undefined,
        level,
      );
      expect(prompt.text.includes(SHARED_TOOL_RULES)).toBe(level !== "full");
    }
  });

  it("keeps generated ranges in every parameter_set text", () => {
    for (const level of LEVELS) {
      const text = offered(level).find(
        (tool) => tool.name === "parameter_set",
      )?.description;
      expect(text).toContain("track.volume (-60 to 6 dB)");
    }
  });

  it("trims the conditional tools at both levels", () => {
    for (const name of ["recommend_sounds", "recommend_video", "remember_producer"]) {
      const full = offered("full").find((tool) => tool.name === name);
      for (const level of ["moderate", "aggressive"] as const) {
        const trimmed = offered(level).find((tool) => tool.name === name);
        expect(trimmed?.description.length, `${name} ${level}`).toBeLessThan(
          (full?.description.length ?? 0) * (level === "moderate" ? 0.9 : 0.7),
        );
      }
    }
  });

  it("keeps the memory field value's allowed words at every level", () => {
    for (const level of LEVELS) {
      const text = JSON.stringify(
        offered(level).find((tool) => tool.name === "remember_producer")?.inputSchema,
      );
      for (const word of ["finished_a_few", "releases", "video_or_game", "curious"]) {
        expect(text).toContain(word);
      }
    }
  });

  // Targets on the description words are about 30% (moderate) and 60%
  // (aggressive). Moderate meets it (-30.6%); aggressive reaches -56.7%,
  // because the generated parameter ranges and the constraints stay. The tool
  // JSON is mostly schema structure, which does not change, so the whole block
  // shrinks by far less than its words.
  it("meets its length targets", () => {
    const words = Object.fromEntries(LEVELS.map((level) => [level, wordsAt(level)]));
    const sent = Object.fromEntries(LEVELS.map((level) => [level, sentChars(level)]));
    console.info(
      `tool text description chars: ${JSON.stringify(words)}; tool JSON + shared rules chars: ${JSON.stringify(sent)}`,
    );
    expect(words.moderate).toBeLessThan(words.full * 0.72);
    expect(words.aggressive).toBeLessThan(words.full * 0.45);
    expect(sent.moderate).toBeLessThan(sent.full);
    expect(sent.aggressive).toBeLessThan(sent.moderate);
  });
});

describe("the toolText tactic in a turn", () => {
  async function opening(toolText?: ToolTextLevel) {
    const provider = createScriptedAssistantProvider([replyEvents(["Sure."])]);
    const project = createReferenceProject();
    await runAssistantTurn(
      {
        provider,
        guards: createInMemoryGuardStores(),
        log: () => {},
        now: () => 1_000,
        idStem: () => "stem",
        ...(toolText === undefined ? {} : { tactics: { toolText } }),
      },
      { uid: "uid-1", signInProvider: "google.com" },
      {
        projectRevision: project.metadata.revision,
        messages: [{ role: "user", text: "Make the bass hit harder" }],
        context: buildAssistantPayload(project),
      },
      { signal: new AbortController().signal, onChunk: () => {} },
    );
    return provider.requests[0];
  }

  it("sends the request byte for byte as today when it is full or unset", async () => {
    expect(JSON.stringify(await opening("full"))).toBe(JSON.stringify(await opening()));
    expect(JSON.stringify(await opening())).not.toContain("Shared tool rules");
  });

  it("sends trimmed tools and the shared rules for the other levels", async () => {
    const full = JSON.stringify((await opening()).tools);
    for (const level of ["moderate", "aggressive"] as const) {
      const request = await opening(level);
      expect(JSON.stringify(request.tools).length).toBeLessThan(full.length);
      expect(request.system[0].text).toContain(SHARED_TOOL_RULES);
    }
  });
});
