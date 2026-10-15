/**
 * The assistant's one non-command tool (GRV-42): `ask_producer`, a question
 * with options, the way an agent harness asks its operator.
 *
 * The model calls it like any tool, beside the proposal tools in `tools.ts`,
 * but it changes nothing: the gateway takes the call out of the turn's tool
 * calls and returns it as the turn's {@link AssistantAsk}, and the panel shows
 * it above the composer until the producer answers or dismisses it. The
 * answer is the next turn's user message ({@link answerMessage}).
 *
 * The provider is stateless and the conversation is resent as plain text
 * (`history.ts`), so the question itself travels in that text too: the
 * assistant's turn is resent with {@link askTranscript} after its reply, and
 * the model reads its own question back beside the answer.
 *
 * An option can carry more than words: a part of the song it is about
 * ({@link AskReference}: a track, a clip or a bar range, which the editor
 * highlights while the option is hovered and selects when it is picked), a
 * sound to hear ({@link AskSound}: a track's instrument, or a preview of
 * changes the assistant could make), and a predicate on the project
 * ({@link AskPredicate}) that answers the question as that option when the
 * producer makes the change in the editor instead of picking.
 *
 * The tool never writes memory. An answer reaches memory only when the
 * assistant then proposes a memory note from it (GRV-25).
 *
 * Like the rest of `src/assistant`, Firebase-free and SDK-free.
 */
import { z } from "zod";
import { trackTypeSchema } from "../domain/entities";
import { ONBOARDING_QUESTION_IDS } from "../persistence/profileDocuments";
import type { AssistantToolCall } from "./protocol";

/** The tool's name, as the model calls it. */
export const ASK_PRODUCER_TOOL_NAME = "ask_producer";

/** How much one ask may say. */
export const ASK_LIMITS = {
  minOptions: 2,
  maxOptions: 8,
  questionChars: 300,
  contextChars: 120,
  labelChars: 60,
  descriptionChars: 120,
  /** The "something else" box. */
  answerChars: 1000,
  /** The most changes one option's preview may carry. */
  previewCalls: 20,
  /** The highest bar a bar range may name. */
  maxBar: 9999,
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const entityId = z.string().min(1).max(64);
const bar = z.int().min(1).max(ASK_LIMITS.maxBar);
const BPM = z.number().min(1).max(999);
const DECIBELS = z.number().min(-60).max(6);
const PERCENT = z.number().min(0).max(100);

/** A part of the song an option is about. */
export const askReferenceSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("track"), trackId: entityId }),
    z.strictObject({ kind: z.literal("clip"), clipId: entityId }),
    z.strictObject({
      kind: z.literal("bars"),
      startBar: bar.describe("The first bar, counting from 1."),
      endBar: bar.describe("The last bar, inclusive."),
    }),
  ])
  .refine((ref) => ref.kind !== "bars" || ref.endBar >= ref.startBar, {
    message: "endBar must be at or after startBar",
  })
  .describe(
    "The track, clip or bars the option is about: highlighted in the editor while the producer hovers it, and selected when they pick it.",
  );
export type AskReference = z.infer<typeof askReferenceSchema>;

/** One change in an option's preview, exactly as a change tool is called. */
const previewCallSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("One of your change tools, such as parameter_set."),
  input: z.record(z.string(), z.unknown()).describe("Its input, as you would call it."),
});

/** Something an option lets the producer hear before picking it. */
export const askSoundSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("track"), trackId: entityId }),
    z.strictObject({
      kind: z.literal("preview"),
      calls: z.array(previewCallSchema).min(1).max(ASK_LIMITS.previewCalls),
    }),
  ])
  .describe(
    'What the producer hears while hovering the option: a track\'s instrument ("track"), or the song with changes you could make ("preview", the same calls as a proposal; nothing is applied).',
  );
export type AskSound = z.infer<typeof askSoundSchema>;

/**
 * A change in the editor that answers the question as the option. Each holds
 * once the project has moved from where it was when the question was asked:
 * a value (tempo, swing, a fader) into its range, a track or a device more
 * than there were.
 */
