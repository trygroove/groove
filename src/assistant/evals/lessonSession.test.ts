import { describe, expect, it } from "vitest";
import {
  createScriptedAssistantProvider,
  replyEvents,
  toolUseEvents,
} from "../../testing/scriptedAssistantProvider";
import { type AssistantAsk, answerMessage } from "../ask";
import { LESSON_BLOCK_HEADING } from "../lesson";
import { START_LESSON_TOOL_NAME } from "../lessonTool";
import { MEMORY_BLOCK_HEADING } from "../prompt";
import { continuesTurn } from "../providerRequest";
import { EVAL_CASES, type EvalCase } from "./cases";
import { validateExperiment } from "./experiment";
import { LESSON_CASES } from "./lessonCases";
import {
  checkNamesOnlyBlockBites,
  checkSaysOnlyChanges,
  type LessonTurnSent,
  namedTitles,
} from "./lessonChecks";
import {
  lessonFixture,
  lessonOpening,
  lessonWalk,
  runLessonSession,
} from "./lessonSession";
import { type EvalTurn, evaluateTurn, runCaseTurn, runEvals } from "./run";
import { inSelection } from "./sets";
import { caseSplit } from "./splits";

const find = (id: string): EvalCase => {
  const found = EVAL_CASES.find((entry) => entry.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
};

const reply = (text: string, extra: Partial<EvalTurn> = {}): EvalTurn => ({
  durationMs: 10,
  error: null,
  stopReason: "end_turn",
  text,
  proposal: null,
  ...extra,
});

const QUIZ: AssistantAsk = {
  id: "toolu_quiz",
  question: "What makes a hook stick?",
  options: [{ label: "It repeats" }, { label: "It's loud" }],
  multiSelect: false,
  suggested: 0,
};

describe("the lessons set (GRV-208)", () => {
  it("holds the ten cases, in the lessons set, each with a split", () => {
    expect(LESSON_CASES.map((entry) => entry.id)).toEqual([
      "teach-me-beat-after-chapter",
      "finish-track-new-project",
      "lesson-start-no-echo",
      "hook-shown",
      "chords-shown",
      "key-show-me",
      "skip-names-next",
      "quiz-is-a-call",
      "wrap-up-once",
      "under-way-question",
    ]);
    expect(EVAL_CASES.filter((entry) => inSelection(entry, "lessons"))).toEqual(
      LESSON_CASES,
    );
    expect(
      LESSON_CASES.filter((entry) => caseSplit(entry) === "heldout").map(
        (entry) => entry.id,
      ),
    ).toEqual(["lesson-start-no-echo", "chords-shown", "wrap-up-once"]);
  });

  it("carries memory on every case, so start_lesson is offered, and checks to judge it by", () => {
    for (const entry of LESSON_CASES) {
      expect(entry.memory, entry.id).toBeDefined();
      expect(entry.lessonChecks?.length, entry.id).toBeGreaterThan(0);
      expect(entry.expect, entry.id).toBe("explain");
    }
  });

  it("walks a lesson to a bite's start by Show me, the same project every time", () => {
    const script = find("hook-shown").lessonSession;
    if (!script) throw new Error("hook-shown is not a session");
    const walk = lessonWalk(script);
    expect(walk.transition.event.kind).toBe("bite_started");
    expect(walk.world.project.song.tracks.map((track) => track.name)).toEqual([
      "BD",
      "Bass",
      "Chords",
    ]);
    expect(lessonFixture(script)()).toBe(lessonFixture(script)());
    expect(lessonOpening(script)).toBe('Let\'s do "The hook".');
  });

  it("builds the mid-lesson question's block from the walk, under way", () => {
    const question = find("under-way-question");
    expect(question.lesson).toMatchObject({
      moment: "under_way",
      biteId: "beat-snare",
      style: "boom_bap",
      changes: [],
    });
  });
});

describe("runLessonSession", () => {
  it("sends a turn per moment, the producer doing each step by Show me in between", async () => {
    const evalCase = find("hook-shown");
    const sent: EvalCase[] = [];
    const turn = await runLessonSession(evalCase, async (turnCase) => {
      sent.push(turnCase);
      return reply(`Reply ${sent.length}.`);
    });

    expect(sent.map((entry) => entry.request)).toEqual([
      'Let\'s do "The hook".',
      'Done that step of "The hook": you showed me.',
      'Finished "The hook": you showed me.',
    ]);
    expect(sent.map((entry) => entry.lesson?.moment)).toEqual([
      "bite_started",
      "step_done",
      "bite_done",
    ]);
    // Each turn is sent against the project the step left, and its changes
    // are what `describeChanges` says.
    expect(sent[0]?.fixture().song.tracks.map((track) => track.name)).not.toContain(
      "Hook",
    );
    expect(sent[1]?.fixture().song.tracks.map((track) => track.name)).toContain("Hook");
    expect(sent[1]?.lesson?.changes).toEqual(['Added a synth track, "Hook".']);
    expect(sent[2]?.lesson?.changes).toContain("Hook: 8 notes added in bar 1.");
    expect(sent[2]?.lesson?.next).toEqual(["Pluck the hook"]);
    // As the panel sends them: memory beside every lesson turn, and the
    // conversation growing turn by turn.
    expect(sent.every((entry) => entry.memory === evalCase.memory)).toBe(true);
    expect(sent[2]?.history?.slice(-2)).toEqual([
      { role: "user", text: 'Done that step of "The hook": you showed me.' },
      { role: "assistant", text: "Reply 2." },
    ]);
    expect(sent.every((entry) => !entry.lessonSession && !entry.session)).toBe(true);

    expect(turn.session?.ended).toBe("done");
    expect(turn.session?.turns.map((each) => each.lesson?.moment)).toEqual([
      "bite_started",
      "step_done",
      "bite_done",
    ]);
    expect(turn.session?.turns[2]?.described).toMatch(/^Hook track: 8 notes/m);
    expect(turn.text).toBe("Reply 1.\n\nReply 2.\n\nReply 3.");
  });

  it("skips each step for a producer who skips, and ends on the bite", async () => {
    const sent: EvalCase[] = [];
    await runLessonSession(find("skip-names-next"), async (turnCase) => {
      sent.push(turnCase);
      return reply("ok");
    });
    expect(sent.map((entry) => [entry.lesson?.moment, entry.lesson?.how])).toEqual([
      ["bite_started", null],
      ["bite_done", "skipped"],
    ]);
    expect(sent[1]?.lesson?.next).toEqual(["The Sequence view"]);
  });

  it("answers a quiz with its suggested option, the lesson under way, before it ends", async () => {
    const sent: EvalCase[] = [];
    const turn = await runLessonSession(find("quiz-is-a-call"), async (turnCase) => {
      sent.push(turnCase);
      return turnCase.lesson?.moment === "bite_done"
        ? reply("Lovely hats.", { ask: QUIZ })
        : reply("ok");
    });
    expect(sent.map((entry) => entry.lesson?.moment)).toEqual([
      "bite_started",
      "bite_done",
      "under_way",
    ]);
    expect(sent[2]?.request).toBe(answerMessage(QUIZ, { picked: [0], text: "" }));
    expect(turn.session?.ended).toBe("done");
  });

  it("stops at its cap, and on an errored turn", async () => {
    const quiz = find("quiz-is-a-call");
    if (!quiz.lessonSession) throw new Error("quiz-is-a-call is not a session");
    const asking = await runLessonSession(
      {
        ...quiz,
        lessonSession: { ...quiz.lessonSession, maxTurns: 1 },
      },
      async () => reply("ok"),
    );
    expect(asking.session?.ended).toBe("cap");
    expect(asking.session?.turns).toHaveLength(1);

    const failed = await runLessonSession(find("hook-shown"), async () =>
      reply("", { error: "provider_error: no" }),
    );
    expect(failed.session?.ended).toBe("errored");
    expect(failed.error).toBe("Turn 1: provider_error: no");
  });
});

describe("a lesson turn through the gateway", () => {
  it("sends the lesson block and memory, so start_lesson is offered", async () => {
    const provider = createScriptedAssistantProvider([replyEvents(["Nice."])]);
    await runCaseTurn(find("under-way-question"), { provider });
    const [request] = provider.requests;
    if (!request) throw new Error("nothing was sent");
    expect(request.tools.map((tool) => tool.name)).toContain(START_LESSON_TOOL_NAME);
    expect(
      request.system.some((block) => block.text.startsWith(MEMORY_BLOCK_HEADING)),
    ).toBe(true);
    const lesson = request.system.find((block) =>
      block.text.includes(LESSON_BLOCK_HEADING),
    );
    expect(lesson?.text).toContain('"moment":"under_way"');
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: "why does the snare go on 2 and 4?",
    });
  });

  it("runs a lesson session's turns with each its own block", async () => {
    const provider = createScriptedAssistantProvider([
      replyEvents(["Let's write a hook."]),
      replyEvents(["Good, a Hook track."]),
      replyEvents(["That's your hook, 8 notes in bar 1."]),
    ]);
    const report = await runEvals({ provider, cases: [find("hook-shown")], runs: 1 });
    const opening = provider.requests.filter((sent) => !continuesTurn(sent));
    expect(opening).toHaveLength(3);
    expect(
      opening.map(
        (sent) =>
          sent.system
            .find((block) => block.text.includes(LESSON_BLOCK_HEADING))
            ?.text.match(/"moment":"(\w+)"/)?.[1],
      ),
    ).toEqual(["bite_started", "step_done", "bite_done"]);
    const [record] = report.records;
    expect(record?.turnChecks).toHaveLength(3);
    expect(record?.checks.saysOnlyChanges?.status).toBe("pass");
    expect(record?.checks.outcome?.status).toBe("pass");
    expect(report.summary.checks.saysOnlyChanges).toEqual({ pass: 1, fail: 0, skip: 0 });
  });

  it("judges a start case on the call it came back with", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("Let's shape a sound.", [
        { name: START_LESSON_TOOL_NAME, input: { chapter: "sound" } },
      ]),
    ]);
    const report = await runEvals({
      provider,
      cases: [find("teach-me-beat-after-chapter")],
      runs: 1,
    });
    const [record] = report.records;
    expect(record?.checks.startsLesson?.status).toBe("pass");
    expect(record?.checks.noHistoryNote?.status).toBe("pass");
    // A lesson call is not a song change: nothing was proposed.
    expect(record?.checks.outcome?.status).toBe("pass");
    expect(record?.checks.valid).toBeUndefined();
  });
});

