/**
 * What Cue remembers about the producer, as a turn carries it, and the one
 * tool that proposes adding to it (GRV-25).
 *
 * **Reading.** A turn may carry the producer's memory (their onboarding
 * answers and the notes they confirmed, `src/persistence/profileDocuments.ts`)
 * beside the project. The system prompt puts it in front of the model before
 * every reply and asks it to say so when it uses it. It is the producer's own
 * words about themselves, sent only to the provider that answers them; it is
 * never in a project and never in analytics.
 *
 * **Writing.** Memory is never written silently. `remember_producer` proposes
 * one thing to remember, a note in the producer's words or a new value for
 * one of the six fields; the gateway passes the call back among the turn's
 * calls (as it does `recommend_sounds`), the panel takes it out
 * ({@link splitMemoryProposals}) and shows it as a card, and only the
 * producer's confirmation saves it, with a receipt and Undo.
 *
 * **Asking later.** A question the producer skipped in onboarding may be
 * named in `askLater`. The model may ask it once, when the conversation makes
 * it relevant, with `ask_producer` and its `memoryQuestion`, which tells the
 * browser it has been asked.
 *
 * Firebase-free and SDK-free, like the rest of `src/assistant`.
 */
import { z } from "zod";
import {
  EXPERIENCE_LEVELS,
  MAX_ARTISTS_CHARS,
  MAX_MEMORY_ITEM_CHARS,
  MAX_MEMORY_LIST,
  MAX_MEMORY_NOTES,
  MAX_NOTE_CHARS,
  MEMORY_FIELDS,
  ONBOARDING_QUESTION_IDS,
  PRODUCER_GOALS,
} from "../persistence/profileDocuments";
import type { AssistantProposal, AssistantToolCall } from "./protocol";
import { makesChanges } from "./tools";

/** The tool's name, as the model calls it. */
export const REMEMBER_TOOL_NAME = "remember_producer";

const item = z.string().max(MAX_MEMORY_ITEM_CHARS);
const list = z.array(item).max(MAX_MEMORY_LIST);

/** The producer's memory, as a turn carries it. */
export const assistantMemoryContextSchema = z.strictObject({
  taste: list,
  artists: z.string().max(MAX_ARTISTS_CHARS),
  experience: z.enum(EXPERIENCE_LEVELS).nullable(),
  goal: z.enum(PRODUCER_GOALS).nullable(),
  learn: list,
  gear: list,
  notes: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        text: z.string().min(1).max(MAX_NOTE_CHARS),
      }),
    )
    .max(MAX_MEMORY_NOTES),
  /** One question skipped in onboarding that may be asked now, or null. */
  askLater: z.enum(ONBOARDING_QUESTION_IDS).nullable(),
});
export type AssistantMemoryContext = z.infer<typeof assistantMemoryContextSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * What `remember_producer` takes: a note, or a field and its new value. One
 * flat object rather than a union, because a tool's input must be an object
 * at the top.
 */
export const rememberInputSchema = z
  .strictObject({
    kind: z
      .enum(["note", "field"])
      .describe('"note" to remember a note, "field" to set one of memory\'s fields.'),
    text: text(MAX_NOTE_CHARS)
      .optional()
      .describe(
        'For a note: one lasting thing about the producer, short and in their words, such as "Making more trap lately".',
      ),
    field: z.enum(MEMORY_FIELDS).optional().describe("For a field: which one."),
    value: text(MAX_ARTISTS_CHARS)
      .optional()
      .describe(
        `For a field: its new value. taste, learn and gear: a comma-separated list. experience: one of ${EXPERIENCE_LEVELS.join(", ")}. goal: one of ${PRODUCER_GOALS.join(", ")}.`,
      ),
  })
  .superRefine((input, issues) => {
    if (input.kind === "note" && input.text === undefined) {
      issues.addIssue({
        code: "custom",
        path: ["text"],
        message: "a note needs its text",
      });
    }
    if (
      input.kind === "field" &&
      (input.field === undefined || input.value === undefined)
    ) {
      issues.addIssue({
        code: "custom",
        path: ["field"],
        message: "a field needs its name and its value",
      });
    }
  });