export const askPredicateSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("tempo"),
      min: BPM.optional(),
      max: BPM.optional(),
    }),
    z
      .strictObject({
        kind: z.literal("swing"),
        min: PERCENT.optional(),
        max: PERCENT.optional(),
      })
      .describe("The song's swing, in percent: 50 is straight, 75 the most."),
    z.strictObject({
      kind: z.literal("trackAdded"),
      trackType: trackTypeSchema.optional(),
      instrumentKind: z.enum(["sampler", "synth", "drumMachine"]).optional(),
    }),
    z.strictObject({ kind: z.literal("trackRemoved"), trackId: entityId }),
    z.strictObject({
      kind: z.literal("trackFlag"),
      trackId: entityId,
      flag: z.enum(["muted", "soloed"]),
      value: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal("trackVolume"),
      trackId: entityId,
      min: DECIBELS.optional(),
      max: DECIBELS.optional(),
    }),
    z.strictObject({
      kind: z.literal("deviceAdded"),
      trackId: entityId.optional(),
      deviceType: z.string().min(1).max(64).optional(),
    }),
  ])
  .superRefine((predicate, issues) => {
    if (
      predicate.kind !== "tempo" &&
      predicate.kind !== "swing" &&
      predicate.kind !== "trackVolume"
    ) {
      return;
    }
    const { min, max } = predicate;
    if (min === undefined && max === undefined) {
      issues.addIssue({ code: "custom", message: "a range needs a min, a max or both" });
    } else if (min !== undefined && max !== undefined && min > max) {
      issues.addIssue({ code: "custom", message: "min must be at or below max" });
    }
  })
  .describe(
    "A change the producer can make in the editor instead of picking: when it happens, the question is answered as this option.",
  );
export type AskPredicate = z.infer<typeof askPredicateSchema>;

export const askOptionSchema = z.strictObject({
  label: text(ASK_LIMITS.labelChars).describe("What the producer picks, in a few words."),
  description: text(ASK_LIMITS.descriptionChars)
    .optional()
    .describe("One line on what picking it means, when the label is not enough."),
  ref: askReferenceSchema.optional(),
  sound: askSoundSchema.optional(),
  doneWhen: askPredicateSchema.optional(),
});
export type AskOption = z.infer<typeof askOptionSchema>;

const askInputShape = {
  question: text(ASK_LIMITS.questionChars).describe(
    "The question, short and in the producer's terms.",
  ),
  context: text(ASK_LIMITS.contextChars)
    .optional()
    .describe(
      'What the question is about, as a header line, such as "The build, bars 13-16".',
    ),
  options: z
    .array(askOptionSchema)
    .min(ASK_LIMITS.minOptions)
    .max(ASK_LIMITS.maxOptions)
    .describe("2 to 8 answers to pick from. The producer can always type their own."),
  suggested: z
    .int()
    .min(0)
    .max(ASK_LIMITS.maxOptions - 1)
    .optional()
    .describe("The index of the option you would pick, if you have a view."),
  multiSelect: z
    .boolean()
    .default(false)
    .describe("Whether the producer may pick more than one option."),
  memoryQuestion: z
    .enum(ONBOARDING_QUESTION_IDS)
    .optional()
    .describe(
      'When this is the question memory names in "askLater", its name, so it is not asked again.',
    ),
};

function checkAsk(
  input: { readonly options: readonly AskOption[]; readonly suggested?: number },
  issues: z.RefinementCtx,
): void {
  if (input.suggested !== undefined && input.suggested >= input.options.length) {
    issues.addIssue({
      code: "custom",
      path: ["suggested"],
      message: "suggested must be the index of one of the options",
    });
  }
  const labels = input.options.map((option) => option.label.toLowerCase());
  if (new Set(labels).size !== labels.length) {
    issues.addIssue({
      code: "custom",
      path: ["options"],
      message: "every option needs a different label",
    });
  }
}

/** What the model sends: the tool's input. */
export const askProducerInputSchema = z.strictObject(askInputShape).superRefine(checkAsk);
export type AskProducerInput = z.infer<typeof askProducerInputSchema>;

