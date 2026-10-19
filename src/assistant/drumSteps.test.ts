import { describe, expect, it } from "vitest";
import { MAX_CLIP_LENGTH_BARS, MAX_CLIP_LENGTH_TICKS } from "../domain/clipLength";
import { createDenseStepFixtureProject } from "../domain/fixtures";
import {
  createScriptedAssistantProvider,
  toolUseEvents,
} from "../testing/scriptedAssistantProvider";
import {
  createNoteExpander,
  gatewayNoteId,
  MAX_TURN_NOTES,
  type StepStringOptions,
} from "./compactNotes";
import {
  DEFAULT_STEP_TICKS,
  DEFAULT_STEP_VELOCITIES,
  expandDrumSteps,
  STEP_VELOCITY_SCALE,
  type StepClip,
} from "./drumSteps";
import { runAssistantTurn } from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import { buildAssistantPayload } from "./payload";
import {
  ASSISTANT_SYSTEM_PROMPT,
  assistantSystemPrompt,
  DRUM_STEP_STRINGS_LINE,
  newId,
} from "./prompt";
import { validateProposal } from "./proposal";
import type { AssistantToolCall } from "./protocol";
import { withCreatedTargets } from "./recommendationTargets";
import { TACTIC_DEFAULTS, TACTICS } from "./tactics";
import {
  assistantTools,
  CREATE_EXAMPLES,
  EXPLAIN_TOOL_NAME,
  resolveToolCall,
} from "./tools";

const STEM = "Stem0000000000000";
const TRACK = "trk_KitTrack0000000000001";
const KICK = "pad_Kick00000000000000001";
const HAT = "pad_Hat000000000000000001";
const BAR = 768;

function clip(overrides: Partial<StepClip> = {}): StepClip {
  return {
    trackId: TRACK,
    lengthTicks: BAR,
    pads: new Set([KICK, HAT]),
    maxHits: MAX_TURN_NOTES,
    ...overrides,
  };
}

function hitsOf(raw: unknown, on: StepClip = clip()) {
  const expansion = expandDrumSteps(raw, on);
  if (!expansion.ok) throw new Error(`${expansion.field}: ${expansion.reason}`);
  return expansion.hits;
}

function reasonFor(raw: unknown, on: StepClip = clip()): string {
  const expansion = expandDrumSteps(raw, on);
  if (expansion.ok) throw new Error("expected a refusal");
  return `${expansion.field ?? "(entry)"}: ${expansion.reason}`;
}

