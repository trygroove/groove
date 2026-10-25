import { describe, expect, it } from "vitest";
import { createReferenceProject } from "../domain/fixtures";
import { offerTakesCall, offerTakesInput, TAKE_LABELS } from "../testing/takes";
import { historyOf } from "./history";
import { validateProposal } from "./proposal";
import {
  expandTakesCall,
  historyTakes,
  moreTakesNote,
  OFFER_TAKES_TOOL_NAME,
  offerTakesTool,
  parseTakesCall,
  splitTakes,
  TAKE_NOTE_MARK,
  takeNoteContent,
  takeProposal,
  takesNote,
  takesWithSameNotes,
  withFirstTake,
} from "./takes";
import { ASSISTANT_TOOLSET_VERSION, EXPLAIN_TOOL_NAME } from "./tools";

const STEM = "Stem0000000000000";
const project = createReferenceProject();

function expanded() {
  const result = expandTakesCall({ id: "toolu_1", ...offerTakesCall(project) }, STEM);
  if (!result.ok) throw new Error(result.message);
  return result.call;
}

describe("offer_takes (GRV-207)", () => {
  it("is offered as a tool whose input asks for exactly four takes", () => {
    const tool = offerTakesTool();
    expect(tool.name).toBe(OFFER_TAKES_TOOL_NAME);
    const takes = (tool.inputSchema.properties as Record<string, Record<string, unknown>>)
      .takes;
    expect(takes.minItems).toBe(4);
    expect(takes.maxItems).toBe(4);
    // The contrast it asks for is named, and drums are left to the usual path.
    expect(tool.description).toMatch(
      /rhythm density, register, contour and use of rests/,
    );
    expect(tool.description).toContain("Never use it for drums");
  });

  it("writes each take's compact notes out in a counter of its own, from 1 in every take", () => {
    const call = expanded();
    const takes = parseTakesCall(call);
    expect(takes?.part).toBe("Lead melody");
    expect(takes?.takes.map((take) => take.label)).toEqual([...TAKE_LABELS]);
    for (const take of takes?.takes ?? []) {
      const clip = take.calls[1]?.input as { content: { events: { id: string }[] } };
      expect(clip.content.events.map((event) => event.id)).toEqual([
        `evt_${STEM}${TAKE_NOTE_MARK}001`,
        `evt_${STEM}${TAKE_NOTE_MARK}002`,
        `evt_${STEM}${TAKE_NOTE_MARK}003`,
      ]);
    }
  });

  it("makes each take a proposal of its own that applies to the song, alone", () => {
    const takes = parseTakesCall(expanded());
    if (!takes) throw new Error("the takes parse");
    for (const index of [0, 1, 2, 3]) {
      const proposal = takeProposal(takes, index, project.metadata.revision);
      expect(proposal.toolsetVersion).toBe(ASSISTANT_TOOLSET_VERSION);
      expect(proposal.calls.map((call) => call.name)).toEqual([
        "track_create",
        "clip_create",
        "placement_create",
      ]);
      const validation = validateProposal(project, proposal);
      expect(validation.ok).toBe(true);
      if (validation.ok) {
        expect(validation.proposal.impact.clips.added).toEqual([
          `clp_${STEM}${String(index + 1).padStart(4, "0")}`,
        ]);
      }
    }
  });

  it("refuses an offer of fewer than four takes, naming what is wrong", () => {
    const input = offerTakesInput(project);
    const result = expandTakesCall(
      {
        id: "toolu_1",
        name: OFFER_TAKES_TOOL_NAME,
        input: { ...input, takes: input.takes.slice(0, 3) },
      },
      STEM,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("4 takes");
  });

  it("refuses two takes under one label", () => {
    const input = offerTakesInput(project);
    input.takes[1] = { ...input.takes[1], label: input.takes[0].label.toUpperCase() };
    const result = expandTakesCall({ id: "t", name: OFFER_TAKES_TOOL_NAME, input }, STEM);
    expect(result.ok).toBe(false);
  });

  it("refuses two takes that play the same notes, whatever their IDs, velocities and labels", () => {
    const input = offerTakesInput(project);
    const clipOf = (take: number) =>
      input.takes[take].calls[1].input as { content: { events: number[][] } };
    // Take 4 plays take 2's notes, only quieter.
    clipOf(3).content.events = clipOf(1).content.events.map(([start, pitch, length]) => [
      start,
      pitch,
      length,
      0.3,
    ]);
    const result = expandTakesCall({ id: "t", name: OFFER_TAKES_TOOL_NAME, input }, STEM);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/^takes 2 and 4 play the same notes/);
  });

  it("tells takes apart by their notes, ignoring a take that writes none", () => {
    const takes = parseTakesCall(expanded());
    if (!takes) throw new Error("the takes parse");
    expect(takesWithSameNotes(takes.takes)).toBeNull();
    expect(takeNoteContent(takes.takes[0].calls)).not.toBe(
      takeNoteContent(takes.takes[1].calls),
    );
    const noNotes = { label: "x", calls: [takes.takes[0].calls[0]] };
    expect(takeNoteContent(noNotes.calls)).toBeNull();
    expect(takesWithSameNotes([noNotes, noNotes, takes.takes[0]])).toBeNull();
    expect(takesWithSameNotes([takes.takes[0], takes.takes[1], takes.takes[0]])).toEqual([
      1, 3,
    ]);
  });

  it("refuses a take whose call does not fit its tool, by take and call", () => {
    const input = offerTakesInput(project);
    input.takes[2].calls[1] = {
      ...input.takes[2].calls[1],
      input: {
        ...input.takes[2].calls[1].input,
        content: { kind: "notes", events: [[0]] },
      },
    };
    const result = expandTakesCall({ id: "t", name: OFFER_TAKES_TOOL_NAME, input }, STEM);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/^take 3, call 2 \(clip_create\)/);
  });

  it("refuses a take that calls something other than a change tool", () => {
    const input = offerTakesInput(project);
    input.takes[0].calls.push({
      name: EXPLAIN_TOOL_NAME,
      input: { goal: "g", technique: "t" },
    } as never);
    const result = expandTakesCall({ id: "t", name: OFFER_TAKES_TOOL_NAME, input }, STEM);
    expect(result.ok).toBe(false);
  });

  it("parses nothing from a call the gateway refused", () => {
    expect(
      parseTakesCall({ ...expanded(), refusal: "take 1, call 1: not a note" }),
    ).toBeNull();
  });

  it("takes the offers out of a turn's proposal, leaving the rest", () => {
    const offer = expanded();
    const other = { id: "toolu_2", name: "parameter_set", input: {} };
    const split = splitTakes({
      baseRevision: 1,
      toolsetVersion: 12,
      calls: [offer, other],
    });
    expect(split.offers).toEqual([offer]);
    expect(split.proposal?.calls).toEqual([other]);
    expect(
      splitTakes({ baseRevision: 1, toolsetVersion: 12, calls: [offer] }).proposal,
    ).toBeNull();
  });
});

