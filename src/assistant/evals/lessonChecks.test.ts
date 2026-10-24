import { describe, expect, it } from "vitest";
import { lessonNote, proposalNote } from "../history";
import type { AssistantLessonContext } from "../lesson";
import {
  checkAsksThroughTool,
  checkNamesOnlyBlockBites,
  checkNoHistoryNote,
  checkSaysOnlyChanges,
  checkStartsLesson,
  type LessonTurnSent,
  namedTitles,
  pitchName,
  runLessonCheck,
} from "./lessonChecks";

/** A lesson block, its fields overridden. */
function block(overrides: Partial<AssistantLessonContext> = {}): AssistantLessonContext {
  return {
    chapterId: "chords",
    chapter: "Chords and hook",
    biteId: "chords-hook",
    bite: "The hook",
    skill: "writing a short, catchy melody over the chords",
    biteNumber: 2,
    biteCount: 3,
    moment: "bite_done",
    how: "show_me",
    step: null,
    changes: ['Added a synth track, "Hook".', "Hook: 8 notes added in bar 1."],
    style: "four_on_the_floor",
    quiz: "What makes a hook stick? (It's short and it repeats.)",
    next: ["Pluck the hook"],
    track: { title: "Finish a track", chapterNumber: 3, chapterCount: 5 },
    passed: [],
    earlier: [],
    ...overrides,
  };
}

const DESCRIBED = [
  "124 BPM",
  "4/4",
  "4 bars",
  "4 tracks",
  "BD track: 10 notes; bars 1-4; pads BD, Clap, Hat",
  "Bass track: 4 notes from A2 to A2; bars 1-4",
  "Chords track: 12 notes from A3 to D5; bars 1-4",
  "Hook track: 8 notes from A3 to F4; bars 1-4",
].join("\n");

function sent(
  lesson: AssistantLessonContext | null,
  request = "Finished.",
): LessonTurnSent {
  return { lesson, request, described: DESCRIBED };
}

const call = (name: string, input: unknown) => ({ id: `toolu_${name}`, name, input });

