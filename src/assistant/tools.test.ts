import { describe, expect, it } from "vitest";
import { COMMAND_TYPES, findCommand } from "../commands/registry";
import { createNoteExpander } from "./compactNotes";
import {
  APPENDIX_A_FAMILIES,
  ASSISTANT_CAPABILITIES,
  ASSISTANT_COMMAND_TYPES,
  ASSISTANT_TOOLSET_VERSION,
  assistantTools,
  bundleTools,
  CREATE_EXAMPLES,
  EVERYTHING_BUNDLE,
  EXPLAIN_TOOL,
  EXPLAIN_TOOL_NAME,
  isNeedMoreToolsCall,
  NEED_MORE_TOOLS_NAME,
  NEED_MORE_TOOLS_TOOL,
  NON_ASSISTANT_COMMANDS,
  OFFERED_CLIP_EXAMPLE,
  PROPOSAL_CAPABILITIES,
  proposalCapability,
  proposalExplanationSchema,
  resolveToolCall,
  TOOL_BUNDLE_IDS,
  TOOL_BUNDLES,
  type ToolBundleId,
  toolCallsFor,
  toolNameFor,
} from "./tools";

describe("the assistant's tool set", () => {
  it("is versioned", () => {
    // At least the version GRV-140 shipped with, not equal to it: a tactic
    // that alters the tools bumps it when its experiment wins (experimentPr.ts),
    // and that PR must pass without editing this test.
    expect(Number.isInteger(ASSISTANT_TOOLSET_VERSION)).toBe(true);
    expect(ASSISTANT_TOOLSET_VERSION).toBeGreaterThanOrEqual(9);
  });

  it("maps every Appendix A family the PRD named", () => {
    // The original list (PRD Appendix A, before it moved out of docs/prd.md).
    expect(Object.keys(APPENDIX_A_FAMILIES).sort()).toEqual(
      [
        "project.setTempo",
        "track.add",
        "track.update",
        "track.move",
        "track.duplicate",
        "track.remove",
        "clip.add",
        "clip.update",
        "clip.duplicate",
        "clip.remove",
        "note.add",
        "note.update",
        "note.transform",
        "note.remove",
        "placement.add",
        "placement.update",
        "placement.duplicate",
        "placement.remove",
        "section.add",
        "section.update",
        "section.move",
        "section.remove",
        "instrument.set",
        "instrument.setParameter",
        "device.add",
        "device.update",
        "device.move",
        "device.duplicate",
        "device.remove",
        "send.setLevel",
        "return.add",
        "return.update",
        "return.remove",
        "automation.addLane",
        "automation.setPoints",
        "automation.transform",
        "automation.removeLane",
        "mixer.setParameter",
        "transaction.apply",
      ].sort(),
    );
    // Only the families with no command yet are unavailable.
    const unavailable = Object.entries(APPENDIX_A_FAMILIES)
      .filter(([, capability]) => capability === "unavailable")
      .map(([family]) => family.split(".")[0]);
    expect(new Set(unavailable)).toEqual(new Set(["section", "automation"]));
  });

  it("gives every capability at least one tool, and every tool a capability", () => {
    const covered = new Set(assistantTools().flatMap((tool) => tool.capabilities));
    expect([...covered].sort()).toEqual([...ASSISTANT_CAPABILITIES].sort());
    expect(new Set(Object.values(APPENDIX_A_FAMILIES))).toEqual(
      new Set([...ASSISTANT_CAPABILITIES, "transaction", "unavailable"]),
    );
  });

  it("decides about every registered command: allowlisted or refused, never both", () => {
    // A command added to the registry fails here until it is given a decision.
    const allowlisted = new Set(ASSISTANT_COMMAND_TYPES);
    const refused = new Set(Object.keys(NON_ASSISTANT_COMMANDS));
    for (const type of allowlisted) expect(refused.has(type), type).toBe(false);
    expect([...allowlisted, ...refused].sort()).toEqual([...COMMAND_TYPES].sort());
  });

  it("offers one tool per allowlisted command, named for it and generated from its schema", () => {
    const tools = assistantTools();
    expect(tools.map((tool) => tool.commandType)).toEqual([...ASSISTANT_COMMAND_TYPES]);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.name).toBe(toolNameFor(tool.commandType));
      expect(tool.commandVersion).toBe(findCommand(tool.commandType)?.version);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema).not.toHaveProperty("$schema");
      // Strict payloads stay strict for the model too.
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("offers no tool for a refused command", () => {
    const names = new Set(assistantTools().map((tool) => tool.name));
    for (const type of Object.keys(NON_ASSISTANT_COMMANDS)) {
      expect(names.has(toolNameFor(type)), type).toBe(false);
      expect(resolveToolCall(toolNameFor(type), {})).toMatchObject({
        ok: false,
        code: "unknown_tool",
      });
    }
  });

  it("names the exact parameter IDs parameter_set takes, so a model need not guess them", () => {
    const tool = assistantTools().find((entry) => entry.name === "parameter_set");
    for (const id of [
      "song.tempo",
      "song.swing",
      "track.volume (-60 to 6 dB)",
      "track.pan (-1 to 1, -1 left to 1 right)",
      "track.sendLevel",
      "return.volume",
      "master.volume",
      // An instrument parameter is named without its instrument's prefix.
      "filterCutoff",
      "sampleStart",
    ]) {
      expect(tool?.description).toContain(id);
    }
    expect(tool?.description).not.toContain("synth.filterCutoff");
  });

  it("offers explain_change beside the command tools, taking a goal and a technique", () => {
    expect(assistantTools().map((tool) => tool.name)).not.toContain(EXPLAIN_TOOL_NAME);
    expect(EXPLAIN_TOOL.inputSchema).toMatchObject({
      type: "object",
      required: ["goal", "technique"],
    });
    expect(
      proposalExplanationSchema.safeParse({ goal: "  ", technique: "Swing" }).success,
    ).toBe(false);
  });

  it("does not echo an over-long tool name back in full", () => {
    const resolution = resolveToolCall("x".repeat(500), {});
    expect(resolution.ok ? "" : resolution.message.length).toBeLessThan(100);
  });
});