describe("a drum step string (GRV-140)", () => {
  it("expands to the same hits every time", () => {
    const entry = { padId: KICK, steps: "x.o.X.o.x.o.X.oo", stepTicks: 48 };
    expect(hitsOf(entry)).toEqual(hitsOf(structuredClone(entry)));
    expect(hitsOf(entry).map((hit) => hit.startTicks)).toEqual([
      0, 96, 192, 288, 384, 480, 576, 672, 720,
    ]);
  });

  it("defaults to a 16th, and lands a 16th-triplet and a 32nd grid on their ticks", () => {
    expect(DEFAULT_STEP_TICKS).toBe(48);
    expect(hitsOf({ padId: HAT, steps: "x" }).map((hit) => hit.startTicks)).toEqual(
      Array.from({ length: 16 }, (_, step) => step * 48),
    );
    const triplets = hitsOf({ padId: HAT, steps: "x..", stepTicks: 32 });
    // One hit per beat on the triplet grid: every third 16th triplet.
    expect(triplets.map((hit) => hit.startTicks)).toEqual([
      0, 96, 192, 288, 384, 480, 576, 672,
    ]);
    expect(triplets.every((hit) => hit.durationTicks === 32)).toBe(true);
    const thirtySeconds = hitsOf(
      { padId: HAT, steps: ".x", stepTicks: 24 },
      clip({ lengthTicks: 192 }),
    );
    expect(thirtySeconds.map((hit) => hit.startTicks)).toEqual([24, 72, 120, 168]);
  });

  it("repeats from the clip's start to fill it exactly, and stops at its end", () => {
    const eightBars = hitsOf(
      { padId: KICK, steps: "x...x...x...x..." },
      clip({ lengthTicks: 8 * BAR }),
    );
    expect(eightBars).toHaveLength(32);
    expect(eightBars.at(-1)?.startTicks).toBe(8 * BAR - 192);
    // A clip that ends inside a step: the last hit starts in the clip and is
    // cut short at its end.
    const short = hitsOf({ padId: KICK, steps: "x" }, clip({ lengthTicks: 100 }));
    expect(short.map((hit) => [hit.startTicks, hit.durationTicks])).toEqual([
      [0, 48],
      [48, 48],
      [96, 4],
    ]);
    // A string exactly as long as the clip plays once.
    expect(
      hitsOf({ padId: KICK, steps: "x.x." }, clip({ lengthTicks: 192 })),
    ).toHaveLength(2);
  });

  it("gives x, X and o their velocities, the string's own or the defaults", () => {
    expect(DEFAULT_STEP_VELOCITIES).toEqual({ x: 100, X: 120, o: 50 });
    const velocities = (raw: unknown) =>
      hitsOf(raw, clip({ lengthTicks: 144 })).map((hit) => hit.velocity);
    expect(velocities({ padId: KICK, steps: "xXo" })).toEqual([
      Math.round((100 / 127) * 1000) / 1000,
      Math.round((120 / 127) * 1000) / 1000,
      Math.round((50 / 127) * 1000) / 1000,
    ]);
    expect(velocities({ padId: KICK, steps: "xXo", velocity: { X: 127, o: 1 } })).toEqual(
      [Math.round((100 / 127) * 1000) / 1000, 1, Math.round((1 / 127) * 1000) / 1000],
    );
  });

  it("refuses bad input with the reason", () => {
    expect(reasonFor({ padId: KICK, steps: "x.-." })).toMatch(
      /^steps: "-" at step 3 is not a step; use only x \(hit\), X \(accent\), o \(ghost\) and \. \(rest\)/,
    );
    expect(reasonFor({ padId: KICK, steps: "x", stepTicks: 0 })).toMatch(
      /^stepTicks: must be a positive whole number/,
    );
    expect(reasonFor({ padId: KICK, steps: "x", stepTicks: 1.5 })).toMatch(/^stepTicks:/);
    expect(reasonFor({ padId: KICK, steps: "x".repeat(17) })).toBe(
      "steps: 17 steps of 48 ticks is 816 ticks, longer than the clip's 768; write one bar (or less) and it repeats to fill the clip",
    );
    expect(reasonFor({ padId: "pad_Snare0000000000000001", steps: "x" })).toMatch(
      /^padId: the track "trk_KitTrack0000000000001" has no pad "pad_Snare0000000000000001"\. Use one of its pads: pad_Kick/,
    );
    expect(reasonFor({ padId: KICK, steps: "x" }, clip({ pads: undefined }))).toMatch(
      /^padId: .*is not a drum machine/,
    );
    expect(reasonFor({ padId: KICK, steps: "x", velocity: { x: 200 } })).toMatch(
      /^velocity\.x:/,
    );
    expect(reasonFor({ padId: KICK, steps: "x", swing: 60 })).toMatch(/^\(entry\):/);
    expect(reasonFor({ padId: KICK, steps: "" })).toMatch(/^steps:/);
  });

  it("refuses a clip longer than a clip may be, rests and all, without walking it", () => {
    const rests = { padId: KICK, steps: ".", stepTicks: 1 };
    for (const lengthTicks of [1e12, MAX_CLIP_LENGTH_TICKS + 1, 0, 1.5]) {
      expect(reasonFor(rests, clip({ lengthTicks }))).toBe(
        `(entry): the clip's lengthTicks must be a whole number from 1 to ${MAX_CLIP_LENGTH_TICKS} (${MAX_CLIP_LENGTH_BARS} bars) for its step strings to fill`,
      );
    }
    expect(hitsOf(rests, clip({ lengthTicks: MAX_CLIP_LENGTH_TICKS }))).toEqual([]);
    // A hit string over the longest clip makes one hit per step, up to the cap.
    const ticks = hitsOf(
      { padId: KICK, steps: "x...", stepTicks: 48 },
      clip({ lengthTicks: MAX_CLIP_LENGTH_TICKS }),
    );
    expect(ticks).toHaveLength(MAX_CLIP_LENGTH_TICKS / 192);
    expect(
      reasonFor({ padId: KICK, steps: "x" }, clip({ lengthTicks: BAR, maxHits: 3 })),
    ).toBe(
      "steps: this string makes more notes than the 3 this proposal has left; use a shorter clip and loop its placement",
    );
  });
});

