import { describe, expect, it } from "vitest";
import { COMMAND_TYPES, findCommand } from "../commands/registry";
import { createNoteExpander } from "./compactNotes";
import {
  APPENDIX_A_FAMILIES,
  ASSISTANT_CAPABILITIES,
  ASSISTANT_COMMAND_TYPES,
  ASSISTANT_TOOLSET_VERSION,
  assistantTools,
  CREATE_EXAMPLES,
  EXPLAIN_TOOL,
  EXPLAIN_TOOL_NAME,
  NON_ASSISTANT_COMMANDS,
  OFFERED_CLIP_EXAMPLE,
  PROPOSAL_CAPABILITIES,
  proposalCapability,
  proposalExplanationSchema,
  resolveToolCall,
  toolCallsFor,
  toolNameFor,
} from "./tools";

describe("the assistant's tool set", () => {
  it("is versioned", () => {
    expect(ASSISTANT_TOOLSET_VERSION).toBe(9);
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
