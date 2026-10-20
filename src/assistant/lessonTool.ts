/**
 * The one tool that starts a lesson (GRV-43). A turn that carries the
 * producer's memory is offered `start_lesson`: when they ask to learn
 * something a chapter teaches, the model names the chapter. The gateway
 * passes the call back among the turn's calls (as it does
 * `remember_producer`), and the panel takes it out ({@link splitLessonCalls})
 * and starts the lesson.
 *
 * Firebase-free and SDK-free, like the rest of `src/assistant`.
 */
import { z } from "zod";
import { CHAPTER_IDS, type ChapterId } from "../lessons/ids";
import type { AssistantProposal, AssistantToolCall } from "./protocol";
import { makesChanges } from "./tools";

/** The tool's name, as the model calls it. */
export const START_LESSON_TOOL_NAME = "start_lesson";

/** What `start_lesson` takes. */
export const startLessonInputSchema = z.strictObject({
  chapter: z
    .enum(CHAPTER_IDS)
    .describe(
      'Which chapter: "beat" (Make a beat: kick, backbeat, hats, a loop), "sound" (Shape a sound: a synth\'s wave, filter and envelope into a pluck) or "tour" (Tour the studio: the five views).',
    ),
});

const TOOL_DESCRIPTION =
  "Start a lesson in the producer's own project, when they ask to learn or be taught something one of its chapters covers (making a beat or drums; shaping a synth sound; finding their way around Groove). The lesson appears in the panel, one bite at a time, and each bite comes back to you to teach. Call it alone, with one short sentence before it, and only when they asked for a lesson or to learn: never in the middle of building something. Saying you will start one starts nothing: only the call puts the lesson on screen, so call it every time they ask, even for a chapter they have finished or one the conversation went through before. For anything no chapter covers, teach it in the conversation instead.";

/** The tool as the model is offered it. */
export interface StartLessonToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

let toolCache: StartLessonToolDefinition | null = null;

/** `start_lesson`, its input schema generated from {@link startLessonInputSchema}. */
export function startLessonTool(): StartLessonToolDefinition {
  if (!toolCache) {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(startLessonInputSchema, {
      io: "input",
    }) as Record<string, unknown>;
    toolCache = {
      name: START_LESSON_TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema,
    };
  }
  return toolCache;
}

/** Whether a call starts a lesson rather than changing the song. */
export function isLessonCall(call: Pick<AssistantToolCall, "name">): boolean {
  return call.name === START_LESSON_TOOL_NAME;
}

/** The chapter a call starts, or null when it is not a valid one. */
export function parseLessonCall(call: AssistantToolCall): ChapterId | null {
  const parsed = startLessonInputSchema.safeParse(call.input);
  return parsed.success ? parsed.data.chapter : null;
}

/**
 * The proposal's song changes, with its lesson calls taken out. An
 * explanation left with no change beside it is no proposal.
 */
export function splitLessonCalls(proposal: AssistantProposal): {
  readonly proposal: AssistantProposal | null;
  readonly lessons: readonly AssistantToolCall[];
} {
  const lessons = proposal.calls.filter(isLessonCall);
  const changes = proposal.calls.filter((call) => !isLessonCall(call));
  return {
    proposal: makesChanges(changes) ? { ...proposal, calls: changes } : null,
    lessons,
  };
}