/** A turn's expander with step strings on, over a kit of KICK and HAT. */
function stepExpander(): ReturnType<typeof createNoteExpander> {
  const options: StepStringOptions = {
    targets: new Map([[TRACK, new Set([KICK, HAT])]]),
    track: withCreatedTargets,
  };
  return createNoteExpander(STEM, undefined, options);
}

function clipCreate(
  events: unknown[],
  lengthTicks = BAR,
  trackId = TRACK,
): AssistantToolCall {
  return {
    id: "toolu_1",
    name: "clip_create",
    input: {
      ...CREATE_EXAMPLES.clip,
      trackId,
      lengthTicks,
      content: { kind: "notes", events },
    },
  };
}

function eventsOf(call: AssistantToolCall) {
  return (call.input as { content: { events: { id: string; startTicks: number }[] } })
    .content.events;
}

describe("the note expander with step strings on", () => {
  it("writes a string out as ordinary note events, numbered with the turn's tuples", () => {
    const notes = stepExpander();
    const expanded = notes.expand(
      clipCreate([[0, KICK, 48, 0.9], { padId: HAT, steps: "..x." }]),
    );
    if (!expanded.ok) throw new Error(expanded.message);
    expect(expanded.noteIds).toEqual(
      [1, 2, 3, 4, 5].map((index) => gatewayNoteId(STEM, index)),
    );
    expect(eventsOf(expanded.call).map((event) => event.startTicks)).toEqual([
      0, 96, 288, 480, 672,
    ]);
    expect(eventsOf(expanded.call)[1]).toEqual({
      id: `evt_${STEM}n002`,
      trigger: { kind: "pad", padId: HAT },
      startTicks: 96,
      durationTicks: 48,
      velocity: Math.round((100 / 127) * 1000) / 1000,
      probability: null,
    });
    // What it writes is what clip_create takes.
    expect(resolveToolCall(expanded.call.name, expanded.call.input).ok).toBe(true);
  });

  it("refuses a bad string back with where and why, as a bad tuple is", () => {
    const notes = stepExpander();
    const refused = notes.expand(
      clipCreate([[0, KICK, 48, 0.9], { padId: KICK, steps: "x?" }]),
    );
    expect(refused).toEqual({
      ok: false,
      message: expect.stringMatching(/^content\.events\.1\.steps: "\?" at step 2/),
    });
    // A refused call uses up no IDs.
    const accepted = notes.expand(clipCreate([{ padId: KICK, steps: "x" }]));
    expect(accepted.ok && accepted.noteIds[0]).toBe(gatewayNoteId(STEM, 1));
  });

  it("checks a pad against a drum machine an earlier call in the turn made", () => {
    const notes = stepExpander();
    const kit = {
      ...CREATE_EXAMPLES.track,
      id: "trk_NewKit000000000000001",
      instrument: {
        kind: "drumMachine",
        parameters: {},
        pads: [
          {
            id: "pad_Clap00000000000000001",
            name: "Clap",
            assetId: null,
            chokeGroup: null,
            parameters: {},
            mixer: { volume: 0, pan: 0, muted: false, soloed: false },
          },
        ],
      },
    };
    const onNewKit = clipCreate(
      [{ padId: "pad_Clap00000000000000001", steps: "....x..." }],
      BAR,
      kit.id,
    );
    expect(notes.expand(onNewKit).ok).toBe(false);
    expect(notes.expand({ id: "toolu_0", name: "track_create", input: kit }).ok).toBe(
      true,
    );
    expect(notes.expand(onNewKit).ok).toBe(true);
  });

  it("counts every repeated hit toward the turn's notes", () => {
    const notes = stepExpander();
    // 999 notes: 62 strings of 16 hits fill 992, and the 63rd needs 16 more.
    for (let index = 0; index < 62; index += 1) {
      expect(notes.expand(clipCreate([{ padId: HAT, steps: "x" }])).ok).toBe(true);
    }
    // The string is told how many notes the turn has left, so it stops there.
    expect(notes.expand(clipCreate([{ padId: HAT, steps: "x" }]))).toEqual({
      ok: false,
      message: `content.events.0.steps: this string makes more notes than the ${MAX_TURN_NOTES - 992} this proposal has left; use a shorter clip and loop its placement`,
    });
    expect(notes.expand(clipCreate([{ padId: HAT, steps: "x......." }])).ok).toBe(true);
  });

  it("refuses a clip past the longest a clip may be before expanding anything", () => {
    const notes = stepExpander();
    // A rest-only string over a trillion ticks: refused at once, not walked.
    const started = performance.now();
    for (const lengthTicks of [1e12, MAX_CLIP_LENGTH_TICKS + 1]) {
      const refused = notes.expand(
        clipCreate([{ padId: KICK, steps: ".", stepTicks: 1 }], lengthTicks),
      );
      expect(refused).toEqual({
        ok: false,
        message: `lengthTicks: a clip is a whole number of ticks from 1 to ${MAX_CLIP_LENGTH_TICKS} (${MAX_CLIP_LENGTH_BARS} bars); its step strings fill it`,
      });
    }
    expect(performance.now() - started).toBeLessThan(1_000);
    // The longest clip there is takes the same string, and makes no notes.
    const longest = notes.expand(
      clipCreate([{ padId: KICK, steps: ".", stepTicks: 1 }], MAX_CLIP_LENGTH_TICKS),
    );
    expect(longest.ok && longest.noteIds).toEqual([]);
  });

  it("takes a step string only in clip_create", () => {
    const refused = stepExpander().expand({
      id: "toolu_1",
      name: "note_add",
      input: { clipId: CREATE_EXAMPLES.clip.id, notes: [{ padId: KICK, steps: "x" }] },
    });
    expect(refused.ok ? null : refused.message).toMatch(
      /^notes\.0: a step string goes in clip_create's content\.events/,
    );
  });

  it("leaves a string unexpanded with the tactic off, for the tool to refuse", () => {
    const call = clipCreate([{ padId: KICK, steps: "x" }]);
    const expanded = createNoteExpander(STEM).expand(call);
    expect(expanded.ok && expanded.call).toEqual(call);
    expect(resolveToolCall(call.name, call.input).ok).toBe(false);
  });
});

