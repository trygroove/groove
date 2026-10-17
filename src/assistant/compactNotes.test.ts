import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ID_PREFIXES } from "../domain/ids";
import {
  compactClipSchema,
  compactNoteSchema,
  createNoteExpander,
  gatewayNoteId,
  MAX_TURN_NOTES,
  noteEventOf,
} from "./compactNotes";
import { NEW_ID_COUNTER_DIGITS, newId } from "./prompt";
import {
  assistantTools,
  CREATE_EXAMPLES,
  OFFERED_CLIP_EXAMPLE,
  resolveToolCall,
} from "./tools";

const STEM = "Stem0000000000000";
const PAD = "pad_Kick00000000000000001";

function noteAdd(notes: unknown[]) {
  return {
    id: "toolu_1",
    name: "note_add",
    input: { clipId: CREATE_EXAMPLES.clip.id, notes },
  };
}

describe("a compact note (GRV-131)", () => {
  it("stands for a pitched note or a pad hit, its probability null unless given", () => {
    expect(noteEventOf([0, 36, 192, 0.8] as never, "evt_x")).toEqual({
      id: "evt_x",
      trigger: { kind: "pitch", pitch: 36 },
      startTicks: 0,
      durationTicks: 192,
      velocity: 0.8,
      probability: null,
    });
    expect(noteEventOf([48, PAD, 24, 1, 0.5] as never, "evt_y")).toMatchObject({
      trigger: { kind: "pad", padId: PAD },
      probability: 0.5,
    });
  });
});

