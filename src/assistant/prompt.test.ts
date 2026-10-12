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
    expect(ids.text).toContain(newId(ID_PREFIXES.event, "S".repeat(17), 2));
    // The fixed prompt never asks for an ID to be counted out by hand.
    expect(ASSISTANT_SYSTEM_PROMPT).not.toMatch(/padding .* zeros/);
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
      "a reply that runs out of it is lost whole",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("looped: true to fill its length");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("never the whole part you would propose");
  });

  // GRV-6 QA: a "broken" re-sketch proposed only notes_clear on the kick and
  // bass clips, meaning to write the new notes once the calls came back.
  it("says no tool answers back, so a replacement is cleared and written in one reply", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("No tool ever answers back");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "to replace a clip's notes, clear them and add the new ones (note_add) in the same reply",
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
