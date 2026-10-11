import { describe, expect, it } from "vitest";
import {
  ASK_LIMITS,
  ASK_PRODUCER_TOOL_NAME,
  type AssistantAsk,
  answerIsEmpty,
  answerMessage,
  askProducerInputSchema,
  askProducerTool,
  askTranscript,
  isAskCall,
  parseAskCall,
  parseAssistantAsk,
  pickedLabels,
} from "./ask";
import { providerTools } from "./providerRequest";
import { assistantTools } from "./tools";

const INPUT = {
  question: "Where should the drop land?",
  context: "The build, bars 13-16",
  options: [
    { label: "Bar 17", description: "Right after the build" },
    { label: "Bar 25" },
    { label: "Hold it back" },
  ],
  suggested: 1,
  multiSelect: false,
};

const ASK: AssistantAsk = { id: "toolu_1", ...INPUT };

describe("the ask_producer tool (GRV-42)", () => {
  it("is offered in the wire shape, under a name no command tool has", () => {
    const [wire] = providerTools([askProducerTool()]);
    expect(wire.name).toBe(ASK_PRODUCER_TOOL_NAME);
    expect(wire.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(wire.input_schema.type).toBe("object");
    expect(wire.input_schema.required).toEqual(["question", "options"]);
    expect(assistantTools().map((tool) => tool.name)).not.toContain(wire.name);
  });

  it("round-trips: what the model sends comes back from the wire unchanged", () => {
    const parsed = parseAskCall({
      id: "toolu_1",
      name: ASK_PRODUCER_TOOL_NAME,
      input: INPUT,
    });
    expect(parsed).toEqual(ASK);
    // Through JSON and the browser's parse, as the gateway's result travels.
    expect(parseAssistantAsk(JSON.parse(JSON.stringify(parsed)))).toEqual(ASK);
  });

  it("defaults to a single pick and leaves out what the model did not send", () => {
    const ask = parseAskCall({
      id: "toolu_2",
      name: ASK_PRODUCER_TOOL_NAME,
      input: { question: "Up or down?", options: [{ label: "Up" }, { label: "Down" }] },
    });
    expect(ask).toEqual({
      id: "toolu_2",
      question: "Up or down?",
      options: [{ label: "Up" }, { label: "Down" }],
      multiSelect: false,
    });
    expect(parseAssistantAsk(JSON.parse(JSON.stringify(ask)))).toEqual(ask);
  });

  it("trims what it is given", () => {
    const parsed = askProducerInputSchema.parse({
      question: "  Which?  ",
      options: [{ label: " A " }, { label: "B" }],
    });
    expect(parsed.question).toBe("Which?");
    expect(parsed.options[0]?.label).toBe("A");
  });

  it.each([
    ["no options", { ...INPUT, options: [] }],
    ["one option", { ...INPUT, options: [{ label: "A" }] }],
    [
      "more than eight options",
      { ...INPUT, options: Array.from({ length: 9 }, (_, i) => ({ label: `${i}` })) },
    ],
    ["an empty question", { ...INPUT, question: "   " }],
    ["a long question", { ...INPUT, question: "x".repeat(ASK_LIMITS.questionChars + 1) }],
    ["a long label", { ...INPUT, options: [{ label: "x".repeat(61) }, { label: "B" }] }],
    ["a suggestion past the options", { ...INPUT, suggested: 3 }],
    ["a negative suggestion", { ...INPUT, suggested: -1 }],
    [
      "two options with one label",
      { ...INPUT, options: [{ label: "A" }, { label: "a" }] },
    ],
    ["a field the tool does not take", { ...INPUT, remember: true }],
  ])("refuses %s", (_name, input) => {
    expect(askProducerInputSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["no options", { ...INPUT, options: [] }],
    ["one option", { ...INPUT, options: [{ label: "A" }] }],
    ["an empty question", { ...INPUT, question: "   " }],
    ["a long question", { ...INPUT, question: "x".repeat(ASK_LIMITS.questionChars + 1) }],
    [
      "one usable option left once a long label is dropped",
      { ...INPUT, options: [{ label: "x".repeat(61) }, { label: "B" }] },
    ],
    [
      "one usable option left once a repeated label is dropped",
      { ...INPUT, options: [{ label: "A" }, { label: "a" }] },
    ],
    ["input that is not an object", '{"question": "Which'],
  ])("finds no question in a call with %s", (_name, input) => {
    expect(parseAskCall({ id: "t", name: ASK_PRODUCER_TOOL_NAME, input })).toBeNull();
  });

  it("refuses a wire ask with no ID", () => {
    expect(parseAssistantAsk(INPUT)).toBeNull();
    expect(parseAssistantAsk(null)).toBeNull();
  });

  it("knows its own calls from the proposal tools'", () => {
    expect(isAskCall({ name: ASK_PRODUCER_TOOL_NAME })).toBe(true);
    expect(isAskCall({ name: "parameter_set" })).toBe(false);
  });
});

describe("an ask in the conversation's text", () => {
  it("is resent with the reply as a transcript the model can read back", () => {
    expect(askTranscript(ASK)).toBe(
      "[I asked the producer (ask_producer, pick one): Where should the drop land? About: The build, bars 13-16. Options: 1. Bar 17 (Right after the build); 2. Bar 25 [suggested]; 3. Hold it back.]",
    );
    expect(askTranscript({ ...ASK, multiSelect: true })).toContain("pick any number");
  });

  it("answers with the labels picked, in the ask's order", () => {
    const answer = { picked: [2, 0], text: "" };
    expect(pickedLabels(ASK, answer)).toEqual(["Bar 17", "Hold it back"]);
    expect(answerMessage(ASK, answer)).toBe(
      '[Answer to "Where should the drop land?"] Picked: Bar 17, Hold it back.',
    );
  });

  it("answers with the typed text alone, or with both", () => {
    expect(answerMessage(ASK, { picked: [], text: "  Bar 21  " })).toBe(
      '[Answer to "Where should the drop land?"] Bar 21',
    );
    expect(answerMessage(ASK, { picked: [1], text: "but shorter" })).toBe(
      '[Answer to "Where should the drop land?"] Picked: Bar 25. Also: but shorter',
    );
  });

  it("says when an answer is empty", () => {
    expect(answerIsEmpty({ picked: [], text: "  " })).toBe(true);
    expect(answerIsEmpty({ picked: [0], text: "" })).toBe(false);
  });
});

describe("options that carry more than words (GRV-42)", () => {
  const RICH = {
    question: "What should change first?",
    options: [
      {
        label: "The bass",
        ref: { kind: "track", trackId: "trk_bass" },
        sound: { kind: "track", trackId: "trk_bass" },
      },
      { label: "The build", ref: { kind: "bars", startBar: 13, endBar: 16 } },
      { label: "That clip", ref: { kind: "clip", clipId: "clp_1" } },
      {
        label: "Slower",
        sound: {
          kind: "preview",
          calls: [{ name: "parameter_set", input: { value: 100 } }],
        },
        doneWhen: { kind: "tempo", max: 100 },
      },
      { label: "Swing it", doneWhen: { kind: "swing", min: 55, max: 62 } },
    ],
    multiSelect: false,
  };

  it("round-trips references, sounds and predicates", () => {
    const ask = parseAskCall({
      id: "toolu_9",
      name: ASK_PRODUCER_TOOL_NAME,
      input: RICH,
    });
    expect(ask).toEqual({ id: "toolu_9", ...RICH });
    expect(parseAssistantAsk(JSON.parse(JSON.stringify(ask)))).toEqual(ask);
  });

  it("offers them in the tool's schema", () => {
    const schema = JSON.stringify(askProducerTool().inputSchema);
    for (const word of [
      "ref",
      "sound",
      "doneWhen",
      "trackAdded",
      "swing",
      "preview",
      "startBar",
    ]) {
      expect(schema).toContain(word);
    }
  });

  it.each([
    [
      "a bar range that ends before it starts",
      { kind: "bars", startBar: 9, endBar: 4 },
      "ref",
    ],
    ["bar 0", { kind: "bars", startBar: 0, endBar: 4 }, "ref"],
    ["a reference of no known kind", { kind: "section", sectionId: "sec_1" }, "ref"],
    ["a range with no bounds", { kind: "tempo" }, "doneWhen"],
    [
      "a range upside down",
      { kind: "trackVolume", trackId: "t", min: -3, max: -9 },
      "doneWhen",
    ],
    ["a swing range with no bounds", { kind: "swing" }, "doneWhen"],
    ["a swing range upside down", { kind: "swing", min: 66, max: 58 }, "doneWhen"],
    ["a predicate of no known kind", { kind: "keyChanged" }, "doneWhen"],
    ["a preview with no changes", { kind: "preview", calls: [] }, "sound"],
    [
      "a preview with too many changes",
      {
        kind: "preview",
        calls: Array.from({ length: 21 }, () => ({ name: "parameter_set", input: {} })),
      },
      "sound",
    ],
  ])("refuses %s", (_name, value, field) => {
    const input = {
      ...INPUT,
      options: [{ label: "A", [field]: value }, { label: "B" }],
    };
    expect(askProducerInputSchema.safeParse(input).success).toBe(false);
  });

  // Production QA (GRV-42): one slip in an option's extras threw the whole
  // question away as "Its reply came back broken".
  it("keeps the question, and the option, when one of its extras does not validate", () => {
    const ask = parseAskCall({
      id: "toolu_3",
      name: ASK_PRODUCER_TOOL_NAME,
      input: {
        question: "Which groove?",
        options: [
          {
            label: "Boom bap",
            description: "x".repeat(ASK_LIMITS.descriptionChars + 1),
            ref: { kind: "bars", startBar: 9, endBar: 4 },
            sound: {
              kind: "preview",
              calls: Array.from({ length: ASK_LIMITS.previewCalls + 1 }, () => ({
                name: "parameter_set",
                input: {},
              })),
            },
            doneWhen: { kind: "tempo" },
            colour: "gold",
          },
          { label: "Trap", ref: { kind: "track", trackId: "trk_drums" } },
        ],
      },
    });
    expect(ask).toEqual({
      id: "toolu_3",
      question: "Which groove?",
      options: [
        { label: "Boom bap" },
        { label: "Trap", ref: { kind: "track", trackId: "trk_drums" } },
      ],
      multiSelect: false,
    });
    expect(parseAssistantAsk(JSON.parse(JSON.stringify(ask)))).toEqual(ask);
  });

  it("drops an unusable or repeated option and keeps the suggestion on its option", () => {
    const ask = parseAskCall({
      id: "toolu_4",
      name: ASK_PRODUCER_TOOL_NAME,
      input: {
        question: "Which groove?",
        context: "x".repeat(ASK_LIMITS.contextChars + 1),
        options: [
          { label: "" },
          { label: "Boom bap" },
          { label: "boom bap" },
          "Trap",
          { label: "Trap" },
          ...Array.from({ length: 9 }, (_, i) => ({ label: `Extra ${i}` })),
        ],
        suggested: 4,
        multiSelect: "yes",
        remember: true,
      },
    });
    expect(ask?.context).toBeUndefined();
    expect(ask?.multiSelect).toBe(false);
    expect(ask?.options.map((option) => option.label)).toEqual([
      "Boom bap",
      "Trap",
      ...Array.from({ length: ASK_LIMITS.maxOptions - 2 }, (_, i) => `Extra ${i}`),
    ]);
    expect(ask?.suggested).toBe(1);
  });

  it("leaves out a suggestion that pointed at nothing, or at an option it dropped", () => {
    const parse = (suggested: number) =>
      parseAskCall({
        id: "t",
        name: ASK_PRODUCER_TOOL_NAME,
        input: {
          question: "Which?",
          options: [{ label: "A" }, { label: "" }, { label: "B" }],
          suggested,
        },
      });
    expect(parse(1)?.suggested).toBeUndefined();
    expect(parse(7)?.suggested).toBeUndefined();
    expect(parse(-1)?.suggested).toBeUndefined();
    expect(parse(2)?.suggested).toBe(1);
  });

  it("names them in the transcript the model reads back", () => {
    const ask = parseAskCall({
      id: "toolu_9",
      name: ASK_PRODUCER_TOOL_NAME,
      input: RICH,
    });
    if (!ask) throw new Error("the rich ask did not parse");
    const transcript = askTranscript(ask);
    expect(transcript).toContain("1. The bass <track trk_bass> [audible]");
    expect(transcript).toContain("2. The build <bars 13-16>");
    expect(transcript).toContain("3. That clip <clip clp_1>");
    expect(transcript).toContain("4. Slower [audible] [answered by doing it]");
  });

  it("says an answer made in the editor was done there", () => {
    expect(answerMessage(ASK, { picked: [0], text: "", byDoing: true })).toBe(
      '[Answer to "Where should the drop land?"] Did it in the editor: Bar 17.',
    );
  });
});
