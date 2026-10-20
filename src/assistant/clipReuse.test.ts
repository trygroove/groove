import { describe, expect, it } from "vitest";
import { executeTransaction } from "../commands/execute";
import type { NoteEvent } from "../domain/entities";
import { createPianoRollFixtureProject } from "../domain/fixtures";
import { TICKS_PER_BAR, toTicks } from "../domain/time";
import { addToSelection, selectOnly } from "../selection/selection";
import {
  createScriptedAssistantProvider,
  toolUseEvents,
} from "../testing/scriptedAssistantProvider";
import {
  type ClipLedger,
  contextClips,
  gatewayPlacementId,
  rewritePlacement,
  withClipCall,
} from "./clipReuse";
import {
  createNoteExpander,
  expandAskPreviews,
  gatewayNoteId,
  type NoteExpander,
  type StepStringOptions,
} from "./compactNotes";
import { runAssistantTurn } from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import { buildAssistantPayload } from "./payload";
import {
  ASSISTANT_SYSTEM_PROMPT,
  assistantSystemPrompt,
  CLIP_REUSE_LINE,
  newId,
} from "./prompt";
import { validateProposal } from "./proposal";
import type { AssistantToolCall } from "./protocol";
import { withCreatedTargets } from "./recommendationTargets";
import { addedResult, answerStep, refusedIn } from "./steps";
import { TACTIC_DEFAULTS, TACTICS } from "./tactics";
import {
  assistantTools,
  bundleTools,
  CLIP_CREATE_COPY_TEXT,
  CREATE_EXAMPLES,
  EXPLAIN_TOOL_NAME,
  NOTES_DUPLICATE_REUSE_TEXT,
  PLACEMENT_CREATE_REUSE_TEXT,
  resolveToolCall,
} from "./tools";

const STEM = "Stem0000000000000";
const TRACK = "trk_Lead00000000000000001";
const PLACED = "clp_Placed000000000000001";
const LISTED = "clp_Listed000000000000001";
const NEW_CLIP = newId("clp", STEM, 1);
const BAR = TICKS_PER_BAR;

function note(id: string, startTicks: number, pitch: number): NoteEvent {
  return {
    id,
    trigger: { kind: "pitch", pitch },
    startTicks,
    durationTicks: 48,
    velocity: 0.8,
    probability: null,
  } as NoteEvent;
}

const LISTED_NOTES = [
  note("evt_A00000000000000000001", 0, 60),
  note("evt_B00000000000000000001", 192, 64),
  note("evt_C00000000000000000001", 384, 67),
];

/** A clip placed in the description, and one whose notes the selection lists. */
const LEDGER: ClipLedger = new Map([
  [PLACED, { trackId: TRACK, events: null }],
  [LISTED, { trackId: TRACK, events: LISTED_NOTES }],
]);

function reuseExpander(clips: ClipLedger = LEDGER): NoteExpander {
  const options: StepStringOptions = {
    targets: new Map(),
    track: withCreatedTargets,
    stepStrings: false,
    generators: false,
    clipReuse: clips,
  };
  return createNoteExpander(STEM, undefined, options);
}

function call(name: string, input: unknown, id = "toolu_1"): AssistantToolCall {
  return { id, name, input };
}

function clipCreate(content: unknown, id = NEW_CLIP): AssistantToolCall {
  return call("clip_create", {
    ...CREATE_EXAMPLES.clip,
    id,
    trackId: TRACK,
    lengthTicks: 2 * BAR,
    content,
  });
}

function accepted(expanded: ReturnType<NoteExpander["expand"]>) {
  if (!expanded.ok) throw new Error(expanded.message);
  return expanded;
}

function refusal(expanded: ReturnType<NoteExpander["expand"]>): string {
  if (expanded.ok) throw new Error("expected a refusal");
  return expanded.message;
}

function eventsOf(created: AssistantToolCall): NoteEvent[] {
  return (created.input as { content: { events: NoteEvent[] } }).content.events;
}