export type RememberInput = z.infer<typeof rememberInputSchema>;

/** One proposed change to memory, checked and ready to show. */
export type MemoryProposal =
  | { readonly kind: "note"; readonly text: string }
  | {
      readonly kind: "field";
      readonly field: "taste" | "learn" | "gear";
      readonly value: readonly string[];
    }
  | { readonly kind: "field"; readonly field: "artists"; readonly value: string }
  | {
      readonly kind: "field";
      readonly field: "experience";
      readonly value: (typeof EXPERIENCE_LEVELS)[number];
    }
  | {
      readonly kind: "field";
      readonly field: "goal";
      readonly value: (typeof PRODUCER_GOALS)[number];
    };

/** A comma-separated value as list entries, each within bounds. */
function listValue(value: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const part of value.split(",")) {
    const entry = part.trim().slice(0, MAX_MEMORY_ITEM_CHARS);
    if (!entry || seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    items.push(entry);
  }
  return items.slice(0, MAX_MEMORY_LIST);
}

/** The call as a memory proposal, or null when it is not a valid one. */
export function parseRememberCall(call: AssistantToolCall): MemoryProposal | null {
  const parsed = rememberInputSchema.safeParse(call.input);
  if (!parsed.success) return null;
  const input = parsed.data;
  if (input.kind === "note")
    return input.text ? { kind: "note", text: input.text } : null;
  if (input.value === undefined) return null;
  switch (input.field) {
    case "taste":
    case "learn":
    case "gear": {
      const value = listValue(input.value);
      return value.length > 0 ? { kind: "field", field: input.field, value } : null;
    }
    case "artists":
      return { kind: "field", field: "artists", value: input.value };
    case "experience": {
      const level = z.enum(EXPERIENCE_LEVELS).safeParse(input.value);
      return level.success
        ? { kind: "field", field: "experience", value: level.data }
        : null;
    }
    case "goal": {
      const goal = z.enum(PRODUCER_GOALS).safeParse(input.value);
      return goal.success ? { kind: "field", field: "goal", value: goal.data } : null;
    }
    default:
      return null;
  }
}

/** Whether a call proposes a memory change rather than a change to the song. */
export function isRememberCall(call: Pick<AssistantToolCall, "name">): boolean {
  return call.name === REMEMBER_TOOL_NAME;
}

/**
 * The proposal's song changes, with its memory proposals taken out: each is
 * a card of its own, and the changes, if any are left, are one. An
 * explanation left with no change beside it is no proposal.
 */
export function splitMemoryProposals(proposal: AssistantProposal): {
  readonly proposal: AssistantProposal | null;
  readonly memory: readonly AssistantToolCall[];
} {
  const memory = proposal.calls.filter(isRememberCall);
  const changes = proposal.calls.filter((call) => !isRememberCall(call));
  return {
    proposal: makesChanges(changes) ? { ...proposal, calls: changes } : null,
    memory,
  };
}

const TOOL_DESCRIPTION =
  'Propose remembering one lasting thing about the producer: a short note in their words (kind "note"), or a new value for one of their memory\'s fields (kind "field"). Use it when they tell you something about themselves that will still matter in another session (what they make, their setup, how they like to work), never for something about the song, and never for what memory already holds. Nothing is saved unless they confirm. Say in your reply what you are proposing to remember.';

/** The tool as the model is offered it. */
export interface RememberToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

let toolCache: RememberToolDefinition | null = null;

/** `remember_producer`, its input schema generated from {@link rememberInputSchema}. */
export function rememberTool(): RememberToolDefinition {
  if (!toolCache) {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(rememberInputSchema, {
      io: "input",
    }) as Record<string, unknown>;
    toolCache = {
      name: REMEMBER_TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema,
    };
  }
  return toolCache;
}
