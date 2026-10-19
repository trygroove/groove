import { describe, expect, it } from "vitest";
import {
  createScriptedAssistantProvider,
  toolUseEvents,
} from "../../testing/scriptedAssistantProvider";
import {
  createNoteExpander,
  gatewayNoteId,
  MAX_TURN_NOTES,
  type StepStringOptions,
} from "../compactNotes";
import { createHouseLoopProject } from "../evals/fixtures";
import { runAssistantTurn } from "../gateway";
import { createInMemoryGuardStores } from "../inMemoryGuardStores";
import { buildAssistantPayload } from "../payload";
import {
  assistantSystemPrompt,
  DRUM_STEP_STRINGS_LINE,
  newId,
  PATTERN_GENERATORS_LINE,
} from "../prompt";
import { validateProposal } from "../proposal";
import type { AssistantToolCall } from "../protocol";
import { withCreatedTargets } from "../recommendationTargets";
import { TACTIC_DEFAULTS, TACTICS } from "../tactics";
import {
  assistantTools,
  CREATE_EXAMPLES,
  EXPLAIN_TOOL_NAME,
  resolveToolCall,
} from "../tools";
import {
  expandGenerator,
  GENERATOR_NAMES,
  GENERATORS_DESCRIPTION,
  type GeneratorClip,
  MAX_EUCLIDEAN_STEPS,
} from ".";

const STEM = "Stem0000000000000";
const KIT = "trk_KitTrack0000000000001";
const SYNTH = "trk_Synth0000000000000001";
const KICK = "pad_Kick00000000000000001";
const HAT = "pad_Hat000000000000000001";
const BAR = 768;

function clip(overrides: Partial<GeneratorClip> = {}): GeneratorClip {
  return {
    trackId: KIT,
    lengthTicks: BAR,
    pads: new Set([KICK, HAT]),
    seed: "seed",
    maxNotes: MAX_TURN_NOTES,
    ...overrides,
  };
}

/** {@link clip} on the synth, which has no pads. */
function synthClip(overrides: Partial<GeneratorClip> = {}): GeneratorClip {
  return clip({ trackId: SYNTH, pads: new Set(), ...overrides });
}

function reasonFor(raw: unknown, on: GeneratorClip = clip()): string {
  const expansion = expandGenerator(raw, on);
  if (expansion.ok) throw new Error("expected a refusal");
  return `${expansion.field ?? "(call)"}: ${expansion.reason}`;
}

/** A turn's expander with generators on (and step strings off), over a kit and a synth. */
function generatorExpander(
  forms: Partial<StepStringOptions> = {},
  mark?: string,
): ReturnType<typeof createNoteExpander> {
  return createNoteExpander(STEM, mark, {
    targets: new Map([
      [KIT, new Set([KICK, HAT])],
      [SYNTH, new Set<string>()],
    ]),
    track: withCreatedTargets,
    stepStrings: false,
    generators: true,
    ...forms,
  });
}