describe("flat create tools (GRV-90)", () => {
  const CASES = [
    ["track_create", "track.create", CREATE_EXAMPLES.track],
    ["clip_create", "clip.create", OFFERED_CLIP_EXAMPLE],
    ["placement_create", "placement.create", CREATE_EXAMPLES.placement],
  ] as const;

  it.each(CASES)(
    "%s accepts the flat input its description shows, its notes written out",
    (name, type, example) => {
      const expanded = createNoteExpander("BassNote000000000").expand({
        id: "toolu_1",
        name,
        input: example,
      });
      if (!expanded.ok) throw new Error(expanded.message);
      expect(resolveToolCall(name, expanded.call.input)).toMatchObject({
        ok: true,
        commandType: type,
      });
      const tool = assistantTools().find((entry) => entry.name === name);
      expect(tool?.description).toContain(JSON.stringify(example));
    },
  );

  it("never shows the model the written-out clip, whose note carries an ID", () => {
    const shown = JSON.stringify(assistantTools());
    expect(shown).not.toContain(CREATE_EXAMPLES.clip.content.events[0].id);
  });

  it("offers the entity's own fields at the top level of each schema", () => {
    const keys = (name: string) =>
      Object.keys(
        (assistantTools().find((tool) => tool.name === name)?.inputSchema.properties ??
          {}) as object,
      );
    expect(keys("track_create")).toEqual(Object.keys(CREATE_EXAMPLES.track));
    expect(keys("clip_create")).toEqual(Object.keys(CREATE_EXAMPLES.clip));
    expect(keys("placement_create")).toEqual(Object.keys(CREATE_EXAMPLES.placement));
  });

  it("turns each into its command's payload, with nothing nested", () => {
    expect(resolveToolCall("track_create", CREATE_EXAMPLES.track)).toMatchObject({
      payload: {
        track: CREATE_EXAMPLES.track,
        clips: [],
        placements: [],
        automation: [],
      },
    });
    expect(resolveToolCall("clip_create", CREATE_EXAMPLES.clip)).toMatchObject({
      payload: { clip: CREATE_EXAMPLES.clip, placements: [] },
    });
    expect(resolveToolCall("placement_create", CREATE_EXAMPLES.placement)).toMatchObject({
      payload: { placement: CREATE_EXAMPLES.placement },
    });
  });

  it("cannot carry automation lanes on a new track", () => {
    const lane = { id: "aut_Lane00000000000000001", interpolation: "linear", points: [] };
    const resolution = resolveToolCall("track_create", {
      ...CREATE_EXAMPLES.track,
      automation: [lane],
    });
    expect(resolution).toMatchObject({ ok: false, code: "invalid_payload" });
  });

  it("makes a create command that carries its children into one call each, in order", () => {
    const calls = toolCallsFor({
      type: "track.create",
      payload: {
        track: CREATE_EXAMPLES.track,
        clips: [CREATE_EXAMPLES.clip],
        placements: [CREATE_EXAMPLES.placement],
      },
    });
    expect(calls).toEqual([
      { name: "track_create", input: CREATE_EXAMPLES.track },
      { name: "clip_create", input: CREATE_EXAMPLES.clip },
      { name: "placement_create", input: CREATE_EXAMPLES.placement },
    ]);
    expect(calls.every((call) => resolveToolCall(call.name, call.input).ok)).toBe(true);
    expect(toolCallsFor({ type: "track.delete", payload: { trackId: "x" } })).toEqual([
      { name: "track_delete", input: { trackId: "x" } },
    ]);
  });

  it("refuses the old nested payload, naming the flat fields it lacks", () => {
    const resolution = resolveToolCall("track_create", {
      track: CREATE_EXAMPLES.track,
      clips: [CREATE_EXAMPLES.clip],
    });
    expect(resolution).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(resolution.ok ? "" : resolution.message).toContain("id:");
    expect(resolution.ok ? "" : resolution.message).toContain("Unrecognized keys");
  });
});