describe("judging an offer by its first take (GRV-207)", () => {
  it("replaces the offer with take 1's calls, leaving the rest of the proposal", () => {
    const offer = expanded();
    const other = { id: "toolu_2", name: "parameter_set", input: {} };
    const judged = withFirstTake({
      baseRevision: 1,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      calls: [offer, other],
    });
    expect(judged.calls.map((call) => call.name)).toEqual([
      "track_create",
      "clip_create",
      "placement_create",
      "parameter_set",
    ]);
    expect(judged.calls[1]?.id).toBe("toolu_1:1:2");
  });
});

describe("takes in the conversation's history (GRV-207)", () => {
  const takes = parseTakesCall(expanded());
  if (!takes) throw new Error("the takes parse");
  const offered = historyTakes(takes);

  it("says what the takes were and what became of them, after the reply", () => {
    const history = historyOf([
      { kind: "message", text: "Write me a lead" },
      {
        kind: "reply",
        text: "Four takes of a lead.",
        takes: { ...offered, outcome: "picked", picked: 2 },
      },
    ]);
    const said = history[1]?.text ?? "";
    expect(said).toContain("Four takes of a lead.");
    expect(said).toContain("1. Sparse and low; 2. Busy and high");
    expect(said).toContain("They picked take 2");
  });

  it.each([
    ["pending", "They have not picked one"],
    ["none", "They turned all of them down"],
    ["more", "They asked for 4 more instead"],
  ] as const)("says a %s offer as such", (outcome, words) => {
    expect(takesNote({ ...offered, outcome })).toContain(words);
  });

  it("asks for four more that differ from the four before", () => {
    const note = moreTakesNote(offered);
    expect(note.startsWith("[4 more]")).toBe(true);
    expect(note).toContain("Busy and high");
    expect(note).toContain(OFFER_TAKES_TOOL_NAME);
  });
});