describe("a short placement (GRV-131 clip reuse)", () => {
  it("places a clip by bars, filling in its ID, its track, no offset and a loop", () => {
    const expanded = accepted(
      reuseExpander().expand(call("placement_create", { clipId: PLACED, bars: [5, 8] })),
    );
    const id = gatewayPlacementId(STEM, 1, "n");
    expect(expanded.call.input).toEqual({
      id,
      clipId: PLACED,
      trackId: TRACK,
      startTicks: 4 * BAR,
      durationTicks: 4 * BAR,
      clipOffsetTicks: 0,
      looped: true,
    });
    expect(expanded.placementId).toBe(id);
    expect(id).toHaveLength(CREATE_EXAMPLES.placement.id.length);
    expect(resolveToolCall("placement_create", expanded.call.input).ok).toBe(true);
  });

  it("numbers the placements it gives IDs in order, the same every time", () => {
    const ids = (notes: NoteExpander) =>
      [1, 2, 3].map(
        (bar) =>
          accepted(
            notes.expand(call("placement_create", { clipId: PLACED, bars: [bar, bar] })),
          ).placementId,
      );
    expect(ids(reuseExpander())).toEqual(
      [1, 2, 3].map((n) => gatewayPlacementId(STEM, n, "n")),
    );
    expect(ids(reuseExpander())).toEqual(ids(reuseExpander()));
  });

  it("keeps every field it is given, and takes ticks in place of bars", () => {
    const own = "plc_Mine00000000000000001";
    const expanded = accepted(
      reuseExpander().expand(
        call("placement_create", {
          id: own,
          clipId: PLACED,
          startTicks: 96,
          durationTicks: 384,
          looped: false,
        }),
      ),
    );
    expect(expanded.call.input).toEqual({
      id: own,
      clipId: PLACED,
      trackId: TRACK,
      startTicks: 96,
      durationTicks: 384,
      clipOffsetTicks: 0,
      looped: false,
    });
    expect(expanded.placementId).toBeUndefined();
    // A whole placement comes back as it was sent.
    const whole = call("placement_create", CREATE_EXAMPLES.placement);
    expect(accepted(reuseExpander().expand(whole)).call).toEqual(whole);
  });

  it("finds the track of a clip an earlier call in the turn made", () => {
    const notes = reuseExpander(new Map());
    const short = call("placement_create", { clipId: NEW_CLIP, bars: [1, 4] });
    expect(refusal(notes.expand(short))).toMatch(/^trackId: .* so give its track$/);
    accepted(notes.expand(clipCreate({ kind: "notes", events: [[0, 60, 48, 0.8]] })));
    expect(accepted(notes.expand(short)).call.input).toMatchObject({ trackId: TRACK });
  });

  it.each([
    [{ clipId: PLACED }, /^bars: say where the clip plays/],
    [{ clipId: PLACED, bars: [8, 5] }, /^bars: the last bar, 5, is before the first, 8$/],
    [{ clipId: PLACED, bars: [1, 2], startTicks: 0 }, /^bars: give bars, or startTicks/],
    [{ clipId: PLACED, bars: [0, 4] }, /^bars\.0: /],
    [
      { id: gatewayPlacementId(STEM, 1, "n"), clipId: PLACED, bars: [1, 2] },
      /^id: a placement ID with "n" before its number is one Groove gives/,
    ],
  ])("refuses %j with the reason", (input, reason) => {
    expect(refusal(reuseExpander().expand(call("placement_create", input)))).toMatch(
      reason,
    );
  });

  it("leaves a short placement for the tool to refuse with the tactic off", () => {
    const short = call("placement_create", { clipId: PLACED, bars: [1, 2] });
    expect(accepted(createNoteExpander(STEM).expand(short)).call).toEqual(short);
    expect(resolveToolCall(short.name, short.input).ok).toBe(false);
  });
});

