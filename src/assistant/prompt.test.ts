import { describe, expect, it } from "vitest";
import { deviceTypes } from "../domain/devices";
import { ENTITY_KINDS, ID_PREFIXES, idPattern } from "../domain/ids";
import { bareParameterId, SYNTH_PARAMETERS } from "../domain/parameters";
import { MINIMAL_ASSISTANT_CONTEXT } from "../testing/scriptedAssistantProvider";
import {
  ASSISTANT_PROMPT_VERSION,
  ASSISTANT_SYSTEM_PROMPT,
  assistantSystemPrompt,
  buildSystemBlocks,
  createIdStem,
  describeParameter,
  GUIDED_BUILD_RULE,
  newId,
} from "./prompt";
import { TACTIC_DEFAULTS } from "./tactics";

const STEPS_PROMPT = assistantSystemPrompt({ oneResponseProposal: "off" });
const ONE_RESPONSE_PROMPT = assistantSystemPrompt({ oneResponseProposal: "on" });

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

  // GRV-207: a guided build's step and a change during a lesson stay one proposal each.
  it("keeps guided-build steps and lesson changes out of takes", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "so is every step of a guided build and anything you change during a lesson: those are one proposal each, never takes",
    );
  });

  // GRV-213: a new drum pattern is four takes too, contrasting on drum axes;
  // an edit to a pattern's hits stays one proposal.
  it("offers four takes of a new drum pattern, and keeps edits to its hits a proposal", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "A new drum pattern (a beat, a groove, drums for the song, or another go at one) is offered the same way",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "density, groove feel (straight or swung, where the hits sit and how hard), kick placement, hat and percussion variation, and fills",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "never a drum pattern and a melodic part in one offer",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Changes to notes or hits the song already has (busier hats, a snare moved)",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("Drums, changes to notes");
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
    // The prompt production's tactics make, so a tactic's win keeps this green.
    expect(prompt.text).toBe(assistantSystemPrompt(TACTIC_DEFAULTS));
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
    expect(STEPS_PROMPT).toContain("a step that runs out of it loses the whole reply");
    expect(ONE_RESPONSE_PROMPT).toContain(
      "a response that runs out of it loses the whole reply",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("looped: true to fill its length");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("never the whole part you would propose");
  });

  // GRV-6 QA: a "broken" re-sketch proposed only notes_clear on the kick and
  // bass clips, meaning to write the new notes once the calls came back. A
  // turn now goes on in steps (steps.ts), but a replacement still stays in one.
  it("builds a proposal in narrated steps, ended by explain_change", () => {
    expect(STEPS_PROMPT).not.toContain("No tool ever answers back");
    expect(STEPS_PROMPT).toContain("each step starts with one short sentence");
    expect(STEPS_PROMPT).toContain(
      "to replace a clip's notes, clear them and add the new ones (note_add) in the same step",
    );
    expect(STEPS_PROMPT).toContain("call explain_change once, as your last call");
  });

  // GRV-142: the oneResponseProposal tactic asks for every change call at
  // once, after one line, and a second response only when it does not fit.
  it("writes a proposal in one response under oneResponseProposal, a second only when it does not fit", () => {
    expect(ONE_RESPONSE_PROMPT).not.toContain("each step starts with one short sentence");
    expect(ONE_RESPONSE_PROMPT).toContain("start with one short line saying what it is");
    expect(ONE_RESPONSE_PROMPT).toContain(
      "with no sentence between them and none per part",
    );
    expect(ONE_RESPONSE_PROMPT).toContain(
      "a proposal takes at most two responses of changes, and a third is refused",
    );
    expect(ONE_RESPONSE_PROMPT).toContain(
      "to replace a clip's notes, clear them and add the new ones (note_add) in the same response",
    );
    expect(ONE_RESPONSE_PROMPT).toContain("call explain_change once, as your last call");
    // Only the passages about building a proposal and its room differ.
    const strip = (prompt: string) =>
      prompt
        .replace(/Build it in steps.*in the same step\./, "")
        .replace(/Write the whole proposal.*ends with explain_change\./, "")
        .replace(/## Keeping each step[\s\S]*?(?=## The producer)/, "")
        .replace(/## Keeping a response[\s\S]*?(?=## The producer)/, "");
    expect(strip(ONE_RESPONSE_PROMPT)).toBe(strip(STEPS_PROMPT));
  });

  // GRV-145: the guidedBuild tactic builds a large, open request over several
  // short proposals, each ending with a question offering the next steps.
  it("guides a large, open request through short proposals under guidedBuild, and only then", () => {
    const off = assistantSystemPrompt({ oneResponseProposal: "off", guidedBuild: "off" });
    const on = assistantSystemPrompt({ oneResponseProposal: "off", guidedBuild: "on" });
    expect(off).not.toContain(GUIDED_BUILD_RULE);
    expect(on).toContain(GUIDED_BUILD_RULE);
    // The ask_producer paragraph's "without asking again" must not read as
    // "ask nothing this turn": offering the next steps is not asking again.
    expect(GUIDED_BUILD_RULE).toContain(
      "Offering those next steps after carrying out the step they chose is not asking again",
    );
    // One paragraph more, straight after the one on asking, and nothing else.
    expect(on.replace(`\n\n${GUIDED_BUILD_RULE}`, "")).toBe(off);
    expect(on).toContain(
      `without asking again.\n\n${GUIDED_BUILD_RULE}\n\nWhen the producer asks for a sound`,
    );
    // Under either way of writing a proposal.
    expect(
      assistantSystemPrompt({ oneResponseProposal: "on", guidedBuild: "on" }).replace(
        `\n\n${GUIDED_BUILD_RULE}`,
        "",
      ),
    ).toBe(assistantSystemPrompt({ oneResponseProposal: "on", guidedBuild: "off" }));
    // Left out, it is production's.
    expect(assistantSystemPrompt({ oneResponseProposal: "off" })).toBe(
      assistantSystemPrompt({
        oneResponseProposal: "off",
        guidedBuild: TACTIC_DEFAULTS.guidedBuild,
      }),
    );
  });

  it("sends the guided-build rule in the turn's system blocks when guidedBuild is on", () => {
    const blocks = (guidedBuild: "on" | "off") =>
      buildSystemBlocks(MINIMAL_ASSISTANT_CONTEXT, undefined, "S".repeat(17), undefined, {
        ...TACTIC_DEFAULTS,
        guidedBuild,
      })[0].text;
    expect(blocks("on")).toContain(GUIDED_BUILD_RULE);
    expect(blocks("off")).not.toContain(GUIDED_BUILD_RULE);
  });

  it("says what a guided build's stages are", () => {
    for (const phrase of [
      '"develop this", "arrange this", "make it a full tune"',
      "the smallest step that plays at once",
      "the sections laid out as placements that reuse those clips (parts left out for builds and drops) plus any new tracks the plan needs, empty",
      "from an empty song, the core loop",
      "Never leave a clip without notes",
      "call explain_change and then ask_producer together: ask_producer is the one call allowed after explain_change",
      "with the one you would do next suggested",
      "write that one section or step as one proposal",
      '("add a clap on 2 and 4") is not one of these',
    ]) {
      expect(GUIDED_BUILD_RULE).toContain(phrase);
    }
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