describe("the drumStepStrings tactic", () => {
  it("is off by default, and changes the prompt, the tools and their expansion", () => {
    expect(TACTICS.drumStepStrings.values).toEqual(["off", "on"]);
    expect(TACTICS.drumStepStrings.alters).toEqual(["prompt", "tools", "expansion"]);
  });

  it("describes the form in the prompt only when on", () => {
    expect(assistantSystemPrompt()).toBe(
      assistantSystemPrompt({ drumStepStrings: TACTIC_DEFAULTS.drumStepStrings }),
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toBe(assistantSystemPrompt(TACTIC_DEFAULTS));
    const off = assistantSystemPrompt({ drumStepStrings: "off" });
    expect(off).not.toContain(DRUM_STEP_STRINGS_LINE);
    const on = assistantSystemPrompt({ drumStepStrings: "on" });
    expect(on).toContain(`${DRUM_STEP_STRINGS_LINE}\n- parameter_set takes`);
    expect(on.replace(`${DRUM_STEP_STRINGS_LINE}\n`, "")).toBe(off);
  });

  it("offers step strings in clip_create only when on, and changes no other tool", () => {
    // Pattern generators off (GRV-141), whatever their default, so only step strings differ.
    const off = assistantTools("full", "off", "off");
    const on = assistantTools("full", "on", "off");
    expect(assistantTools()).toBe(
      assistantTools(
        "full",
        TACTIC_DEFAULTS.drumStepStrings,
        TACTIC_DEFAULTS.patternGenerators,
      ),
    );
    expect(on.map((tool) => tool.name)).toEqual(off.map((tool) => tool.name));
    for (const [index, tool] of on.entries()) {
      if (tool.name === "clip_create") continue;
      expect(tool).toEqual(off[index]);
    }
    const offClip = off.find((tool) => tool.name === "clip_create");
    const onClip = on.find((tool) => tool.name === "clip_create");
    expect(JSON.stringify(offClip?.inputSchema)).not.toContain("stepTicks");
    expect(offClip?.description).not.toContain("step string");
    expect(JSON.stringify(onClip?.inputSchema)).toContain("stepTicks");
    expect(onClip?.description).toContain("step string");
  });

  it("keeps the step-string text when toolText trims clip_create (GRV-146)", () => {
    for (const level of ["moderate", "aggressive"] as const) {
      const trimmed = assistantTools(level, "off", "off").find(
        (tool) => tool.name === "clip_create",
      );
      const onClip = assistantTools(level, "on", "off").find(
        (tool) => tool.name === "clip_create",
      );
      expect(onClip?.description.startsWith(`${trimmed?.description} `)).toBe(true);
      expect(onClip?.description).toContain("step string");
      expect(JSON.stringify(onClip?.inputSchema)).toContain("stepTicks");
    }
  });

  it("says the velocities are on a MIDI scale, not a note array's 0 to 1, everywhere it describes them", () => {
    expect(STEP_VELOCITY_SCALE).toContain("MIDI scale of 1 to 127, not the 0 to 1");
    expect(DRUM_STEP_STRINGS_LINE).toContain(STEP_VELOCITY_SCALE);
    const onClip = assistantTools("full", "on").find(
      (tool) => tool.name === "clip_create",
    );
    expect(onClip?.description).toContain(STEP_VELOCITY_SCALE);
    expect(JSON.stringify(onClip?.inputSchema)).toContain(STEP_VELOCITY_SCALE);
  });

  it("sends the form and expands it in a turn, into a proposal the browser accepts", async () => {
    const project = createDenseStepFixtureProject();
    const [kit] = project.song.tracks;
    if (kit?.instrument?.kind !== "drumMachine") throw new Error("not a kit");
    const [bd, sd, hh] = kit.instrument.pads;
    const clipId = newId("clp", STEM, 1);
    const calls = [
      {
        name: "clip_create",
        input: {
          ...CREATE_EXAMPLES.clip,
          id: clipId,
          trackId: kit.id,
          lengthTicks: 2 * BAR,
          content: {
            kind: "notes",
            events: [
              { padId: bd?.id, steps: "x...x...x...x..." },
              { padId: sd?.id, steps: "....X.......X..o", velocity: { X: 110 } },
              { padId: hh?.id, steps: "x.x.", stepTicks: 24 },
            ],
          },
        },
      },
      {
        name: "placement_create",
        input: {
          ...CREATE_EXAMPLES.placement,
          clipId,
          trackId: kit.id,
          startTicks: 4 * BAR * 4,
          durationTicks: 2 * BAR,
        },
      },
      { name: EXPLAIN_TOOL_NAME, input: { goal: "A beat", technique: "A grid" } },
    ];
    const provider = createScriptedAssistantProvider([toolUseEvents("A beat.", calls)]);
    const result = await runAssistantTurn(
      {
        provider,
        guards: createInMemoryGuardStores(),
        log: () => {},
        now: () => 1_000,
        idStem: () => STEM,
        tactics: { drumStepStrings: "on" },
      },
      { uid: "uid-1", signInProvider: "google.com" },
      {
        projectRevision: project.metadata.revision,
        messages: [{ role: "user", text: "Add a two-bar beat" }],
        context: buildAssistantPayload(project),
      },
      { signal: new AbortController().signal, onChunk: () => {} },
    );
    const sent = JSON.stringify(provider.requests[0]);
    expect(sent).toContain(JSON.stringify(DRUM_STEP_STRINGS_LINE).slice(1, -1));
    const created = result.proposal?.calls.find((entry) => entry.name === "clip_create");
    if (!created) throw new Error("no clip_create");
    const events = eventsOf(created);
    // 8 kicks, 4 snares and 2 ghosts, and 32 hats on every other 32nd.
    expect(events).toHaveLength(8 + 6 + 32);
    expect(events.map((event) => event.id)).toEqual(
      events.map((_, index) => gatewayNoteId(STEM, index + 1)),
    );
    expect(JSON.stringify(result.proposal)).not.toContain("steps");
    const validation = validateProposal(project, result.proposal);
    expect(validation.ok ? null : validation.issues).toBeNull();
  });
});