describe("judging a lesson session", () => {
  it("judges checks 25 to 28 on every turn, and fails the record on the first turn that fails", async () => {
    const evalCase = find("chords-shown");
    const turn = await runLessonSession(evalCase, async (turnCase) =>
      turnCase.lesson?.moment === "bite_done"
        ? reply("12 notes, two triads per bar. Quick quiz: how many notes make a chord?")
        : reply("Good."),
    );
    const record = evaluateTurn(evalCase, 1, turn);
    expect(record.turnChecks?.map((checks) => checks.saysOnlyChanges?.status)).toEqual([
      "pass",
      "pass",
      "fail",
    ]);
    expect(record.checks.saysOnlyChanges?.detail).toMatch(
      /^Turn 3: numbers not in what it was sent: two/,
    );
    expect(record.checks.asksThroughTool?.detail).toMatch(/^Turn 3: Asks in its text/);
    expect(record.checks.noHistoryNote?.status).toBe("pass");
    expect(record.checks.startsLesson).toBeUndefined();
  });

  it("fails 'above the chords' on hook-shown's bite_done, the hook under them as on the QA project", async () => {
    const evalCase = find("hook-shown");
    const judged = async (text: string) => {
      const turn = await runLessonSession(evalCase, async (turnCase) =>
        reply(turnCase.lesson?.moment === "bite_done" ? text : "Good."),
      );
      return evaluateTurn(evalCase, 1, turn).checks.saysOnlyChanges;
    };
    // The walk moves the chords up to A4-D6 before the hook: Show me's hook
    // (A4-F5) sits under them, and the step's "above the chords" backs nothing.
    expect(
      (
        await judged(
          "Show me wrote your hook: 8 notes in bar 1, from A4 up to F5, just above the chords.",
        )
      )?.detail,
    ).toMatch(/claims not in what it was sent: hook above chords/);
    expect(
      (
        await judged(
          "Show me wrote your hook: 8 notes in bar 1, from A4 up to F5, tucked under the chords.",
        )
      )?.status,
    ).toBe("pass");
    expect(
      (await judged("Your hook runs from A5 to F5, above the chords."))?.detail,
    ).toMatch(/pitches not in what it was sent: A5.*claims not in what it was sent/);
  });

  it("fails wrap-up-once when the wrap-up asks the chapter's quiz through ask_producer", async () => {
    const evalCase = find("wrap-up-once");
    const quiz: AssistantAsk = {
      id: "toolu_quiz",
      question: "How do you make one bar play for four on the arrangement?",
      options: [{ label: "Loop its clip and stretch it" }, { label: "Copy it" }],
      multiSelect: false,
      suggested: 0,
    };
    const asked = await runLessonSession(evalCase, async (turnCase) =>
      turnCase.lesson?.moment === "chapter_done"
        ? reply("That's your first beat, four bars of it. One last thing:", { ask: quiz })
        : reply("Good."),
    );
    const failed = evaluateTurn(evalCase, 1, asked);
    expect(failed.checks.asksThroughTool?.detail).toMatch(
      /^Turn 2: Asks "How do you make one bar play/,
    );
    expect(failed.checks.namesOnlyBlockBites?.detail).toMatch(
      /^Turn 2: A wrap-up offering 0 of "next" as pointers/,
    );

    const wrapped = await runLessonSession(evalCase, async (turnCase) =>
      turnCase.lesson?.moment === "chapter_done"
        ? reply(
            "That's your first beat, looping for four bars. When you want more, Finish a track takes it all the way to stems, or Shape a sound builds a pluck from scratch.",
          )
        : reply("Good."),
    );
    const passed = evaluateTurn(evalCase, 1, wrapped);
    expect(passed.checks.asksThroughTool?.status).toBe("pass");
    expect(passed.checks.namesOnlyBlockBites?.status).toBe("pass");
  });

  it("fails check 8 on a lesson turn that changes the song", () => {
    const evalCase = find("under-way-question");
    const record = evaluateTurn(
      evalCase,
      1,
      reply("I'll add it.", {
        proposal: {
          baseRevision: 0,
          toolsetVersion: 1,
          calls: [{ id: "toolu_1", name: "set_parameter", input: {} }],
        },
      }),
    );
    expect(record.checks.outcome?.status).toBe("fail");
    expect(record.checks.valid).toBeUndefined();
  });

  it("lets an experiment hold the lesson checks on every turn", () => {
    const experiment = validateExperiment({
      id: "lesson-facts",
      card: "GRV-208",
      hypothesis: "Facts first.",
      cases: { set: "lessons" },
      goal: "quality",
      variants: { low: { thinkingEffort: "low" } },
      guardrails: { everyTurnChecks: ["saysOnlyChanges", "noHistoryNote"] },
    });
    expect(experiment.guardrails.everyTurnChecks).toEqual([
      "saysOnlyChanges",
      "noHistoryNote",
    ]);
  });
});