describe("a copied clip (GRV-131 clip reuse)", () => {
  it("copies a listed clip's notes with new IDs, then writes the new ones", () => {
    const expanded = accepted(
      reuseExpander().expand(
        clipCreate({ kind: "copy", clipId: LISTED, events: [[576, 72, 48, 0.9]] }),
      ),
    );
    const events = eventsOf(expanded.call);
    expect(events.map((event) => event.startTicks)).toEqual([0, 192, 384, 576]);
    expect(events.map((event) => event.id)).toEqual(
      [1, 2, 3, 4].map((index) => gatewayNoteId(STEM, index)),
    );
    expect(events[1]).toEqual({ ...LISTED_NOTES[1], id: gatewayNoteId(STEM, 2) });
    expect(expanded.noteIds).toHaveLength(4);
    expect(resolveToolCall("clip_create", expanded.call.input).ok).toBe(true);
  });

  it("copies only the notes eventIds names, in the clip's order", () => {
    const expanded = accepted(
      reuseExpander().expand(
        clipCreate({
          kind: "copy",
          clipId: LISTED,
          eventIds: [LISTED_NOTES[2].id, LISTED_NOTES[0].id],
        }),
      ),
    );
    expect(eventsOf(expanded.call).map((event) => event.startTicks)).toEqual([0, 384]);
  });

  it("copies a clip made earlier in the turn as the turn left it", () => {
    const notes = reuseExpander(new Map());
    accepted(notes.expand(clipCreate({ kind: "notes", events: [[0, 60, 48, 0.8]] })));
    accepted(
      notes.expand(call("note_add", { clipId: NEW_CLIP, notes: [[96, 62, 48, 0.8]] })),
    );
    const copy = accepted(
      notes.expand(clipCreate({ kind: "copy", clipId: NEW_CLIP }, newId("clp", STEM, 2))),
    );
    expect(eventsOf(copy.call).map((event) => event.startTicks)).toEqual([0, 96]);
    expect(copy.noteIds).toEqual([3, 4].map((index) => gatewayNoteId(STEM, index)));
  });

  it("refuses a clip whose notes it does not have, an unknown note, and a malformed copy", () => {
    const notes = reuseExpander();
    expect(refusal(notes.expand(clipCreate({ kind: "copy", clipId: PLACED })))).toMatch(
      /^content\.clipId: Groove does not have every note of clp_Placed/,
    );
    expect(
      refusal(
        notes.expand(clipCreate({ kind: "copy", clipId: "clp_Nowhere00000000000001" })),
      ),
    ).toMatch(/is not a clip made earlier in this proposal/);
    expect(
      refusal(
        notes.expand(
          clipCreate({
            kind: "copy",
            clipId: LISTED,
            eventIds: ["evt_Gone00000000000000001"],
          }),
        ),
      ),
    ).toBe("content.eventIds: evt_Gone00000000000000001: not a note of that clip");
    expect(refusal(notes.expand(clipCreate({ kind: "copy" })))).toMatch(
      /^content\.clipId: /,
    );
  });

  it("stops following a clip's notes once a call changes them in a way it does not track", () => {
    const after = withClipCall(
      LEDGER,
      call("notes_transpose", {
        clipId: LISTED,
        eventIds: null,
        semitones: 12,
      }),
    );
    expect(after.get(LISTED)).toEqual({ trackId: TRACK, events: null });
    const removed = withClipCall(
      LEDGER,
      call("note_remove", {
        clipId: LISTED,
        eventIds: [LISTED_NOTES[0].id],
      }),
    );
    expect(removed.get(LISTED)?.events).toEqual(LISTED_NOTES.slice(1));
    expect(
      withClipCall(LEDGER, call("notes_clear", { clipId: LISTED })).get(LISTED)?.events,
    ).toEqual([]);
    expect(
      withClipCall(LEDGER, call("clip_delete", { clipId: LISTED })).has(LISTED),
    ).toBe(false);
    expect(withClipCall(LEDGER, call("track_delete", { trackId: TRACK })).size).toBe(0);
  });
});