describe("proposalCapability", () => {
  it("is the one capability every call shares, or mixed", () => {
    expect(proposalCapability(["notes", "notes"])).toBe("notes");
    expect(proposalCapability(["notes", "mixer"])).toBe("mixed");
    expect(PROPOSAL_CAPABILITIES).toEqual([...ASSISTANT_CAPABILITIES, "mixed"]);
  });
});

describe("toolNameFor", () => {
  it("replaces every dot, so a deeper command type still makes a legal name", () => {
    expect(toolNameFor("note.add")).toBe("note_add");
    expect(toolNameFor("a.b.c")).toBe("a_b_c");
  });
});

describe("tool bundles (GRV-143)", () => {
  const focused = TOOL_BUNDLE_IDS.filter((id) => id !== EVERYTHING_BUNDLE);

  it("are a few fixed bundles, everything among them and last", () => {
    expect(TOOL_BUNDLE_IDS).toEqual(["mix", "notes", "arrange", "everything"]);
    expect([...TOOL_BUNDLES.everything]).toEqual([...ASSISTANT_COMMAND_TYPES]);
  });

  it("put every tool in at least one bundle short of everything", () => {
    const covered = new Set(focused.flatMap((id) => [...TOOL_BUNDLES[id]]));
    for (const type of ASSISTANT_COMMAND_TYPES)
      expect(covered.has(type), type).toBe(true);
  });

  it("name only allowlisted commands, each once, and are smaller than every tool", () => {
    for (const id of TOOL_BUNDLE_IDS) {
      const types: readonly string[] = TOOL_BUNDLES[id];
      expect(new Set(types).size, id).toBe(types.length);
      for (const type of types) expect(ASSISTANT_COMMAND_TYPES, id).toContain(type);
    }
    for (const id of focused) {
      expect(TOOL_BUNDLES[id].length, id).toBeLessThan(ASSISTANT_COMMAND_TYPES.length);
    }
  });

  it("offer their tools in the registry's order, as assistantTools generates them", () => {
    for (const id of TOOL_BUNDLE_IDS) {
      const tools = bundleTools(id);
      const all = assistantTools();
      expect(tools.map((tool) => tool.commandType)).toEqual(
        all
          .map((tool) => tool.commandType)
          .filter((type) => (TOOL_BUNDLES[id] as readonly string[]).includes(type)),
      );
      for (const tool of tools) expect(all).toContain(tool);
    }
    expect(bundleTools(EVERYTHING_BUNDLE)).toBe(assistantTools());
  });

  it("keep each bundle's tool block byte-stable, at every tactic value", () => {
    for (const id of TOOL_BUNDLE_IDS) {
      for (const level of ["full", "moderate", "aggressive"] as const) {
        for (const steps of ["off", "on"] as const) {
          const first = bundleTools(id as ToolBundleId, level, steps, "off");
          // The same array every time, so the same bytes.
          expect(bundleTools(id as ToolBundleId, level, steps, "off")).toBe(first);
          expect(JSON.stringify(first)).toBe(
            JSON.stringify(
              assistantTools(level, steps, "off").filter((tool) =>
                first.some((entry) => entry.name === tool.name),
              ),
            ),
          );
        }
      }
    }
  });

  it("offer need_more_tools: a call that takes nothing and is no command", () => {
    expect(NEED_MORE_TOOLS_TOOL.name).toBe(NEED_MORE_TOOLS_NAME);
    expect(NEED_MORE_TOOLS_TOOL.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(assistantTools().map((tool) => tool.name)).not.toContain(NEED_MORE_TOOLS_NAME);
    expect(isNeedMoreToolsCall({ name: NEED_MORE_TOOLS_NAME })).toBe(true);
    expect(isNeedMoreToolsCall({ name: "parameter_set" })).toBe(false);
    expect(resolveToolCall(NEED_MORE_TOOLS_NAME, {})).toMatchObject({
      ok: false,
      code: "unknown_tool",
    });
  });
});