describe("24. Starts the lesson asked for", () => {
  const started = (
    calls: ReturnType<typeof call>[],
    ask: { question: string; options: { label: string }[] } | null = null,
  ) => ({
    text: "Let's shape a sound.",
    proposal: { calls },
    ask,
  });

  it("passes exactly the named start_lesson call", () => {
    expect(
      checkStartsLesson("sound", started([call("start_lesson", { chapter: "sound" })]))
        .status,
    ).toBe("pass");
  });

  it("fails a reply that only says it will start one", () => {
    expect(
      checkStartsLesson("sound", { text: "Starting it now.", proposal: null }),
    ).toEqual({
      status: "fail",
      detail: "Called no start_lesson",
    });
  });

  it("fails a question in place of the call (GRV-44 r2 F2)", () => {
    const result = checkStartsLesson("track", {
      text: "Sure.",
      proposal: null,
      ask: { question: "What should the track be?", options: [{ label: "House" }] },
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/instead of calling start_lesson/);
  });

  it("fails the wrong chapter, two calls, or a song change beside it", () => {
    expect(
      checkStartsLesson("sound", started([call("start_lesson", { chapter: "beat" })]))
        .detail,
    ).toMatch(/Started "beat", not "sound"/);
    expect(
      checkStartsLesson(
        "sound",
        started([
          call("start_lesson", { chapter: "sound" }),
          call("start_lesson", { chapter: "sound" }),
        ]),
      ).status,
    ).toBe("fail");
    expect(
      checkStartsLesson(
        "sound",
        started([
          call("start_lesson", { chapter: "sound" }),
          call("set_parameter", { value: 1 }),
        ]),
      ).detail,
    ).toMatch(/Changed the song beside it: set_parameter/);
  });

  it("lets an explanation or a memory proposal ride along", () => {
    expect(
      checkStartsLesson(
        "sound",
        started([
          call("start_lesson", { chapter: "sound" }),
          call("explain_change", { text: "why" }),
          call("remember_producer", { kind: "note", text: "likes plucks" }),
        ]),
      ).status,
    ).toBe("pass");
  });

  it("is skipped by runLessonCheck on a case that asks for no lesson", () => {
    expect(runLessonCheck("startsLesson", { text: "" }, sent(null)).status).toBe("skip");
  });
});

describe("25. Says only what changes says", () => {
  it("passes a reply that restates the changes and the description", () => {
    const result = checkSaysOnlyChanges(
      "That's your hook: 8 notes in bar 1, from A3 up to F4, sitting over the chords. Show me wrote it so you can see how a short phrase repeats.",
      sent(block()),
    );
    expect(result).toEqual({
      status: "pass",
      detail: "Every figure it gives is in what the turn sent",
    });
  });

  it("fails a pitch range and an above-the-chords claim no change makes (GRV-44 r2 F3)", () => {
    const result = checkSaysOnlyChanges(
      "Your hook runs from A5 to F5, above the chords, so it cuts through.",
      sent(block()),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/pitches not in what it was sent: A5, F5/);
    expect(result.detail).toMatch(/claims not in what it was sent: above chords/);
  });

  it("fails a count the changes give in other numbers (GRV-44 r1 F3)", () => {
    const chords = block({
      biteId: "chords-loop",
      bite: "A chord loop",
      changes: ["Chords: 12 notes added in bars 1-4, as 4 chords of 3 notes."],
      next: ["The hook"],
    });
    expect(
      checkSaysOnlyChanges("12 notes, two triads per bar: a solid loop.", sent(chords))
        .detail,
    ).toMatch(/numbers not in what it was sent: two/);
    expect(
      checkSaysOnlyChanges(
        "12 notes in bars 1 to 4, as 4 chords of 3 notes each.",
        sent(chords),
      ).status,
    ).toBe("pass");
  });

  it("fails a key said to be set when only a track was added (GRV-44 r1 F1)", () => {
    const key = block({
      chapterId: "bass",
      chapter: "Bass",
      biteId: "bass-key",
      bite: "Pick a key",
      moment: "step_done",
      changes: ['Added a synth track, "Bass".'],
      step: "Give the song a key: in the Key panel under the piano roll, pick A minor.",
      next: [],
    });
    const claimed = checkSaysOnlyChanges(
      "Show me added your Bass track and set the key to A minor.",
      sent(key),
    );
    expect(claimed.status).toBe("fail");
    expect(claimed.detail).toMatch(/says the key was set, which no change says/);
    // The step is still to do, so naming its key is fine.
    expect(
      checkSaysOnlyChanges(
        "Show me added your Bass track. Next, pick A minor in the Key panel.",
        sent(key),
      ).status,
    ).toBe("pass");
    // Once a change says the key was set, saying so is right.
    expect(
      checkSaysOnlyChanges(
        "You set the key to A minor.",
        sent({ ...key, changes: ["Key: no key (chromatic) to A minor."] }),
      ).status,
    ).toBe("pass");
  });

  it("fails a key, a track or a bar the turn never sent", () => {
    const result = checkSaysOnlyChanges(
      "Your Melody track in C major carries it through bar 9.",
      sent(block()),
    );
    expect(result.detail).toMatch(/numbers not in what it was sent: 9/);
    expect(result.detail).toMatch(/keys not in what it was sent: c major/);
    expect(result.detail).toMatch(/tracks not in what it was sent: Melody/);
  });

  it("reads the producer's own message, note values and drum machines as no claim", () => {
    expect(
      checkSaysOnlyChanges(
        "The snare on beats two and four answers the kick: the backbeat behind most 808 and 16th-note grooves.",
        sent(
          block({ moment: "under_way", changes: [] }),
          "why does the snare go on 2 and 4?",
        ),
      ).status,
    ).toBe("pass");
  });

  it("names MIDI pitches with middle C as C4", () => {
    expect(pitchName(60)).toBe("C4");
    expect(pitchName(57)).toBe("A3");
    expect(pitchName(66)).toBe("F#4");
  });
});

describe("26. Names only the block's bites", () => {
  it("passes the bite and the next bite the block names", () => {
    expect(
      checkNamesOnlyBlockBites(
        'Nice work on "The hook". Next up: Pluck the hook, when you want.',
        block(),
      ).status,
    ).toBe("pass");
  });

  it("fails a bite the chapter does not have (GRV-43 r1 F4)", () => {
    const tour = block({
      chapterId: "tour",
      chapter: "Tour the studio",
      biteId: "tour-arrangement",
      bite: "The Arrangement",
      how: "skipped",
      changes: [],
      next: ["The Sequence view"],
      track: null,
    });
    const result = checkNamesOnlyBlockBites(
      "That's fine, the arrangement will make sense in time. Next up is Sections, where you'll lay out the song.",
      tour,
    );
    expect(result).toEqual({
      status: "fail",
      detail: 'Names what the block does not: "Sections"',
    });
    expect(
      checkNamesOnlyBlockBites("Skipping is fine. On to the Sections bite?", tour).status,
    ).toBe("fail");
    expect(
      checkNamesOnlyBlockBites("Skipping is fine. Next is The Sequence view.", tour)
        .status,
    ).toBe("pass");
  });

  it("fails a real bite the block does not name", () => {
    expect(
      checkNamesOnlyBlockBites('After this comes "Watch the master".', block()).status,
    ).toBe("fail");
  });

  it("allows a chapter a wrap-up pointer names", () => {
    const wrapUp = block({
      moment: "chapter_done",
      next: [
        'The "Shape a sound" chapter: a synth pluck',
        'The "Tour the studio" chapter: the five views',
      ],
      track: null,
    });
    expect(
      checkNamesOnlyBlockBites(
        "Try Shape a sound next, or the Tour the studio chapter.",
        wrapUp,
      ).status,
    ).toBe("pass");
  });

  it("finds titles quoted, beside bite or chapter, and after next", () => {
    expect(
      namedTitles('the "Hats" bite, then the Drop chapter. Next up: Sections'),
    ).toEqual(["Hats", "Drop", "Sections"]);
  });

  it("passes a turn outside a lesson", () => {
    expect(checkNamesOnlyBlockBites("Anything at all.", null).status).toBe("pass");
  });
});

describe("27. Asks through the tool, never in text", () => {
  const quiz = {
    question: "What makes a hook stick?",
    options: [{ label: "It repeats" }, { label: "It's loud" }, { label: "It's long" }],
  };

  it("passes a quiz asked with ask_producer, and a reply that asks nothing", () => {
    expect(
      checkAsksThroughTool({ text: "Lovely hook. Quick one:", ask: quiz }, block())
        .status,
    ).toBe("pass");
    expect(checkAsksThroughTool({ text: "Lovely hook." }, block()).status).toBe("pass");
  });

  it("fails a quiz written out as text (GRV-44 r2)", () => {
    const result = checkAsksThroughTool(
      { text: "Quick quiz: what makes a hook stick? A) It repeats B) It's loud" },
      block(),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/without ask_producer/);
  });

  it("fails a transcript or the options written beside the call", () => {
    expect(
      checkAsksThroughTool(
        {
          text: "[I asked the producer (ask_producer, pick one): What makes a hook stick?]",
          ask: quiz,
        },
        block(),
      ).detail,
    ).toMatch(/transcript/);
    expect(
      checkAsksThroughTool(
        {
          text: "Is it because it repeats, or because it's loud? It repeats, or It's loud.",
          ask: quiz,
        },
        block(),
      ).detail,
    ).toMatch(/options into its text/);
  });

  it("fails a quiz of one option, or of five", () => {
    expect(
      checkAsksThroughTool(
        { text: "", ask: { question: "Ready?", options: [{ label: "Yes" }] } },
        block(),
      ).detail,
    ).toMatch(/1 options, not two to four/);
  });
});

describe("28. No history note echoed", () => {
  it("fails the note after a reply that started a lesson (GRV-43 r2 F1)", () => {
    const result = checkNoHistoryNote(`Let's take the tour.\n\n${lessonNote("tour")}`);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/\[I called start_lesson/);
  });

  it("fails a proposal's note, or any line that is one bracketed note", () => {
    expect(checkNoHistoryNote(proposalNote("applied")).status).toBe("fail");
    expect(checkNoHistoryNote("Done.\n[Started the tour for you.]").status).toBe("fail");
  });

  it("passes brackets inside a sentence that are not a note", () => {
    expect(
      checkNoHistoryNote("Put the kick on steps 1, 5, 9 and 13 [the beats].").status,
    ).toBe("pass");
  });
});