/** What each turn of a case's session sent, by its moment: the case's real blocks. */
async function sentAt(id: string, moment: string): Promise<LessonTurnSent> {
  const turn = await runLessonSession(find(id), async () => reply("Good."));
  const found = turn.session?.turns.find((each) => each.lesson?.moment === moment);
  if (!found?.lesson) throw new Error(`${id} sent no ${moment} turn`);
  return {
    lesson: found.lesson,
    request: found.request,
    described: found.described ?? "",
  };
}

describe("the lesson checks on the cases' own blocks", () => {
  describe("25 on key-show-me's step_done: only the Bass track was added", () => {
    it("passes what has not set the key, and what tells the producer to", async () => {
      const sent = await sentAt("key-show-me", "step_done");
      expect(sent.lesson?.changes).toEqual(['Added a synth track, "Bass".']);
      for (const said of [
        "It didn't set the key: that one's yours.",
        "Show me added a Bass track but hasn't set the key yet.",
        "Nothing has set the key yet.",
        "Now pick A minor in the Key panel under the piano roll.",
        "Then open Bass's clip and pick A minor in the Key panel.",
        "Go ahead and set the key to A minor in the Key panel.",
        "Show me set up a Bass track, and the key comes next.",
      ]) {
        expect(checkSaysOnlyChanges(said, sent), said).toEqual({
          status: "pass",
          detail: "Every figure it gives is in what the turn sent",
        });
      }
    });

    it("fails what says the key was set", async () => {
      const sent = await sentAt("key-show-me", "step_done");
      for (const said of [
        "That set the key to A minor, so the bass will agree.",
        "Show me added a Bass track and set the song to A minor.",
        "Done: a Bass track, and the song is set to A minor.",
        "Your song is in A minor now.",
        "Show me set the key to A minor.",
      ]) {
        expect(checkSaysOnlyChanges(said, sent).detail, said).toMatch(
          /says the key was set, which no change says/,
        );
      }
    });
  });

  describe("25 reads above and below only between two tracks with registers", () => {
    it("passes a part over the beat or the kick, and a title with 'under' in it", async () => {
      const hook = await sentAt("hook-shown", "bite_done");
      expect(
        checkSaysOnlyChanges("That's a melody you can hum over the beat.", hook).status,
      ).toBe("pass");
      const hats = await sentAt("quiz-is-a-call", "bite_done");
      expect(
        checkSaysOnlyChanges("Hats on the off-beats ride over the kick.", hats).status,
      ).toBe("pass");
      const key = await sentAt("key-show-me", "bite_done");
      const said = "Next up is Under the kick, where the bass sits below the kick.";
      expect(checkSaysOnlyChanges(said, key).status).toBe("pass");
      expect(checkNamesOnlyBlockBites(said, key.lesson).status).toBe("pass");
    });
  });

  it("25 reads the bite's place as sent: bite 5 of 6 is five bites in", async () => {
    const hats = await sentAt("quiz-is-a-call", "bite_done");
    expect(hats.lesson).toMatchObject({ biteNumber: 5, biteCount: 6 });
    expect(checkSaysOnlyChanges("You're five bites in, one to go.", hats).status).toBe(
      "pass",
    );
  });

  it("25 reads no figure in a numbered list's markers", async () => {
    const hats = await sentAt("quiz-is-a-call", "bite_started");
    expect(checkSaysOnlyChanges("1. Click step 3\n2. Click step 7", hats).status).toBe(
      "pass",
    );
    expect(checkSaysOnlyChanges("1. Click step 3\n2. Click step 8", hats).detail).toMatch(
      /numbers not in what it was sent: 8$/,
    );
  });

  describe("26 names a title after 'Next' only as far as a known title goes", () => {
    it("passes the next bite with words after it", async () => {
      const hook = await sentAt("hook-shown", "bite_done");
      for (const said of [
        "Next up is Pluck the hook when you want to go on.",
        "Next up is Pluck the hook — give it a sound of its own.",
      ]) {
        expect(checkNamesOnlyBlockBites(said, hook.lesson).status, said).toBe("pass");
      }
      const key = await sentAt("key-show-me", "bite_done");
      expect(
        checkNamesOnlyBlockBites(
          "Next up is Under the kick when you're ready.",
          key.lesson,
        ).status,
      ).toBe("pass");
      const chords = await sentAt("chords-shown", "bite_done");
      expect(
        checkNamesOnlyBlockBites("Next, I'll walk you through The hook.", chords.lesson)
          .status,
      ).toBe("pass");
    });

    it("passes a wrap-up's pointers named after 'Next'", async () => {
      const wrap = await sentAt("wrap-up-once", "chapter_done");
      expect(
        checkNamesOnlyBlockBites("Next: Finish a track or Shape a sound.", wrap.lesson),
      ).toEqual({
        status: "pass",
        detail: 'Names only the block\'s bites and chapters, and offers 2 of "next"',
      });
      const one = "Next, Finish a track takes it all the way to stems.";
      expect(namedTitles(one)).toEqual(["Finish a track", "Finish a track"]);
      // Its one pointer is a wrap-up's only shortfall: it names nothing stray.
      expect(checkNamesOnlyBlockBites(one, wrap.lesson).detail).toMatch(
        /offering 1 of "next"/,
      );
      expect(
        checkNamesOnlyBlockBites(`${one} Or Shape a sound builds a pluck.`, wrap.lesson)
          .status,
      ).toBe("pass");
    });

    it("fails a title the block does not name, invented or real", async () => {
      const skipped = await sentAt("skip-names-next", "bite_done");
      for (const [said, named] of [
        ["Next up is Sections, where you'll lay out the song.", "Sections"],
        ["Next up is Sections when you're ready.", "Sections"],
        ["Skipping is fine. On to the Sections bite.", "Sections"],
        ["Next up is Hats.", "Hats"],
      ] as const) {
        expect(checkNamesOnlyBlockBites(said, skipped.lesson), said).toEqual({
          status: "fail",
          detail: `Names what the block does not: "${named}"`,
        });
      }
      expect(
        checkNamesOnlyBlockBites("Next up is The Sequence view.", skipped.lesson).status,
      ).toBe("pass");
    });
  });

  it("26 reads no title in a word that only starts a sentence before 'bite'", async () => {
    const hook = await sentAt("hook-shown", "bite_done");
    for (const said of [
      "Great bite.",
      "Lovely chapter so far.",
      "That's bite 1 of 3 done.",
    ]) {
      expect(checkNamesOnlyBlockBites(said, hook.lesson).status, said).toBe("pass");
    }
  });

  it("26 counts a wrap-up pointer by its title's words, hyphens and all", async () => {
    const wrap = await sentAt("wrap-up-once", "chapter_done");
    expect(
      checkNamesOnlyBlockBites(
        "That's your first beat. From here there's a lesson on finishing a whole track, one on shaping a synth sound, and a tour of the studio.",
        wrap.lesson,
      ).detail,
    ).toMatch(/offers 3 of "next"/);
    expect(
      checkNamesOnlyBlockBites("Try Finish-a-track, or Shape-a-sound.", wrap.lesson)
        .detail,
    ).toMatch(/offers 2 of "next"/);
  });
});