/** One question the assistant has asked, as the browser receives it. */
export interface AssistantAsk extends AskProducerInput {
  /** The tool call's ID, unique within the conversation. */
  readonly id: string;
}

/** The wire shape of an ask: the call's ID and its validated input. */
export const assistantAskSchema = z
  .strictObject({ ...askInputShape, id: z.string().min(1).max(200) })
  .superRefine(checkAsk);

const TOOL_DESCRIPTION =
  "Ask the producer a question with 2 to 8 options to pick from, when you need their choice to go on: which direction, which part, how far. The producer can always answer in their own words instead. Ask one question at a time, only when the answer changes what you do next, and say nothing after it: their answer is the next message. An option can point at a track, clip or bars (ref), let them hear it first (sound), and be answered by them making the change themselves (doneWhen). This changes nothing in the song.";

/** The tool as the model is offered it. */
export interface AskToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

let toolCache: AskToolDefinition | null = null;

/** `ask_producer`, its input schema generated from {@link askProducerInputSchema}. */
export function askProducerTool(): AskToolDefinition {
  if (!toolCache) {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(askProducerInputSchema, {
      io: "input",
    }) as Record<string, unknown>;
    toolCache = {
      name: ASK_PRODUCER_TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema,
    };
  }
  return toolCache;
}

/** Whether a tool call is an ask rather than a proposed change. */
export function isAskCall(call: Pick<AssistantToolCall, "name">): boolean {
  return call.name === ASK_PRODUCER_TOOL_NAME;
}

/**
 * The call as an ask, or null when its input is not one.
 *
 * Lenient about the parts a question can do without, so one slip does not
 * throw the whole question away (a broken ask is a broken reply): an option's
 * extra (a description, a ref, a sound or a doneWhen) that does not validate
 * is dropped and the option kept; an option with no usable label, a repeated
 * label, or one past the eighth is dropped; a context, a suggestion or a
 * multiSelect that does not validate (or a suggestion whose option was
 * dropped) is left out; an unknown field is ignored. What is left must still
 * be a whole question, with at least two options.
 */
