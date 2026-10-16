import { describe, expect, it } from "vitest";
import { ASK_LIMITS, assistantAskSchema } from "../assistant/ask";
import {
  EMPTY_MEMORY,
  ONBOARDING_QUESTION_IDS,
  producerMemorySchema,
} from "../persistence/profileDocuments";
import {
  applyAnswer,
  isAnswered,
  lessonOfferAsk,
  memoryLines,
  ONBOARDING_QUESTIONS,
  suggestedLesson,
  typedItems,
  validationAnswers,
} from "./questions";

const pick = (questionIndex: number, labels: string[], text = "") => {
  const { ask } = ONBOARDING_QUESTIONS[questionIndex];
  return {
    picked: labels.map((label) =>
      ask.options.findIndex((option) => option.label === label),
    ),
    text,
  };
};

describe("onboarding's questions (GRV-25)", () => {
  it("asks the five, in order, each a valid question the panel can carry", () => {
    expect(ONBOARDING_QUESTIONS.map((question) => question.id)).toEqual([
      ...ONBOARDING_QUESTION_IDS,
    ]);
    for (const question of ONBOARDING_QUESTIONS) {
      expect(assistantAskSchema.safeParse(question.ask).success).toBe(true);
      expect(question.ask.options.length).toBeLessThanOrEqual(ASK_LIMITS.maxOptions);
    }
    expect(assistantAskSchema.safeParse(lessonOfferAsk(null)).success).toBe(true);
  });

  it("puts genres in taste and the typed words in artists", () => {
    const memory = applyAnswer(
      EMPTY_MEMORY,
      "taste",
      pick(0, ["House", "Techno"], "Four Tet"),
    );
    expect(memory.taste).toEqual(["House", "Techno"]);
    expect(memory.artists).toBe("Four Tet");
  });

  it("stores experience and goal as their typed keys", () => {
    let memory = applyAnswer(EMPTY_MEMORY, "experience", pick(1, ["Played around"]));
    memory = applyAnswer(memory, "goal", pick(2, ["Music for a video or game"]));
    expect(memory.experience).toBe("played_around");
    expect(memory.goal).toBe("video_or_game");
  });

  it("adds typed gear to the picked chips, split on commas, without repeats", () => {
    const memory = applyAnswer(
      EMPTY_MEMORY,
      "gear",
      pick(4, ["Ableton Move"], "Roland T-8, ableton move, OP-1"),
    );
    expect(memory.gear).toEqual(["Ableton Move", "Roland T-8", "OP-1"]);
    expect(typedItems(" a ,, b ")).toEqual(["a", "b"]);
  });

  it("knows which questions an answer has settled", () => {
    const memory = applyAnswer(EMPTY_MEMORY, "learn", pick(3, ["Mixing"]));
    expect(isAnswered(memory, "learn")).toBe(true);
    expect(isAnswered(memory, "goal")).toBe(false);
    expect(producerMemorySchema.safeParse(memory).success).toBe(true);
  });

  it("lists every answered field on the memory card", () => {
    const memory = {
      ...EMPTY_MEMORY,
      taste: ["House"],
      artists: "Four Tet",
      experience: "releases" as const,
      gear: ["Ableton Move"],
    };
    expect(memoryLines(memory)).toEqual([
      { field: "Music you love", value: "House" },
      { field: "Artists", value: "Four Tet" },
      { field: "Experience", value: "I release music" },
      { field: "Gear", value: "Ableton Move" },
    ]);
  });

  it("suggests a first lesson from the goal", () => {
    expect(suggestedLesson("first_track")).toBe("Make your first beat");
    expect(suggestedLesson(null)).toBe("A five-minute tour of the studio");
  });

  it("reduces memory to its fixed choices for validation, never artists or typed words", () => {
    const answers = validationAnswers({
      taste: ["House"],
      artists: "Four Tet",
      experience: null,
      goal: "sound_design",
      learn: ["Mixing", "My own typed thing"],
      gear: ["Roland T-8", "OP-1"],
    });
    expect(answers).toEqual({
      experience: "unanswered",
      goal: "sound_design",
      learn: ["mixing"],
      gear: ["roland_t8"],
    });
  });
});
