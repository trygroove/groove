/**
 * Lessons, as a turn carries them (GRV-43), and the one tool that starts one.
 *
 * **During a lesson** every turn carries a {@link AssistantLessonContext}:
 * the chapter and bite under way, the step in plain words, what just
 * happened (a bite started, a step or bite finished, the chapter over) and
 * how, what the producer changed, the beat style, the bite's quiz and what
 * comes next. The browser builds it from the lessons (`src/lessons/cue.ts`);
 * the system blocks put it in front of the model with {@link LESSON_RULES},
 * so Coproducer writes the words a lesson needs: the step explained, a
 * comment on what the producer did, a celebration in words, perhaps a quiz
 * question, and a wrap-up with pointers. A turn that had to wait for a reply
 * to finish carries the moments it waited with in `earlier`, so none of
 * them goes unanswered. Every field is ours, except the
 * track and pad names in `changes`, which the project context already sends.
 *
 * **Starting one** is `start_lesson`, in `lessonTool.ts`: this module stays
 * free of the tools, since the prompt and the protocol read it.
 *
 * Firebase-free and SDK-free, like the rest of `src/assistant`.
 */
import { z } from "zod";
import { MAX_CHANGE_LINE_LENGTH } from "../lessons/changes";
import {
  BEAT_STYLES,
  BITE_ENDINGS,
  BITE_IDS,
  CHAPTER_IDS,
  LESSON_MOMENTS,
  MAX_EARLIER,
} from "../lessons/ids";

const title = z.string().min(1).max(80);
const line = z.string().max(400);

/** A lesson under way, as a turn carries it. */
export const assistantLessonContextSchema = z.strictObject({
  chapterId: z.enum(CHAPTER_IDS),
  chapter: title,
  biteId: z.enum(BITE_IDS),
  bite: title,
  skill: line,
  biteNumber: z.int().min(1).max(50),
  biteCount: z.int().min(1).max(50),
  moment: z.enum(LESSON_MOMENTS),
  how: z.enum(BITE_ENDINGS).nullable(),
  step: line.nullable(),
  // `describeChanges` keeps each line to this, so no diff makes a turn the
  // gateway refuses.
  changes: z.array(z.string().max(MAX_CHANGE_LINE_LENGTH)).max(12),
  style: z.enum(BEAT_STYLES).nullable(),
  quiz: line.nullable(),
  next: z.array(line).max(5),
  // "Finish a track" (GRV-44): its chapters follow one another.
  track: z
    .strictObject({
      title,
      chapterNumber: z.int().min(1).max(20),
      chapterCount: z.int().min(1).max(20),
    })
    .nullable(),
  passed: z.array(title).max(50),
  earlier: z
    .array(
      z.strictObject({
        moment: z.enum(LESSON_MOMENTS),
        chapter: title,
        bite: title,
        how: z.enum(BITE_ENDINGS).nullable(),
        changes: z.array(z.string().max(MAX_CHANGE_LINE_LENGTH)).max(12),
      }),
    )
    .max(MAX_EARLIER),
});
export type AssistantLessonContext = z.infer<typeof assistantLessonContextSchema>;

/** What introduces a lesson in the system blocks. */
export const LESSON_BLOCK_HEADING = "The lesson under way, as JSON:\n";

/**
 * How Coproducer teaches a lesson: read with the lesson's block, so a turn
 * outside one pays nothing for it.
 */
export const LESSON_RULES = `## Teaching a lesson

You are teaching the producer one bite of a lesson, in their own project, and the block below says where it stands. The lesson card on screen already shows the step's instruction, Show me and Skip, so never repeat the instruction word for word and never write out a list of the bites. Name only the bites and chapters the block names ("bite", "next", "earlier"), never one of your own: the card lists the chapter's bites, and a bite it does not show confuses the producer. Keep every reply to two to four short sentences, and change nothing in the song yourself: no tool calls that change it during a lesson unless the producer asks for a change in their own words.

- "bite_started": if "passed" is not empty, first say in a few words that the song already has those, so the lesson skips them. Then introduce the skill in a sentence or two, with an example from an artist memory names when it names any, and say what to listen for. Fit it to memory's experience: someone who has made little gets a plain definition, someone who releases music gets a comparison to what they already know, not a definition.
- "step_done": say something specific about what they did, as "changes" lists it (a ghost note, a different sound, a step off the pattern), never generic praise; then point them at the next step, which "step" holds.
- "bite_done": celebrate in words only, specific to what they made, as "changes" lists it: no emoji, no points, no exclamation-mark chains. If "how" is "show_me", say what Show me did so they could do it themselves next time; if "skipped", say that's fine and what the bite was for. Then you may ask "quiz" as one question with ask_producer, two to four short options, the right one among them, and say nothing after it; ask it at most once, and not every time. Otherwise end by naming the next bite in "next" and saying they can go on when they want.
- "chapter_done": a wrap-up. Congratulate them on what the chapter made, specific to their project as the description and "changes" show it now, and offer two or three of "next" as pointers, in a sentence each. No question, no quiz. When "track" is set, the chapter is one of a longer lesson: name the next chapter in "next" as where it goes on, and say the card will start it when they are ready.
- "track_done": the end of "Finish a track", the longest lesson: they made a whole track and exported its stems. Congratulate them on the finished track, specific to it as the description shows it (its parts, its sections, its mix), in words only, then offer "next" as pointers in a sentence each. No question, no quiz.
- "under_way": they wrote to you mid-lesson. Answer them, in the lesson's terms when it is about the step.
- "earlier", when it is not empty, is what happened while your last reply was still being written, oldest first, each with its own moment, "how" and "changes". Answer it before the moment above, in a sentence each and in the same reply: a finished bite still gets its specific celebration (but no quiz), a finished step its specific comment, a finished chapter its congratulations. Then do what the moment above asks.
- "track", when set, is "Finish a track": the producer is making a whole track with you, five chapters from a beat to stems, and this is chapter "chapterNumber" of "chapterCount". Keep the whole track in mind: say how this bite fits the song they are building. The reply may run a sentence or two longer for it.`;

/** The lesson's system block: the rules, then the lesson. */
export function lessonBlock(lesson: AssistantLessonContext): string {
  return `${LESSON_RULES}\n\n${LESSON_BLOCK_HEADING}${JSON.stringify(lesson)}`;
}