export function parseAskCall(call: AssistantToolCall): AssistantAsk | null {
  const parsed = askProducerInputSchema.safeParse(salvageAskInput(call.input));
  return parsed.success ? { id: call.id, ...parsed.data } : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` when `schema` accepts it, otherwise nothing. */
function validOrNothing<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** One option with its invalid extras dropped, or null when its label is unusable. */
function salvageOption(raw: unknown): AskOption | null {
  if (!isRecord(raw)) return null;
  const label = validOrNothing(text(ASK_LIMITS.labelChars), raw.label);
  if (label === undefined) return null;
  const extras = {
    description: validOrNothing(text(ASK_LIMITS.descriptionChars), raw.description),
    ref: validOrNothing(askReferenceSchema, raw.ref),
    sound: validOrNothing(askSoundSchema, raw.sound),
    doneWhen: validOrNothing(askPredicateSchema, raw.doneWhen),
  };
  const option: Record<string, unknown> = { label };
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) option[key] = value;
  }
  return option as AskOption;
}

/**
 * The tool's input with everything a question can do without, and that does
 * not validate, taken out (see {@link parseAskCall}). Input that is not an
 * object, or has no options list, comes back as it was, for the schema to
 * refuse.
 */
function salvageAskInput(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.options)) return input;
  const options: AskOption[] = [];
  const labels = new Set<string>();
  /** Where each kept option was in the input, so a suggestion still points at it. */
  const from: number[] = [];
  input.options.forEach((raw, index) => {
    if (options.length >= ASK_LIMITS.maxOptions) return;
    const option = salvageOption(raw);
    if (!option || labels.has(option.label.toLowerCase())) return;
    labels.add(option.label.toLowerCase());
    options.push(option);
    from.push(index);
  });
  const suggested =
    typeof input.suggested === "number" ? from.indexOf(input.suggested) : -1;
  const context = validOrNothing(text(ASK_LIMITS.contextChars), input.context);
  const memoryQuestion = validOrNothing(
    z.enum(ONBOARDING_QUESTION_IDS),
    input.memoryQuestion,
  );
  return {
    question: input.question,
    options,
    ...(context === undefined ? {} : { context }),
    ...(memoryQuestion === undefined ? {} : { memoryQuestion }),
    ...(suggested >= 0 ? { suggested } : {}),
    ...(typeof input.multiSelect === "boolean" ? { multiSelect: input.multiSelect } : {}),
  };
}

/** An ask from the wire, or null when it is not one. Never throws. */
export function parseAssistantAsk(raw: unknown): AssistantAsk | null {
  const parsed = assistantAskSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { id, question, context, options, suggested, multiSelect, memoryQuestion } =
    parsed.data;
  return {
    id,
    question,
    options,
    multiSelect,
    ...(context === undefined ? {} : { context }),
    ...(memoryQuestion === undefined ? {} : { memoryQuestion }),
    ...(suggested === undefined ? {} : { suggested }),
  };
}

/**
 * The question, as the conversation resends it after the assistant's reply,
 * so the model sees what it asked when it reads the answer.
 */
export function askTranscript(ask: AssistantAsk): string {
  const options = ask.options
    .map((option, index) => {
      const marks = [
        option.description ? ` (${option.description})` : "",
        option.ref ? ` <${referenceText(option.ref)}>` : "",
        option.sound ? " [audible]" : "",
        option.doneWhen ? " [answered by doing it]" : "",
        index === ask.suggested ? " [suggested]" : "",
      ].join("");
      return `${index + 1}. ${option.label}${marks}`;
    })
    .join("; ");
  const how = ask.multiSelect ? "pick any number" : "pick one";
  const about = ask.context ? ` About: ${ask.context}.` : "";
  return `[I asked the producer (${ASK_PRODUCER_TOOL_NAME}, ${how}): ${ask.question}${about} Options: ${options}.]`;
}

/** A reference as the transcript names it. */
function referenceText(ref: AskReference): string {
  switch (ref.kind) {
    case "track":
      return `track ${ref.trackId}`;
    case "clip":
      return `clip ${ref.clipId}`;
    case "bars":
      return ref.startBar === ref.endBar
        ? `bar ${ref.startBar}`
        : `bars ${ref.startBar}-${ref.endBar}`;
  }
}

/** How the producer answered an ask. */
export interface AskAnswer {
  /** The options picked, by index, in the ask's order. */
  readonly picked: readonly number[];
  /** What they typed in the "something else" box, trimmed; may be empty. */
  readonly text: string;
  /**
   * They made the change in the editor instead (`doneWhen`): `picked` is the
   * one option whose predicate came true.
   */
  readonly byDoing?: boolean;
}

/** Whether `answer` says anything at all. */
export function answerIsEmpty(answer: AskAnswer): boolean {
  return answer.picked.length === 0 && answer.text.trim().length === 0;
}

/** The labels picked, in the ask's order. */
export function pickedLabels(ask: AssistantAsk, answer: AskAnswer): string[] {
  return [...new Set(answer.picked)]
    .filter((index) => index >= 0 && index < ask.options.length)
    .sort((a, b) => a - b)
    .map((index) => ask.options[index]?.label ?? "");
}

/**
 * The answer as the next turn's user message: the labels picked and the
 * typed text, under the question it answers.
 */
export function answerMessage(ask: AssistantAsk, answer: AskAnswer): string {
  const labels = pickedLabels(ask, answer);
  const typed = answer.text.trim().slice(0, ASK_LIMITS.answerChars);
  const parts = [
    labels.length > 0
      ? answer.byDoing
        ? `Did it in the editor: ${labels.join(", ")}.`
        : `Picked: ${labels.join(", ")}.`
      : "",
    typed.length > 0 ? (labels.length > 0 ? `Also: ${typed}` : typed) : "",
  ].filter((part) => part.length > 0);
  return `[Answer to "${ask.question}"] ${parts.join(" ")}`;
}