function clipCreate(
  events: unknown[],
  trackId = KIT,
  lengthTicks = BAR,
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

type Event = {
  id: string;
  startTicks: number;
  durationTicks: number;
  velocity: number;
  trigger: { kind: string; padId?: string; pitch?: number };
};

function eventsOf(call: AssistantToolCall): Event[] {
  return (call.input as { content: { events: Event[] } }).content.events;
}

function expanded(
  notes: ReturnType<typeof createNoteExpander>,
  call: AssistantToolCall,
): Event[] {
  const result = notes.expand(call);
  if (!result.ok) throw new Error(result.message);
  return eventsOf(result.call);
}

describe("expandGenerator (GRV-141)", () => {
  it("returns a drum generator's step string and a melodic one's tuples", () => {
    expect(expandGenerator({ generator: "fourOnTheFloor", padId: KICK }, clip())).toEqual(
      {
        ok: true,
        entries: [{ padId: KICK, steps: "x...x...x...x...", stepTicks: 48 }],
      },
    );
    const arp = expandGenerator(
      { generator: "arpeggio", chords: [["C", 1]], rate: "4th" },
      clip({ trackId: SYNTH, pads: new Set() }),
    );
    expect(arp.ok && arp.entries).toEqual([
      [0, 60, 192, 0.8],
      [192, 64, 192, 0.8],
      [384, 67, 192, 0.8],
      [576, 60, 192, 0.8],
    ]);
  });

  it("gives the same entries for the same seed, and different ones for another", () => {
    const call = { generator: "hats", padId: HAT, rate: "16th", bars: 1, variation: 0.7 };
    expect(expandGenerator(call, clip())).toEqual(expandGenerator(call, clip()));
    expect(expandGenerator(call, clip())).not.toEqual(
      expandGenerator(call, clip({ seed: "other" })),
    );
  });

  it("makes the same random arpeggio in any turn at variation 0, and varies it by the turn above", () => {
    const call = {
      generator: "arpeggio",
      chords: [["Am7", 1]],
      direction: "random",
      octaves: 2,
    };
    expect(expandGenerator(call, synthClip())).toEqual(
      expandGenerator(call, synthClip({ seed: "other" })),
    );
    const varied = { ...call, variation: 0.5 };
    expect(expandGenerator(varied, synthClip())).toEqual(
      expandGenerator(varied, synthClip()),
    );
    expect(expandGenerator(varied, synthClip())).not.toEqual(
      expandGenerator(varied, synthClip({ seed: "other" })),
    );
  });

  it("refuses more Euclidean hits than steps", () => {
    expect(reasonFor({ generator: "euclidean", padId: KICK, hits: 9, steps: 8 })).toBe(
      "hits: 9 hits do not fit in 8 steps; a Euclidean rhythm has at most one hit a step",
    );
    expect(
      reasonFor({
        generator: "euclidean",
        padId: KICK,
        hits: 3,
        steps: MAX_EUCLIDEAN_STEPS + 1,
      }),
    ).toMatch(/^steps: Too big/);
    expect(
      reasonFor({
        generator: "euclidean",
        padId: KICK,
        hits: 3,
        steps: 8,
        rotate: MAX_EUCLIDEAN_STEPS + 1,
      }),
    ).toMatch(/^rotate: Too big/);
  });

  it("refuses a pattern longer than the clip", () => {
    expect(reasonFor({ generator: "backbeat", padId: KICK, bars: 2 })).toMatch(
      /^bars: 2 bars is longer than the clip's 1/,
    );
    expect(
      reasonFor({
        generator: "euclidean",
        padId: KICK,
        hits: 3,
        steps: 8,
        stepTicks: 192,
      }),
    ).toMatch(/^steps: 8 steps of 192 ticks is 1536 ticks, longer than the clip's 768/);
  });

  it("refuses an unknown generator, an unknown field and a value out of range", () => {
    expect(reasonFor({ generator: "trapHats", padId: KICK })).toBe(
      `generator: "trapHats" is not a generator; use one of ${GENERATOR_NAMES.join(", ")}`,
    );
    expect(reasonFor({ generator: "fourOnTheFloor", padId: KICK, swing: 0.5 })).toMatch(
      /fourOnTheFloor takes padId, bars, velocity, variation$/,
    );
    expect(reasonFor({ generator: "hats", padId: HAT, rate: "32nd" })).toMatch(/^rate: /);
    expect(
      reasonFor({ generator: "fourOnTheFloor", padId: KICK, variation: 1.5 }),
    ).toMatch(/^variation: /);
    expect(
      reasonFor(
        { generator: "arpeggio", chords: [["C", 1]], velocity: 2 },
        clip({ pads: new Set() }),
      ),
    ).toMatch(/^velocity: /);
  });

  it("refuses a melodic generator on a drum machine", () => {
    expect(reasonFor({ generator: "bassRoot", chords: [["C", 1]] })).toMatch(
      /^generator: the track "trk_KitTrack0000000000001" is a drum machine; bassRoot is for a pitched track/,
    );
  });

  it("refuses an unknown chord with the reason", () => {
    expect(
      reasonFor(
        {
          generator: "chordStabs",
          chords: [
            ["Am", 0.5],
            ["Cadd9", 0.5],
          ],
        },
        clip({ trackId: SYNTH, pads: new Set() }),
      ),
    ).toMatch(/^chords\.1\.0: "Cadd9" is not a chord Groove voices/);
  });
});

describe("the note expander with generators on (GRV-141)", () => {
  it("writes a generator out as ordinary note events, numbered with the turn's tuples", () => {
    const notes = generatorExpander();
    const events = expanded(
      notes,
      clipCreate([[0, HAT, 48, 0.9], { generator: "fourOnTheFloor", padId: KICK }]),
    );
    expect(events.map((event) => event.id)).toEqual(
      [1, 2, 3, 4, 5].map((index) => gatewayNoteId(STEM, index)),
    );
    expect(events.map((event) => event.startTicks)).toEqual([0, 0, 192, 384, 576]);
    expect(events[1]).toEqual({
      id: gatewayNoteId(STEM, 2),
      trigger: { kind: "pad", padId: KICK },
      startTicks: 0,
      durationTicks: 48,
      velocity: Math.round((100 / 127) * 1000) / 1000,
      probability: null,
    });
    const melodic = notes.expand(
      clipCreate(
        [{ generator: "bassRoot", chords: [["Am", 1]], rhythm: "x...x...x...x..." }],
        SYNTH,
      ),
    );
    if (!melodic.ok) throw new Error(melodic.message);
    expect(melodic.noteIds[0]).toBe(gatewayNoteId(STEM, 6));
    expect(eventsOf(melodic.call)[0].trigger).toEqual({ kind: "pitch", pitch: 45 });
    // What it writes is what clip_create takes.
    expect(resolveToolCall(melodic.call.name, melodic.call.input).ok).toBe(true);
  });

  it("refuses a bad call back with where and why, using up no IDs", () => {
    const notes = generatorExpander();
    expect(
      notes.expand(
        clipCreate([
          [0, KICK, 48, 0.9],
          { generator: "euclidean", padId: KICK, hits: 6, steps: 4 },
        ]),
      ),
    ).toEqual({
      ok: false,
      message:
        "content.events.1.hits: 6 hits do not fit in 4 steps; a Euclidean rhythm has at most one hit a step",
    });
    expect(
      notes.expand(
        clipCreate([{ generator: "backbeat", padId: "pad_Nope00000000000000001" }]),
      ),
    ).toEqual({
      ok: false,
      message: expect.stringMatching(
        /^content\.events\.0\.padId: the track "trk_KitTrack0000000000001" has no pad/,
      ),
    });
    const accepted = notes.expand(clipCreate([{ generator: "backbeat", padId: KICK }]));
    expect(accepted.ok && accepted.noteIds[0]).toBe(gatewayNoteId(STEM, 1));
  });

  it("seeds variation from the turn's stem and the call's position: the same call in the same place, the same notes", () => {
    const call = clipCreate([
      { generator: "hats", padId: HAT, rate: "16th", variation: 1 },
    ]);
    const first = expanded(generatorExpander(), call);
    expect(expanded(generatorExpander(), call)).toEqual(first);
    // The same call a position later in the turn varies differently.
    const later = generatorExpander();
    expanded(later, clipCreate([[0, KICK, 48, 0.9]]));
    const moved = expanded(later, call);
    const shape = (events: Event[]) =>
      events.map((event) => [event.startTicks, event.velocity]);
    expect(shape(moved)).not.toEqual(shape(first));
    // So does the same call in a turn with another stem.
    const otherTurn = createNoteExpander("Other000000000000", undefined, {
      targets: new Map([[KIT, new Set([KICK, HAT])]]),
      track: withCreatedTargets,
      generators: true,
      stepStrings: false,
    });
    expect(shape(expanded(otherTurn, call))).not.toEqual(shape(first));
    // A refused call does not move the position, so its correction varies as it would have.
    const refusedFirst = generatorExpander();
    expect(refusedFirst.expand(clipCreate([{ generator: "nope" }])).ok).toBe(false);
    expect(expanded(refusedFirst, call)).toEqual(first);
  });

  it("checks a drum generator's pad against a kit an earlier call in the turn made", () => {
    const notes = generatorExpander();
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
      [{ generator: "backbeat", padId: "pad_Clap00000000000000001" }],
      kit.id,
    );
    expect(notes.expand(onNewKit).ok).toBe(false);
    expect(notes.expand({ id: "toolu_0", name: "track_create", input: kit }).ok).toBe(
      true,
    );
    expect(notes.expand(onNewKit).ok).toBe(true);
  });

  it("counts every generated note toward the turn's notes", () => {
    const notes = generatorExpander();
    for (let index = 0; index < 62; index += 1) {
      expect(
        notes.expand(clipCreate([{ generator: "hats", padId: HAT, rate: "16th" }])).ok,
      ).toBe(true);
    }
    expect(
      notes.expand(clipCreate([{ generator: "arpeggio", chords: [["C", 1]] }], SYNTH)),
    ).toEqual({
      ok: false,
      message: `content.events.0: this generator makes more notes than the ${MAX_TURN_NOTES - 992} this proposal has left; use a shorter clip and loop its placement`,
    });
  });

  it("takes a generator only in clip_create", () => {
    const refused = generatorExpander().expand({
      id: "toolu_1",
      name: "note_add",
      input: {
        clipId: CREATE_EXAMPLES.clip.id,
        notes: [{ generator: "fourOnTheFloor", padId: KICK }],
      },
    });
    expect(refused.ok ? null : refused.message).toMatch(
      /^notes\.0: a generator call goes in clip_create's content\.events/,
    );
  });

  it("leaves a generator unexpanded with the tactic off, for the tool to refuse", () => {
    const call = clipCreate([{ generator: "fourOnTheFloor", padId: KICK }]);
    for (const notes of [
      createNoteExpander(STEM),
      generatorExpander({ generators: false, stepStrings: true }),
    ]) {
      const result = notes.expand(call);
      expect(result.ok && result.call).toEqual(call);
    }
    expect(resolveToolCall(call.name, call.input).ok).toBe(false);
  });

  it("leaves a model's step string unexpanded with step strings off, even with generators on", () => {
    const call = clipCreate([{ padId: KICK, steps: "x..." }]);
    const result = generatorExpander().expand(call);
    expect(result.ok && result.call).toEqual(call);
  });
});

describe("the patternGenerators tactic", () => {
  it("is off by default, and changes the prompt, the tools and their expansion", () => {
    expect(TACTICS.patternGenerators.values).toEqual(["off", "on"]);
    expect(TACTICS.patternGenerators.alters).toEqual(["prompt", "tools", "expansion"]);
  });

  it("describes the generators in the prompt only when on", () => {
    expect(assistantSystemPrompt()).toBe(
      assistantSystemPrompt({ patternGenerators: TACTIC_DEFAULTS.patternGenerators }),
    );
    const off = assistantSystemPrompt({
      patternGenerators: "off",
      drumStepStrings: "off",
    });
    expect(off).not.toContain(PATTERN_GENERATORS_LINE);
    const on = assistantSystemPrompt({ patternGenerators: "on", drumStepStrings: "off" });
    expect(on).toContain(`${PATTERN_GENERATORS_LINE}\n- parameter_set takes`);
    expect(on.replace(`${PATTERN_GENERATORS_LINE}\n`, "")).toBe(off);
    // With step strings on too, both lines, generators first.
    const both = assistantSystemPrompt({
      patternGenerators: "on",
      drumStepStrings: "on",
    });
    expect(both).toContain(
      `${PATTERN_GENERATORS_LINE}\n${DRUM_STEP_STRINGS_LINE}\n- parameter_set takes`,
    );
  });

  it("offers generators in clip_create only when on, and changes no other tool", () => {
    // Step strings off, whatever their default, so only generators differ.
    const off = assistantTools("full", "off", "off");
    const on = assistantTools("full", "off", "on");
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
    expect(JSON.stringify(offClip?.inputSchema)).not.toContain("fourOnTheFloor");
    expect(offClip?.description).not.toContain("pattern generator");
    expect(JSON.stringify(onClip?.inputSchema)).toContain("fourOnTheFloor");
    expect(onClip?.description).toContain(GENERATORS_DESCRIPTION);
    // Nothing in it reads as the step-string form, which drumStepStrings alone offers.
    expect(onClip?.description).not.toContain("step string");
  });

  it("offers step strings and generators together, and keeps both when toolText trims clip_create (GRV-146)", () => {
    for (const level of ["full", "moderate", "aggressive"] as const) {
      const trimmed = assistantTools(level, "off", "off").find(
        (tool) => tool.name === "clip_create",
      );
      const both = assistantTools(level, "on", "on").find(
        (tool) => tool.name === "clip_create",
      );
      expect(both?.description.startsWith(`${trimmed?.description} `)).toBe(true);
      expect(both?.description).toContain("step string");
      expect(both?.description).toContain(GENERATORS_DESCRIPTION);
      const schema = JSON.stringify(both?.inputSchema);
      expect(schema).toContain("fourOnTheFloor");
      expect(schema).toContain('"steps"');
    }
  });

  it("sends the generators and expands them in a turn, into a proposal the browser accepts", async () => {
    const project = createHouseLoopProject();
    const kit = project.song.tracks.find(
      (track) => track.instrument?.kind === "drumMachine",
    );
    const synth = project.song.tracks.find(
      (track) => track.instrument !== null && track.instrument?.kind !== "drumMachine",
    );
    if (kit?.instrument?.kind !== "drumMachine" || !synth) {
      throw new Error("expected a kit and a pitched track");
    }
    const [kick, second] = kit.instrument.pads;
    const drumClip = newId("clp", STEM, 1);
    const bassClip = newId("clp", STEM, 2);
    const calls = [
      {
        name: "clip_create",
        input: {
          ...CREATE_EXAMPLES.clip,
          id: drumClip,
          trackId: kit.id,
          lengthTicks: 2 * BAR,
          content: {
            kind: "notes",
            events: [
              { generator: "fourOnTheFloor", padId: kick?.id },
              {
                generator: "euclidean",
                padId: second?.id,
                hits: 5,
                steps: 16,
                rotate: 2,
              },
            ],
          },
        },
      },
      {
        name: "clip_create",
        input: {
          ...CREATE_EXAMPLES.clip,
          id: bassClip,
          trackId: synth.id,
          lengthTicks: 4 * BAR,
          content: {
            kind: "notes",
            events: [
              {
                generator: "bassRoot",
                chords: [
                  ["Am", 1],
                  ["F", 1],
                  ["C", 1],
                  ["G", 1],
                ],
                rhythm: "x..x..x.",
                variation: 0.5,
              },
            ],
          },
        },
      },
      ...[drumClip, bassClip].map((clipId, index) => ({
        name: "placement_create",
        input: {
          ...CREATE_EXAMPLES.placement,
          id: newId("plc", STEM, index + 1),
          clipId,
          trackId: index === 0 ? kit.id : synth.id,
          startTicks: 16 * BAR,
          durationTicks: index === 0 ? 2 * BAR : 4 * BAR,
        },
      })),
      { name: EXPLAIN_TOOL_NAME, input: { goal: "A groove", technique: "Generators" } },
    ];
    const run = async () => {
      const provider = createScriptedAssistantProvider([
        toolUseEvents("A groove.", calls),
      ]);
      const result = await runAssistantTurn(
        {
          provider,
          guards: createInMemoryGuardStores(),
          log: () => {},
          now: () => 1_000,
          idStem: () => STEM,
          tactics: { patternGenerators: "on" },
        },
        { uid: "uid-1", signInProvider: "google.com" },
        {
          projectRevision: project.metadata.revision,
          messages: [{ role: "user", text: "Add a beat and a bass" }],
          context: buildAssistantPayload(project),
        },
        { signal: new AbortController().signal, onChunk: () => {} },
      );
      return { provider, result };
    };
    const { provider, result } = await run();
    const sent = JSON.stringify(provider.requests[0]);
    expect(sent).toContain(JSON.stringify(PATTERN_GENERATORS_LINE).slice(1, -1));
    const created = result.proposal?.calls.filter(
      (entry) => entry.name === "clip_create",
    );
    if (!created || created.length !== 2)
      throw new Error("expected two clip_create calls");
    const [drums, bass] = created.map(eventsOf);
    // 8 kicks and 10 Euclidean hits over two bars; 3 hits a bar over four, varied.
    expect(drums).toHaveLength(8 + 10);
    expect(bass.length).toBeGreaterThan(0);
    expect([...drums, ...bass].map((event) => event.id)).toEqual(
      [...drums, ...bass].map((_, index) => gatewayNoteId(STEM, index + 1)),
    );
    expect(JSON.stringify(result.proposal)).not.toContain("generator");
    const validation = validateProposal(project, result.proposal);
    expect(validation.ok ? null : validation.issues).toBeNull();
    // The same turn again writes exactly the same notes.
    expect((await run()).result.proposal).toEqual(result.proposal);
  });
});
