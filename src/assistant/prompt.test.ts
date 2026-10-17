import { describe, expect, it } from "vitest";
import { deviceTypes } from "../domain/devices";
import { ENTITY_KINDS, ID_PREFIXES, idPattern } from "../domain/ids";
import { bareParameterId, SYNTH_PARAMETERS } from "../domain/parameters";
import { MINIMAL_ASSISTANT_CONTEXT } from "../testing/scriptedAssistantProvider";
import {
  ASSISTANT_PROMPT_VERSION,
  ASSISTANT_SYSTEM_PROMPT,
  buildSystemBlocks,
  createIdStem,
  describeParameter,
  newId,
} from "./prompt";

describe("the assistant's system prompt", () => {
  it("is versioned by date", () => {
    expect(ASSISTANT_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  // GRV-91: a loop sketch must fit the output limit, so each part is one looped bar.
  it("tells a loop sketch to use one-bar clips looped to the loop's length", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("one clip of one bar");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "looped: true and durationTicks the loop's full length",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("never place a part once per bar");
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("four at most");
  });

  // GRV-99: a request to change a drum part's density can point at the Generate panel.
  it("tells the assistant where the Generate panel is", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "a Generate panel in the row of panels below its step grid, beside Transform",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "try more patterns for a row in the Generate panel",
    );
  });

  // GRV-122: "make the hi-hats busier" looked for a hi-hat track and blamed a stale snapshot.
  it("finds a drum sound as a pad by name, from its hit count and its hits", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "is a pad on a drum machine track, not a track of its own",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "A pad's \"noteCount\" is how many hits that track's clips give it",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "the producer's selection or the track in scope",
    );
  });

  it("says the description is never stale, whatever an earlier reply said", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "never say your view of the project has not refreshed",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "look for it again in the description, which is newer than that reply",
    );
  });

  // GRV-101: the prompt names every panel the producer can use, so a new one is added here and there.
  it("names each of the app's panels in 'What Groove has'", () => {
    const section =
      ASSISTANT_SYSTEM_PROMPT.split("## What Groove has")[1]?.split("\n## ")[0];
    expect(section).toBeDefined();
    const panels = [
      "Synth",
      "Drum machine",
      "Sampler",
      "Step editor",
      "Piano roll",
      "Generate panel",
      "Transform panel",
      "Loop panel",
      "Library",
      "My packs",
      "Mixer",
      "device chain",
      "Sends",
      "Returns",
      "Master",
      "level meter",
      "Sections",
      "loop brace",
      "metronome",
      "Export dialog",
    ];
    for (const panel of panels) {
      expect(section, panel).toContain(panel);
    }
    expect(section?.trim().split("\n").length).toBeLessThanOrEqual(25);
  });

  it("no longer says audio cannot exist", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain(
      "You cannot add, generate or upload audio",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Groove has audio (loops and samples)");
  });

  // GRV-101 QA: the live eval scored the Generate pointer 0/3 while it was optional.
  it("always points a drum density or rhythm request at the Generate panel", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Whenever a request is about a drum part's density or rhythm",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("you may add in a sentence");
  });

  // GRV-101 QA: notes.transpose skips pad triggers, so the prompt must not promise it.
  it("says Transform's transpose leaves pad hits alone", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Transpose moves pitched notes only");
  });

  // GRV-101 QA: replies said "recommend_sounds" and "notes_quantize" to the producer.
  it("keeps tool names out of the producer's words", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("never by a tool's name");
    const section =
      ASSISTANT_SYSTEM_PROMPT.split("## What Groove has")[1]?.split("\n## ")[0] ?? "";
    expect(section).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  });

  it("lists every device type and every one of its parameters by key", () => {
    for (const device of deviceTypes()) {
      const line = ASSISTANT_SYSTEM_PROMPT.split("\n").find((candidate) =>
        candidate.startsWith(`- ${device.type} (`),
      );
      expect(line, device.type).toBeDefined();
      for (const parameter of device.parameters) {
        expect(line).toContain(describeParameter(parameter));
      }
    }
  });

  it("lists the synth's parameters by key", () => {
    for (const parameter of SYNTH_PARAMETERS) {
      expect(ASSISTANT_SYSTEM_PROMPT).toContain(`${bareParameterId(parameter.id)} `);
    }
  });

  // GRV-6: the model cannot count out 21 characters, so it never has to.
  it("makes every new ID from a stem and a counter, in exactly the shape the tools accept", () => {
    const stem = createIdStem();
    for (const kind of ENTITY_KINDS) {
      for (const index of [1, 12, 9999]) {
        expect(newId(ID_PREFIXES[kind], stem, index)).toMatch(idPattern(kind));
      }
    }
    expect(newId(ID_PREFIXES.event, stem, 12)).toBe(`evt_${stem}0012`);
  });

  it("mints a fresh stem every turn", () => {
    const stems = new Set(Array.from({ length: 50 }, createIdStem));
    expect(stems.size).toBe(50);
    for (const stem of stems) expect(stem).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("gives the turn's stem, with worked IDs, in its own block after the project", () => {
    const [prompt, project, ids] = buildSystemBlocks(
      MINIMAL_ASSISTANT_CONTEXT,
      undefined,
      "S".repeat(17),
    );
    expect(prompt.text).toBe(ASSISTANT_SYSTEM_PROMPT);
    // The project block stays the JSON alone, for anything that reads it back.
    expect(project.text).toBe(
      `The open project, as JSON:\n${JSON.stringify(MINIMAL_ASSISTANT_CONTEXT)}`,
    );
    expect(ids.text).toContain(`the stem ${"S".repeat(17)}`);
    expect(ids.text).toContain(newId(ID_PREFIXES.clip, "S".repeat(17), 2));
    // Notes take no ID (GRV-131): the gateway mints theirs from the stem,
    // and the model makes one only for notes_duplicate.
    expect(ids.text).toContain(newId(ID_PREFIXES.event, "S".repeat(17), 1));
    expect(ids.text).toContain(
      "A note ID is only for notes_duplicate's newIds: the notes you write in clip_create and note_add take none.",
    );
    // The fixed prompt never asks for an ID to be counted out by hand.
    expect(ASSISTANT_SYSTEM_PROMPT).not.toMatch(/padding .* zeros/);
  });

  it("writes new notes as short arrays with no ID (GRV-131)", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "[startTicks, pitch, durationTicks, velocity], e.g. [0, 36, 192, 0.8]",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('[0, "pad_...", 48, 0.9]');
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain('{"kind": "pad", "padId"');
  });

  it("puts the request ahead of genre habits (PRD principle 10)", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("a starting point, never a rule");
    expect(ASSISTANT_SYSTEM_PROMPT).not.toMatch(/follow (the )?genre conventions/i);
  });

  // GRV-42 QA: a reply that wrote no text and spent its room on a drum beat
  // ran out of room, leaving the producer an empty "Writing…" reply.
  it("keeps a reply within its room: the sentence first, short looped parts, light previews", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Always start the reply with a sentence saying what you are proposing or asking, before any tool call",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "a step that runs out of it loses the whole reply",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("looped: true to fill its length");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("never the whole part you would propose");
  });

  // GRV-6 QA: a "broken" re-sketch proposed only notes_clear on the kick and
  // bass clips, meaning to write the new notes once the calls came back. A
  // turn now goes on in steps (steps.ts), but a replacement still stays in one.
  it("builds a proposal in narrated steps, ended by explain_change", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("No tool ever answers back");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("each step starts with one short sentence");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "to replace a clip's notes, clear them and add the new ones (note_add) in the same step",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "call explain_change once, as your last call",
    );
  });

  // GRV-6 QA: drum pads are in every drum track's "pads" (GRV-23), not only
  // in selectedNotes, so a whole-song request can write drums.
  it("takes drum pads from the track's pads in the description", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(`that track's "pads" in the description`);
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("use only pads you have seen there");
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("select the drum track");
  });

  // GRV-6 QA: "Nudge the melody down 1 dB" at -3 dB proposed -1 dB.
  it("makes parameter_set's value the new value, never the change", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "parameter_set's value is always the new value, never the change",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      '"down 1 dB" on a track at -3 dB is the value -4',
    );
  });

  // GRV-6 QA: a sketch scoped to the BD track came back unappliable.
  it("says what a scope allows: new parts on new tracks, asking before widening", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('When "selection" says what is in scope');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "goes on a new track made with track_create, whatever the scope",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "ask with ask_producer whether to widen it",
    );
  });
});
