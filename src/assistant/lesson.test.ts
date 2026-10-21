import { describe, expect, it } from "vitest";
import { addNotes } from "../commands/definitions/notes";
import { createNoteEvent } from "../domain/factories";
import { TICKS_PER_SIXTEENTH } from "../domain/time";
import { foldTurns, lessonCue } from "../lessons/cue";
import { beatTrack, kickPad } from "../lessons/drums";
import { MAX_EARLIER } from "../lessons/ids";
import { observe, skip, startBite, startTrack } from "../lessons/session";
import { applied, lessonContext, starterWorld } from "../testing/lessonWorld";
import { MINIMAL_ASSISTANT_CONTEXT } from "../testing/scriptedAssistantProvider";
import { lessonReplyText } from "./emulatorProvider";
import {
  type AssistantLessonContext,
  assistantLessonContextSchema,
  LESSON_BLOCK_HEADING,
  LESSON_RULES,
  lessonBlock,
} from "./lesson";
import {
  isLessonCall,
  parseLessonCall,
  START_LESSON_TOOL_NAME,
  splitLessonCalls,
  startLessonTool,
} from "./lessonTool";
import { buildSystemBlocks, MEMORY_BLOCK_HEADING } from "./prompt";
import { ASSISTANT_TOOLSET_VERSION } from "./tools";

const settings = { style: "boom_bap" } as const;

function cue(): AssistantLessonContext {
  const world = starterWorld();
  const { state, event } = startBite("beat", "beat-kick", world, settings);
  return lessonCue(state, event, settings, []);
}

describe("a lesson as a turn carries it (GRV-43)", () => {
  it("takes every cue the lessons build, started or over", () => {
    expect(assistantLessonContextSchema.parse(cue())).toEqual(cue());
    const world = starterWorld();
    const { state } = startBite("tour", "tour-mixer", world, settings);
    const over = skip(state, world, settings);
    if (!over) throw new Error("not skipped");
    const wrapUp = lessonCue(over.state, over.event, settings, []);
    expect(assistantLessonContextSchema.safeParse(wrapUp).success).toBe(true);
  });

  it("takes Finish a track's cues: a chapter in it, passed bites, and its end (GRV-44)", () => {
    const world = starterWorld();
    const started = startTrack("beat", null, world, settings);
    if (!started) throw new Error("not started");
    const first = lessonCue(started.state, started.event, settings, []);
    expect(first.track).toEqual({
      title: "Finish a track",
      chapterNumber: 1,
      chapterCount: 5,
    });
    expect(assistantLessonContextSchema.safeParse(first).success).toBe(true);

    const last = startBite("mix", "mix-export", world, settings);
    const over = observe(
      { ...last.state, track: true },
      { ...world, stemExports: 1 },
      settings,
    );
    if (!over) throw new Error("not over");
    const end = lessonCue(over.state, over.event, settings, []);
    expect(end.moment).toBe("track_done");
    expect(assistantLessonContextSchema.parse(end)).toEqual(end);
    expect(lessonReplyText(end)).toBe(
      'That\'s "Finish a track" finished, stems and all.',
    );
  });

  it("tells Coproducer how to teach Finish a track and to wrap it up", () => {
    expect(LESSON_RULES).toMatch(/"track_done"/);
    expect(LESSON_RULES).toMatch(/"passed"/);
  });

  it("takes the cue of a step that changed a great deal", () => {
    const world = starterWorld();
    const track = beatTrack(world.project);
    const pad = track && kickPad(track);
    const clip = world.project.clips[0];
    if (!track || !pad || !clip) throw new Error("no beat");
    const { state } = startBite("beat", "beat-hats", world, settings);
    const context = lessonContext();
    // 48 hits on one pad, each its own position: a line listing them all ran
    // past what a change line may be.
    const busy = {
      ...world,
      project: applied(world.project, [
        addNotes(
          clip.id,
          Array.from({ length: 48 }, (_, index) =>
            createNoteEvent(context, {
              startTicks: index * (TICKS_PER_SIXTEENTH / 4) + 1,
              durationTicks: TICKS_PER_SIXTEENTH / 4,
              padId: pad.id,
            }),
          ),
        ),
      ]),
    };
    const over = skip(state, busy, settings);
    if (!over) throw new Error("not skipped");
    const lesson = lessonCue(over.state, over.event, settings, []);
    expect(lesson.changes.length).toBeGreaterThan(0);
    expect(assistantLessonContextSchema.safeParse(lesson).success).toBe(true);
  });

  it("takes a cue that carries the moments it waited with", () => {
    const world = starterWorld();
    const started = startBite("beat", "beat-play", world, settings);
    const over = skip(started.state, world, settings);
    if (!over) throw new Error("not skipped");
    const folded = foldTurns([
      { text: "a", cue: lessonCue(over.state, over.event, settings, []) },
      { text: "b", cue: cue() },
    ]).cue;
    expect(folded.earlier).toHaveLength(1);
    expect(assistantLessonContextSchema.parse(folded)).toEqual(folded);
    expect(
      assistantLessonContextSchema.safeParse({
        ...folded,
        earlier: Array.from({ length: MAX_EARLIER + 1 }, () => folded.earlier[0]),
      }).success,
    ).toBe(false);
  });

  it("refuses a field it does not name, or a bite it does not know", () => {
    expect(
      assistantLessonContextSchema.safeParse({ ...cue(), projectId: "prj_x" }).success,
    ).toBe(false);
    expect(
      assistantLessonContextSchema.safeParse({ ...cue(), biteId: "beat-gone" }).success,
    ).toBe(false);
  });

  it("puts the rules and the lesson in one block, after memory and before the ID stem", () => {
    const lesson = cue();
    const memory = {
      taste: ["Hip hop"],
      artists: "",
      experience: null,
      goal: null,
      learn: [],
      gear: [],
      notes: [],
      askLater: null,
    };
    const blocks = buildSystemBlocks(
      MINIMAL_ASSISTANT_CONTEXT,
      undefined,
      "Stem0000000000000",
      memory,
      undefined,
      lesson,
    );
    expect(blocks).toHaveLength(5);
    expect(blocks[2].text.startsWith(MEMORY_BLOCK_HEADING)).toBe(true);
    expect(blocks[3].text).toBe(lessonBlock(lesson));
    expect(blocks[3].text.startsWith(LESSON_RULES)).toBe(true);
    expect(blocks[3].text).toContain(`${LESSON_BLOCK_HEADING}${JSON.stringify(lesson)}`);
    expect(buildSystemBlocks(MINIMAL_ASSISTANT_CONTEXT, undefined, "S")).toHaveLength(3);
  });

  it("tells Coproducer how each moment is taught, and that celebration is words only", () => {
    for (const moment of ["bite_started", "step_done", "bite_done", "chapter_done"]) {
      expect(LESSON_RULES).toContain(`"${moment}"`);
    }
    expect(LESSON_RULES).toContain('"earlier"');
    expect(LESSON_RULES).toMatch(/no emoji/);
    expect(LESSON_RULES).toMatch(/ask_producer/);
  });
});