describe("createNoteExpander", () => {
  it("numbers the turn's notes from its stem across calls, in the order they come", () => {
    const notes = createNoteExpander(STEM);
    const first = notes.expand(
      noteAdd([
        [0, 36, 192, 0.8],
        [192, PAD, 48, 0.9],
      ]),
    );
    const second = notes.expand({ ...noteAdd([[384, 38, 96, 0.5]]), id: "toolu_2" });
    const ids = [first, second].flatMap((result) =>
      result.ok
        ? (result.call.input as { notes: { id: string }[] }).notes.map((n) => n.id)
        : [],
    );
    expect(ids).toEqual([
      "evt_Stem0000000000000n001",
      "evt_Stem0000000000000n002",
      "evt_Stem0000000000000n003",
    ]);
    // A fresh turn with the same stem and calls makes the same notes.
    expect(
      createNoteExpander(STEM).expand(
        noteAdd([
          [0, 36, 192, 0.8],
          [192, PAD, 48, 0.9],
        ]),
      ),
    ).toEqual(first);
  });

  it("writes out exactly what the tool then accepts", () => {
    for (const call of [
      noteAdd([[0, 36, 192, 0.8]]),
      { id: "toolu_1", name: "clip_create", input: OFFERED_CLIP_EXAMPLE },
    ]) {
      const expanded = createNoteExpander(STEM).expand(call);
      if (!expanded.ok) throw new Error(expanded.message);
      expect(resolveToolCall(expanded.call.name, expanded.call.input).ok).toBe(true);
      // The compact input itself is not a payload the browser accepts.
      expect(resolveToolCall(call.name, call.input).ok).toBe(false);
    }
  });

  it("leaves a call with no compact notes as it is", () => {
    const notes = createNoteExpander(STEM);
    const written = { id: "toolu_1", name: "clip_create", input: CREATE_EXAMPLES.clip };
    const audio = {
      id: "toolu_2",
      name: "clip_create",
      input: { ...CREATE_EXAMPLES.clip, content: { kind: "audioLoop" } },
    };
    const mute = { id: "toolu_3", name: "track_setFlag", input: { flag: "muted" } };
    for (const call of [written, audio, mute, noteAdd([])]) {
      expect(notes.expand(call)).toEqual({ ok: true, call, noteIds: [] });
    }
    // None of them used up a note ID.
    const next = notes.expand(noteAdd([[0, 36, 192, 0.8]]));
    expect(next.ok && JSON.stringify(next.call.input)).toContain(
      "evt_Stem0000000000000n001",
    );
  });

  it("keeps a note written out as an event beside compact ones, for the tool to judge", () => {
    const event = CREATE_EXAMPLES.clip.content.events[0];
    const expanded = createNoteExpander(STEM).expand(noteAdd([event, [0, 40, 96, 0.8]]));
    expect(expanded.ok && (expanded.call.input as { notes: unknown[] }).notes[0]).toEqual(
      event,
    );
  });

  it.each([
    [[[0, 128, 192, 0.8]], "notes.0.1:"],
    [[[0, 36, 0, 0.8]], "notes.0.2:"],
    [[[0, 36, 192, 1.5]], "notes.0.3:"],
    [[[0, 36, 192]], "notes.0"],
    [[[0, "trk_NotAPad000000000000001", 192, 0.8]], "notes.0.1:"],
  ])("refuses %j, saying where", (notes, where) => {
    const expanded = createNoteExpander(STEM).expand(noteAdd(notes));
    expect(expanded.ok).toBe(false);
    if (!expanded.ok) {
      expect(expanded.message).toContain(where);
      expect(expanded.message).toContain(
        "a note is [startTicks, pitch or padId, durationTicks, velocity]",
      );
    }
  });

  it("numbers its notes where the model's own new IDs never reach", () => {
    // The model counts in digits only (notes_duplicate's newIds); the
    // gateway's counter starts with a letter, so no index meets another.
    const model = new Set(
      Array.from({ length: 10 ** NEW_ID_COUNTER_DIGITS - 1 }, (_, index) =>
        newId(ID_PREFIXES.event, STEM, index + 1),
      ),
    );
    for (const index of [1, 2, 10, 100, MAX_TURN_NOTES]) {
      const id = gatewayNoteId(STEM, index);
      expect(id).toHaveLength(newId(ID_PREFIXES.event, STEM, 1).length);
      expect(model.has(id)).toBe(false);
    }
  });

  it("uses up note IDs only for a call its check accepts", () => {
    const notes = createNoteExpander(STEM);
    const refused = notes.expand(noteAdd([[0, 36, 192, 0.8]]), () => "no such clip");
    expect(refused).toEqual({ ok: false, message: "no such clip" });
    const accepted = notes.expand(noteAdd([[0, 36, 192, 0.8]]), () => null);
    expect(accepted).toMatchObject({ ok: true, noteIds: [gatewayNoteId(STEM, 1)] });
    // A call with no compact notes is judged by the check too.
    expect(
      notes.expand({ id: "toolu_2", name: "track_setFlag", input: {} }, () => "bad"),
    ).toEqual({ ok: false, message: "bad" });
  });

  it("refuses more notes in a turn than its IDs can number", () => {
    const notes = createNoteExpander(STEM);
    const many = Array.from({ length: MAX_TURN_NOTES }, (_, index) => [
      index,
      36,
      1,
      0.5,
    ]);
    expect(notes.expand(noteAdd(many)).ok).toBe(true);
    expect(notes.expand(noteAdd([[0, 36, 1, 0.5]]))).toMatchObject({ ok: false });
  });
});

describe("compactNoteSchema", () => {
  it("takes nothing after the probability, and says so in the schema it offers", () => {
    expect(compactNoteSchema.safeParse([0, 36, 192, 0.8, 0.5]).success).toBe(true);
    expect(compactNoteSchema.safeParse([0, 36, 192, 0.8, 0.5, 1]).success).toBe(false);
    expect(z.toJSONSchema(compactNoteSchema, { io: "input" })).toMatchObject({
      items: { not: {} },
    });
  });
});

describe("the tools that take notes", () => {
  const schemaOf = (name: string) =>
    JSON.stringify(assistantTools().find((tool) => tool.name === name)?.inputSchema);

  it("offer them as arrays with no ID", () => {
    for (const name of ["clip_create", "note_add"]) {
      expect(schemaOf(name)).toContain("prefixItems");
      expect(schemaOf(name)).not.toContain('"trigger"');
    }
    expect(compactClipSchema.safeParse(OFFERED_CLIP_EXAMPLE).success).toBe(true);
  });

  it("say so in their descriptions", () => {
    for (const name of ["clip_create", "note_add"]) {
      const tool = assistantTools().find((entry) => entry.name === name);
      expect(tool?.description).toContain("[startTicks, pitch, durationTicks, velocity]");
    }
  });
});