describe("a notes_duplicate with no newIds (GRV-131 clip reuse)", () => {
  it("gives the copies IDs from the turn's note counter", () => {
    const notes = reuseExpander();
    const expanded = accepted(
      notes.expand(
        call("notes_duplicate", { clipId: LISTED, eventIds: null, offsetTicks: BAR }),
      ),
    );
    const ids = [1, 2, 3].map((index) => gatewayNoteId(STEM, index));
    expect(expanded.call.input).toMatchObject({ newIds: ids });
    expect(expanded.noteIds).toEqual(ids);
    // The next note the turn writes counts on.
    const next = accepted(
      notes.expand(call("note_add", { clipId: LISTED, notes: [[0, 50, 48, 0.8]] })),
    );
    expect(next.noteIds).toEqual([gatewayNoteId(STEM, 4)]);
    // The model is told the copies' IDs follow the notes' time order.
    const answered = answerStep(
      [call("notes_duplicate", { clipId: LISTED, eventIds: null, offsetTicks: BAR })],
      new Map(),
      reuseExpander(),
    );
    expect(answered.results[0]?.content).toContain(
      `Its 3 notes' IDs, in time order of the notes copied (by start, then ID), count up from ${ids[0]} to ${ids[2]}.`,
    );
    expect(addedResult(ids)).toContain("in the order you gave them");
  });

  it("counts named notes without knowing the clip, and refuses every note of one it does not know", () => {
    const named = accepted(
      reuseExpander().expand(
        call("notes_duplicate", {
          clipId: PLACED,
          eventIds: ["evt_X00000000000000000001", "evt_Y00000000000000000001"],
          offsetTicks: BAR,
        }),
      ),
    );
    expect(named.noteIds).toHaveLength(2);
    expect(
      refusal(
        reuseExpander().expand(
          call("notes_duplicate", { clipId: PLACED, eventIds: null, offsetTicks: BAR }),
        ),
      ),
    ).toMatch(/^clipId: Groove does not have every note of/);
  });

  it("pairs the copies with their IDs in the command's order, start then ID, not the order it was told the notes", () => {
    // The ledger holds the notes out of time order, and the model names them
    // out of order too: notes.duplicate pairs newIds with the notes sorted by
    // start (then ID), so the ledger must as well.
    const ledger: ClipLedger = new Map([
      [
        LISTED,
        {
          trackId: TRACK,
          events: [LISTED_NOTES[2], LISTED_NOTES[0], LISTED_NOTES[1]],
        },
      ],
    ]);
    const newIds = [1, 2].map((index) => newId("evt", STEM, index));
    const after = withClipCall(
      ledger,
      call("notes_duplicate", {
        clipId: LISTED,
        eventIds: [LISTED_NOTES[2].id, LISTED_NOTES[0].id],
        offsetTicks: BAR,
        newIds,
      }),
    );
    expect(after.get(LISTED)?.events?.slice(3)).toEqual([
      { ...LISTED_NOTES[0], id: newIds[0], startTicks: BAR },
      { ...LISTED_NOTES[2], id: newIds[1], startTicks: 384 + BAR },
    ]);
  });

  it("leaves a duplicate with its own newIds as it is", () => {
    const own = call("notes_duplicate", {
      clipId: LISTED,
      eventIds: [LISTED_NOTES[0].id],
      offsetTicks: BAR,
      newIds: [newId("evt", STEM, 1)],
    });
    expect(accepted(reuseExpander().expand(own)).call).toEqual(own);
  });
});