describe("start_lesson (GRV-43)", () => {
  it("names a chapter, and nothing else", () => {
    const tool = startLessonTool();
    expect(tool.name).toBe(START_LESSON_TOOL_NAME);
    expect(JSON.stringify(tool.inputSchema)).toContain('"beat"');
    const call = (input: unknown) => ({
      id: "toolu_1",
      name: START_LESSON_TOOL_NAME,
      input,
    });
    expect(parseLessonCall(call({ chapter: "sound" }))).toBe("sound");
    // Finish a track is started whole (GRV-44); its own chapters are not lessons alone.
    expect(parseLessonCall(call({ chapter: "track" }))).toBe("track");
    expect(parseLessonCall(call({ chapter: "bass" }))).toBeNull();
    expect(parseLessonCall(call({ chapter: "basslines" }))).toBeNull();
    expect(parseLessonCall(call({ chapter: "beat", bite: "beat-kick" }))).toBeNull();
  });

  it("is taken out of a proposal, which is left with only its changes", () => {
    const lesson = {
      id: "toolu_1",
      name: START_LESSON_TOOL_NAME,
      input: { chapter: "beat" },
    };
    const change = { id: "toolu_2", name: "parameter_set", input: {} };
    const alone = splitLessonCalls({
      baseRevision: 1,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      calls: [lesson],
    });
    expect(alone).toEqual({ proposal: null, lessons: [lesson] });
    const mixed = splitLessonCalls({
      baseRevision: 1,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      calls: [lesson, change],
    });
    expect(mixed.proposal?.calls).toEqual([change]);
    expect(isLessonCall(lesson)).toBe(true);
    expect(isLessonCall(change)).toBe(false);
  });
});