describe("clip reuse in a step", () => {
  it("tells the model the placement's ID, and judges a step's calls in order without numbering the turn's", () => {
    expect(addedResult([], "plc_X")).toMatch(/Its placement's ID is plc_X\.$/);
    const notes = reuseExpander(new Map());
    const step = [
      clipCreate({ kind: "notes", events: [[0, 60, 48, 0.8]] }),
      call("placement_create", { clipId: NEW_CLIP, bars: [1, 4] }, "toolu_2"),
    ];
    // The placement builds on the clip before it, so neither is refused.
    expect(refusedIn(step, notes)).toBe(0);
    const answered = answerStep(step, new Map(), notes);
    expect(answered.results.map((result) => result.is_error)).toEqual([
      undefined,
      undefined,
    ]);
    expect(answered.results[0]?.content).toContain(gatewayNoteId(STEM, 1));
    expect(answered.results[1]?.content).toContain(gatewayPlacementId(STEM, 1, "n"));
  });

  it("reads the description's placements and listed notes as the clips it knows", () => {
    const project = createPianoRollFixtureProject();
    const [clip] = project.clips;
    const listed = contextClips(
      buildAssistantPayload(project, selectOnly({ kind: "clip", id: clip.id })),
    );
    expect(listed.get(clip.id)?.events).toHaveLength(4);
    const placedOnly = contextClips(buildAssistantPayload(project));
    expect(placedOnly.get(clip.id)).toEqual({
      trackId: project.song.tracks[0].id,
      events: null,
    });
  });

  it("takes a selection of some notes as only those notes, never the whole clip", () => {
    const project = createPianoRollFixtureProject();
    const [clip] = project.clips;
    if (clip?.content.kind !== "notes") throw new Error("not a note clip");
    const [first, second] = clip.content.events;
    const oneNote = contextClips(
      buildAssistantPayload(project, selectOnly({ kind: "event", id: first.id })),
    );
    const firstBeats = contextClips(
      buildAssistantPayload(
        project,
        selectOnly({
          kind: "barRange",
          startTicks: toTicks(0),
          endTicks: toTicks(384),
          trackIds: [],
        }),
      ),
    );
    expect(oneNote.get(clip.id)).toMatchObject({
      partial: true,
      events: [{ id: first.id }],
    });
    expect(firstBeats.get(clip.id)?.events?.map((event) => event.id)).toEqual([
      first.id,
      second.id,
    ]);

    for (const ledger of [oneNote, firstBeats]) {
      // Every note of the clip is more than the selection lists: refused, not
      // counted short (the command would refuse four notes with too few IDs).
      expect(
        refusal(
          reuseExpander(ledger).expand(
            call("notes_duplicate", {
              clipId: clip.id,
              eventIds: null,
              offsetTicks: BAR,
            }),
          ),
        ),
      ).toMatch(/^clipId: Groove has only the notes of clp_[\w-]+ the selection lists/);
      // A whole copy would be a silent subset: refused, and told to name the notes.
      expect(
        refusal(
          reuseExpander(ledger).expand(clipCreate({ kind: "copy", clipId: clip.id })),
        ),
      ).toMatch(/name the notes with eventIds/);
      // The notes it has can still be copied by ID.
      const copied = accepted(
        reuseExpander(ledger).expand(
          clipCreate({ kind: "copy", clipId: clip.id, eventIds: [first.id] }),
        ),
      );
      expect(eventsOf(copied.call).map((event) => event.startTicks)).toEqual([
        first.startTicks,
      ]);
    }
    // A note it was not shown is not one it can copy.
    expect(
      refusal(
        reuseExpander(oneNote).expand(
          clipCreate({ kind: "copy", clipId: clip.id, eventIds: [second.id] }),
        ),
      ),
    ).toMatch(/not a note the description lists in that clip$/);
    // And a duplicate of the notes it has keeps the clip partial.
    const after = withClipCall(
      oneNote,
      call("notes_duplicate", {
        clipId: clip.id,
        eventIds: [first.id],
        offsetTicks: BAR,
        newIds: [newId("evt", STEM, 1)],
      }),
    );
    expect(after.get(clip.id)).toMatchObject({ partial: true });
    expect(after.get(clip.id)?.events).toHaveLength(2);
    // Cleared, the clip is known whole again: it has no notes.
    expect(
      withClipCall(oneNote, call("notes_clear", { clipId: clip.id })).get(clip.id),
    ).toEqual({ trackId: clip.trackId, events: [] });
  });

  it("takes a selection the note cap cut short, or one mixing a whole clip with single notes, as only some notes", () => {
    const project = createPianoRollFixtureProject();
    const [clip] = project.clips;
    if (clip?.content.kind !== "notes") throw new Error("not a note clip");
    const whole = buildAssistantPayload(
      project,
      selectOnly({ kind: "clip", id: clip.id }),
    );
    const selected = whole.selectedNotes;
    if (!selected) throw new Error("no selected notes");
    expect(contextClips(whole).get(clip.id)?.partial).toBeUndefined();
    const capped = contextClips({
      ...whole,
      selectedNotes: { ...selected, omittedNoteCount: 1 },
    });
    expect(capped.get(clip.id)).toMatchObject({ partial: true });
    const mixed = contextClips(
      buildAssistantPayload(
        project,
        addToSelection(selectOnly({ kind: "clip", id: clip.id }), {
          kind: "event",
          id: clip.content.events[0].id,
        }),
      ),
    );
    expect(mixed.get(clip.id)).toMatchObject({ partial: true });
  });

  it("drops an ask's preview whose short form it cannot write out", () => {
    const options: StepStringOptions = {
      targets: new Map(),
      track: withCreatedTargets,
      stepStrings: false,
      generators: false,
      clipReuse: LEDGER,
    };
    const ask = expandAskPreviews(
      {
        id: "toolu_ask",
        question: "Which?",
        multiSelect: false,
        options: [
          {
            label: "Again",
            sound: {
              kind: "preview",
              calls: [
                { name: "placement_create", input: { clipId: LISTED, bars: [5, 8] } },
              ],
            },
          },
          {
            label: "Nowhere",
            sound: {
              kind: "preview",
              calls: [clipCreate({ kind: "copy", clipId: PLACED })],
            },
          },
        ],
      } as Parameters<typeof expandAskPreviews>[0],
      STEM,
      options,
    );
    const [again, nowhere] = ask.options;
    expect(again?.sound).toMatchObject({
      calls: [{ input: { clipId: LISTED, startTicks: 4 * BAR, durationTicks: 4 * BAR } }],
    });
    expect(nowhere).toEqual({ label: "Nowhere" });
  });

  it("refuses a placement with no track for a clip it does not know", () => {
    expect(
      rewritePlacement(
        { clipId: "clp_Nowhere00000000000001", bars: [1, 1] },
        LEDGER,
        "x",
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("the clipReuse tactic", () => {
  it("is off by default, and changes the prompt, the tools and their expansion", () => {
    expect(TACTICS.clipReuse.values).toEqual(["off", "on"]);
    expect(TACTICS.clipReuse.alters).toEqual(["prompt", "tools", "expansion"]);
  });

  it("steers the model to reuse clips in the prompt only when on", () => {
    expect(assistantSystemPrompt()).toBe(
      assistantSystemPrompt({ clipReuse: TACTIC_DEFAULTS.clipReuse }),
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toBe(assistantSystemPrompt(TACTIC_DEFAULTS));
    const off = assistantSystemPrompt({ clipReuse: "off" });
    expect(off).not.toContain(CLIP_REUSE_LINE);
    const on = assistantSystemPrompt({ clipReuse: "on" });
    expect(on).toContain(`${CLIP_REUSE_LINE}\n- parameter_set takes`);
    expect(on.replace(`${CLIP_REUSE_LINE}\n`, "")).toBe(off);
    expect(CLIP_REUSE_LINE).toMatch(/Never write out notes a clip already has/);
  });

  it("offers the short forms only when on, in clip_create, placement_create and notes_duplicate alone", () => {
    const off = assistantTools("full", "off", "off", "off");
    const on = assistantTools("full", "off", "off", "on");
    expect(assistantTools()).toBe(
      assistantTools(
        "full",
        TACTIC_DEFAULTS.drumStepStrings,
        TACTIC_DEFAULTS.patternGenerators,
        TACTIC_DEFAULTS.clipReuse,
      ),
    );
    expect(on.map((tool) => tool.name)).toEqual(off.map((tool) => tool.name));
    const changed = ["clip_create", "placement_create", "notes_duplicate"];
    for (const [index, tool] of on.entries()) {
      if (changed.includes(tool.name)) continue;
      expect(tool).toEqual(off[index]);
    }
    const named = (tools: typeof on, name: string) =>
      tools.find((tool) => tool.name === name);
    const texts: Record<string, string> = {
      clip_create: CLIP_CREATE_COPY_TEXT,
      placement_create: PLACEMENT_CREATE_REUSE_TEXT,
      notes_duplicate: NOTES_DUPLICATE_REUSE_TEXT,
    };
    for (const name of changed) {
      expect(named(off, name)?.description).not.toContain(texts[name]);
      expect(named(on, name)?.description).toBe(
        `${named(off, name)?.description} ${texts[name]}`,
      );
    }
    expect(JSON.stringify(named(on, "clip_create")?.inputSchema)).toContain('"copy"');
    expect(JSON.stringify(named(on, "placement_create")?.inputSchema)).toContain(
      '"bars"',
    );
    expect(named(on, "placement_create")?.inputSchema.required).toEqual(["clipId"]);
    expect(named(on, "notes_duplicate")?.inputSchema.required).not.toContain("newIds");
    expect(bundleTools("arrange", "full", "off", "off", "on")).toEqual(
      on.filter((tool) =>
        bundleTools("arrange", "full", "off", "off", "off").some(
          (entry) => entry.name === tool.name,
        ),
      ),
    );
  });

  it("keeps its text when toolText trims the tools (GRV-146)", () => {
    for (const level of ["moderate", "aggressive"] as const) {
      const off = assistantTools(level, "off", "off", "off");
      const on = assistantTools(level, "off", "off", "on");
      const placement = on.find((tool) => tool.name === "placement_create");
      const trimmed = off.find((tool) => tool.name === "placement_create");
      expect(placement?.description).toBe(
        `${trimmed?.description} ${PLACEMENT_CREATE_REUSE_TEXT}`,
      );
    }
  });

  it("sends the forms and expands them in a turn, into a proposal the browser accepts", async () => {
    const project = createPianoRollFixtureProject();
    const [track] = project.song.tracks;
    const [arp] = project.clips;
    if (arp?.content.kind !== "notes") throw new Error("not a note clip");
    const [first, second] = arp.content.events;
    const copyId = newId("clp", STEM, 1);
    const calls = [
      { name: "placement_create", input: { clipId: arp.id, bars: [3, 4] } },
      {
        name: "clip_create",
        input: {
          ...CREATE_EXAMPLES.clip,
          id: copyId,
          trackId: track.id,
          lengthTicks: 2 * BAR,
          content: {
            kind: "copy",
            clipId: arp.id,
            eventIds: [first.id, second.id],
            events: [[576, 79, 48, 0.7]],
          },
        },
      },
      {
        name: "notes_duplicate",
        input: { clipId: copyId, eventIds: null, offsetTicks: BAR },
      },
      { name: "placement_create", input: { clipId: copyId, bars: [5, 6] } },
      { name: EXPLAIN_TOOL_NAME, input: { goal: "More song", technique: "Reuse" } },
    ];
    const provider = createScriptedAssistantProvider([toolUseEvents("Reusing.", calls)]);
    const result = await runAssistantTurn(
      {
        provider,
        guards: createInMemoryGuardStores(),
        log: () => {},
        now: () => 1_000,
        idStem: () => STEM,
        tactics: { clipReuse: "on" },
      },
      { uid: "uid-1", signInProvider: "google.com" },
      {
        projectRevision: project.metadata.revision,
        messages: [{ role: "user", text: "Carry the arp on, then vary it" }],
        context: buildAssistantPayload(project, selectOnly({ kind: "clip", id: arp.id })),
      },
      { signal: new AbortController().signal, onChunk: () => {} },
    );
    const sent = JSON.stringify(provider.requests[0]);
    expect(sent).toContain(JSON.stringify(CLIP_REUSE_LINE).slice(1, -1));
    const proposal = result.proposal;
    if (!proposal) throw new Error("no proposal");
    const placements = proposal.calls.filter(
      (entry) => entry.name === "placement_create",
    );
    expect(placements.map((entry) => entry.input)).toEqual([
      {
        id: gatewayPlacementId(STEM, 1, "n"),
        clipId: arp.id,
        trackId: track.id,
        startTicks: 2 * BAR,
        durationTicks: 2 * BAR,
        clipOffsetTicks: 0,
        looped: true,
      },
      {
        id: gatewayPlacementId(STEM, 2, "n"),
        clipId: copyId,
        trackId: track.id,
        startTicks: 4 * BAR,
        durationTicks: 2 * BAR,
        clipOffsetTicks: 0,
        looped: true,
      },
    ]);
    const created = proposal.calls.find((entry) => entry.name === "clip_create");
    if (!created) throw new Error("no clip_create");
    expect(eventsOf(created).map((event) => event.startTicks)).toEqual([0, 192, 576]);
    const duplicate = proposal.calls.find((entry) => entry.name === "notes_duplicate");
    expect(duplicate?.input).toMatchObject({
      newIds: [4, 5, 6].map((index) => gatewayNoteId(STEM, index)),
    });
    expect(JSON.stringify(proposal)).not.toContain('"copy"');
    expect(JSON.stringify(proposal)).not.toContain('"bars"');
    const validation = validateProposal(project, proposal);
    expect(validation.ok ? null : validation.issues).toBeNull();
  });

  it("copies a duplicated note as the project has it, with notes written out of time order", async () => {
    const project = createPianoRollFixtureProject();
    const [track] = project.song.tracks;
    const source = newId("clp", STEM, 1);
    const copyId = newId("clp", STEM, 2);
    const clip = (id: string, content: unknown) => ({
      name: "clip_create",
      input: {
        ...CREATE_EXAMPLES.clip,
        id,
        trackId: track.id,
        lengthTicks: 2 * BAR,
        content,
      },
    });
    // The notes come later-first: n001 is pitch 72 at 384, n002 pitch 60 at 0.
    // notes.duplicate copies them in time order, so n003 is pitch 60 at 768.
    const duplicateId = gatewayNoteId(STEM, 3);
    const calls = [
      clip(source, {
        kind: "notes",
        events: [
          [384, 72, 48, 0.8],
          [0, 60, 48, 0.8],
        ],
      }),
      {
        name: "notes_duplicate",
        input: { clipId: source, eventIds: null, offsetTicks: 768 },
      },
      clip(copyId, { kind: "copy", clipId: source, eventIds: [duplicateId] }),
      { name: EXPLAIN_TOOL_NAME, input: { goal: "A variation", technique: "Reuse" } },
    ];
    const provider = createScriptedAssistantProvider([toolUseEvents("Reusing.", calls)]);
    const result = await runAssistantTurn(
      {
        provider,
        guards: createInMemoryGuardStores(),
        log: () => {},
        now: () => 1_000,
        idStem: () => STEM,
        tactics: { clipReuse: "on" },
      },
      { uid: "uid-1", signInProvider: "google.com" },
      {
        projectRevision: project.metadata.revision,
        messages: [{ role: "user", text: "Copy the echo" }],
        context: buildAssistantPayload(project),
      },
      { signal: new AbortController().signal, onChunk: () => {} },
    );
    const validation = validateProposal(project, result.proposal);
    if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
    const applied = executeTransaction(project, validation.proposal.commands, {
      actor: "assistant",
    });
    if (!applied.ok) throw new Error("the proposal did not apply");
    const notesOf = (id: string) => {
      const found = applied.project.clips.find((entry) => entry.id === id);
      if (found?.content.kind !== "notes") throw new Error(`${id} has no notes`);
      return found.content.events;
    };
    const duplicate = notesOf(source).find((event) => event.id === duplicateId);
    expect(duplicate).toMatchObject({ startTicks: 768, trigger: { pitch: 60 } });
    const [copied] = notesOf(copyId);
    expect(notesOf(copyId)).toHaveLength(1);
    expect(copied).toMatchObject({
      startTicks: duplicate?.startTicks,
      trigger: duplicate?.trigger,
    });
  });

  it("leaves production's turn as it was with the tactic at its default", () => {
    const options = { targets: new Map(), track: withCreatedTargets };
    const short = call("placement_create", { clipId: PLACED, bars: [1, 2] });
    // No ledger, no rewrite: the default expander passes the call through.
    expect(
      accepted(createNoteExpander(STEM, undefined, options).expand(short)).call,
    ).toEqual(short);
  });
});
