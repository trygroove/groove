/**
 * Onboarding's five questions (GRV-25) and what an answer does to memory.
 *
 * Each question is an {@link AssistantAsk}, the same shape `ask_producer`
 * gives the editor's questions (GRV-42), so the welcome and the panel draw it
 * with one card and the conversation carries it into the panel unchanged.
 * They are scripted rather than asked by the model: the questions are fixed,
 * they must be answered the same way for everyone to mean anything as
 * validation, and the welcome has no project for a turn to be about.
 *
 * Pure: no Solid, no Firebase.
 */
import { ASSISTANT_NAME } from "../../site.config.mjs";
import {
  type GearChipId,
  type LearnChipId,
  UNANSWERED,
} from "../analytics/catalog/onboarding";
import { type AskAnswer, type AssistantAsk, pickedLabels } from "../assistant/ask";
import {
  type ExperienceLevel,
  MAX_ARTISTS_CHARS,
  MAX_MEMORY_ITEM_CHARS,
  MAX_MEMORY_LIST,
  ONBOARDING_QUESTION_IDS,
  type OnboardingQuestionId,
  type ProducerGoal,
  type ProducerMemory,
} from "../persistence/profileDocuments";

/** One onboarding question, as the welcome asks it. */
export interface OnboardingQuestion {
  readonly id: OnboardingQuestionId;
  readonly ask: AssistantAsk;
  /** What the box for the producer's own words is called on this question. */
  readonly textLabel: string;
}

/** The genres the first question offers. */
export const GENRE_CHOICES = [
  "House",
  "Techno",
  "Hip hop",
  "Trap",
  "Drum and bass",
  "Ambient",
  "Pop",
  "Lo-fi",
] as const;

/** "How much music have you made?", label to stored level. */
export const EXPERIENCE_CHOICES: readonly (readonly [string, ExperienceLevel])[] = [
  ["None yet", "none"],
  ["Played around", "played_around"],
  ["Finished a few", "finished_a_few"],
  ["I release music", "releases"],
];

/** "A goal, or just curious?", label to stored goal. */
export const GOAL_CHOICES: readonly (readonly [string, ProducerGoal])[] = [
  ["My first track", "first_track"],
  ["Music for a video or game", "video_or_game"],
  ["Sound design", "sound_design"],
  ["Just curious", "curious"],
];

/** "What would you like to learn?", label to validation chip. */
export const LEARN_CHOICES: readonly (readonly [string, LearnChipId])[] = [
  ["Drums and beats", "drums"],
  ["Basslines", "bass"],
  ["Chords and melody", "chords"],
  ["Sound design", "sound_design"],
  ["Arranging a whole track", "arranging"],
  ["Mixing", "mixing"],
];

/** "Any gear to use with Groove?", label to validation chip. */
export const GEAR_CHOICES: readonly (readonly [string, GearChipId])[] = [
  ["Ableton Move", "ableton_move"],
  ["Roland T-8", "roland_t8"],
  ["A MIDI keyboard", "midi_keyboard"],
  ["A drum machine", "drum_machine"],
  ["A synth", "synth"],
  ["Just my computer", "computer_only"],
];

const SOMETHING_ELSE = "Something else";

function question(
  id: OnboardingQuestionId,
  text: string,
  options: readonly string[],
  multiSelect: boolean,
  textLabel = SOMETHING_ELSE,
): OnboardingQuestion {
  const position = ONBOARDING_QUESTION_IDS.indexOf(id) + 1;
  return {
    id,
    textLabel,
    ask: {
      id: `onboarding-${id}`,
      question: text,
      context: `About you · ${position} of ${ONBOARDING_QUESTION_IDS.length}`,
      options: options.map((label) => ({ label })),
      multiSelect,
    },
  };
}

const labels = (choices: readonly (readonly [string, string])[]) =>
  choices.map(([label]) => label);

/** The five questions, in the order they are asked. */
export const ONBOARDING_QUESTIONS: readonly OnboardingQuestion[] = [
  question(
    "taste",
    "What music do you love? Pick any genres, and tell me some artists.",
    GENRE_CHOICES,
    true,
    "Artists you love",
  ),
  question(
    "experience",
    "How much music have you made?",
    labels(EXPERIENCE_CHOICES),
    false,
  ),
  question(
    "goal",
    "Do you have a goal, or are you just curious?",
    labels(GOAL_CHOICES),
    false,
  ),
  question("learn", "What would you like to learn?", labels(LEARN_CHOICES), true),
  question("gear", "Any gear you'd like to use with Groove?", labels(GEAR_CHOICES), true),
];

export function onboardingQuestion(id: OnboardingQuestionId): OnboardingQuestion {
  const found = ONBOARDING_QUESTIONS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No onboarding question "${id}"`);
  return found;
}

/** How an answer was given, for `onboarding_question_answered`. */
export function answerHow(answer: AskAnswer): "pick" | "text" {
  return answer.picked.length > 0 ? "pick" : "text";
}

/** Typed text as list entries: split on commas, trimmed, each within bounds. */
export function typedItems(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((part) => part.trim().slice(0, MAX_MEMORY_ITEM_CHARS))
    .filter((part) => part.length > 0);
}

/** `items` without repeats (ignoring case), at most the list cap. */
export function uniqueItems(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept.slice(0, MAX_MEMORY_LIST);
}

/** A choice's stored value from its label, or null. */
function choiceValue<V extends string>(
  choices: readonly (readonly [string, V])[],
  label: string | undefined,
): V | null {
  return choices.find(([choice]) => choice === label)?.[1] ?? null;
}

/**
 * Memory with `answer` to question `id` in it. A single-choice question's
 * typed words have no field to go in, so only a pick changes `experience`
 * and `goal`.
 */
export function applyAnswer(
  memory: ProducerMemory,
  id: OnboardingQuestionId,
  answer: AskAnswer,
): ProducerMemory {
  const { ask } = onboardingQuestion(id);
  const picked = pickedLabels(ask, answer);
  const typed = answer.text.trim();
  switch (id) {
    case "taste":
      return {
        ...memory,
        taste: uniqueItems(picked),
        artists: typed.slice(0, MAX_ARTISTS_CHARS),
      };
    case "experience":
      return { ...memory, experience: choiceValue(EXPERIENCE_CHOICES, picked[0]) };
    case "goal":
      return { ...memory, goal: choiceValue(GOAL_CHOICES, picked[0]) };
    case "learn":
      return { ...memory, learn: uniqueItems([...picked, ...typedItems(typed)]) };
    case "gear":
      return { ...memory, gear: uniqueItems([...picked, ...typedItems(typed)]) };
  }
}

/** Whether `memory` holds an answer to question `id`. */
export function isAnswered(memory: ProducerMemory, id: OnboardingQuestionId): boolean {
  switch (id) {
    case "taste":
      return memory.taste.length > 0 || memory.artists.trim().length > 0;
    case "experience":
      return memory.experience !== null;
    case "goal":
      return memory.goal !== null;
    case "learn":
      return memory.learn.length > 0;
    case "gear":
      return memory.gear.length > 0;
  }
}

/** The label a stored experience level reads as. */
export function experienceLabel(level: ExperienceLevel): string {
  return EXPERIENCE_CHOICES.find(([, value]) => value === level)?.[0] ?? level;
}

/** The label a stored goal reads as. */
export function goalLabel(goal: ProducerGoal): string {
  return GOAL_CHOICES.find(([, value]) => value === goal)?.[0] ?? goal;
}

/** What Cue says once question `id` is answered (or skipped). */
export function acknowledgement(
  id: OnboardingQuestionId,
  memory: ProducerMemory,
  skipped: boolean,
): string {
  if (skipped) return "No problem, we can come back to that.";
  switch (id) {
    case "taste":
      return "Good to know what you're into. I'll keep it in mind when I suggest sounds and ideas.";
    case "experience":
      switch (memory.experience) {
        case "none":
          return "Everyone starts somewhere. I'll keep things simple and explain as we go.";
        case "played_around":
          return "That's a great place to start. I can help you take things further.";
        case "finished_a_few":
          return "Nice. Let's get a few more of them finished.";
        case "releases":
          return "Brilliant. I'll keep up, and skip the basics.";
        default:
          return "Got it.";
      }
    case "goal":
      return "Got it.";
    case "learn":
      return "I can really help with that.";
    case "gear":
      return memory.gear.length > 0
        ? "Nice. I can help you use those with Groove."
        : "Got it.";
  }
}

/** The welcome's first words, before the first question. */
export const WELCOME_TEXT = `Welcome to Groove! I'm ${ASSISTANT_NAME}, the producer beside you: I suggest real changes to your song and explain why they work, so you finish the tracks you start. I'd love to learn a bit about you so I can make my suggestions and advice yours. First:`;

/** What Cue says once the last question is settled. */
export const SAVED_TEXT =
  "That's everything. I've saved it to memory, and you can see or change it any time on the Memory page.";

/** The first lesson Cue suggests, from the producer's goal (GRV-43 builds them). */
export function suggestedLesson(goal: ProducerGoal | null): string {
  switch (goal) {
    case "first_track":
      return "Make your first beat";
    case "video_or_game":
      return "Build a loop that sets a mood";
    case "sound_design":
      return "Shape a sound from scratch";
    default:
      return "A five-minute tour of the studio";
  }
}

/**
 * Cue's offer of a first lesson, as it says it: on the welcome, where the
 * studio is still to open, or in the panel once it has.
 */
export function lessonOfferText(
  goal: ProducerGoal | null,
  where: "welcome" | "studio",
): string {
  const offer = `Want to start with a first lesson? From what you told me, I'd suggest "${suggestedLesson(goal)}".`;
  return where === "welcome" ? `${offer} Open the studio and we'll begin.` : offer;
}

/** The offer as a question, which waits in the panel once the studio opens. */
export function lessonOfferAsk(goal: ProducerGoal | null): AssistantAsk {
  return {
    id: "onboarding-lesson",
    question: `Start with a first lesson: "${suggestedLesson(goal)}"?`,
    options: [{ label: "Let's go" }, { label: "Not now" }],
    suggested: 0,
    multiSelect: false,
  };
}

/** One line of the "saved to memory" card. */
export interface MemoryLine {
  readonly field: string;
  readonly value: string;
}

/** What memory holds, one line per answered field, as the card lists it. */
export function memoryLines(memory: ProducerMemory): MemoryLine[] {
  const lines: MemoryLine[] = [];
  if (memory.taste.length > 0)
    lines.push({ field: "Music you love", value: memory.taste.join(", ") });
  if (memory.artists.trim())
    lines.push({ field: "Artists", value: memory.artists.trim() });
  if (memory.experience) {
    lines.push({ field: "Experience", value: experienceLabel(memory.experience) });
  }
  if (memory.goal) lines.push({ field: "Goal", value: goalLabel(memory.goal) });
  if (memory.learn.length > 0)
    lines.push({ field: "Learning", value: memory.learn.join(", ") });
  if (memory.gear.length > 0)
    lines.push({ field: "Gear", value: memory.gear.join(", ") });
  return lines;
}

/** The fixed choices the consented validation event may carry, and nothing else. */
export interface ValidationAnswers {
  readonly experience: ExperienceLevel | typeof UNANSWERED;
  readonly goal: ProducerGoal | typeof UNANSWERED;
  readonly learn: readonly LearnChipId[];
  readonly gear: readonly GearChipId[];
}

/**
 * Memory reduced to its fixed choices: the experience level, the goal, and
 * the learn and gear chips that were picked. Never artists, a genre, typed
 * text or a note: a typed learn or gear entry that is not a chip is left out.
 */
export function validationAnswers(memory: ProducerMemory): ValidationAnswers {
  const chips = <V extends string>(
    choices: readonly (readonly [string, V])[],
    items: readonly string[],
  ): V[] => choices.filter(([label]) => items.includes(label)).map(([, id]) => id);
  return {
    experience: memory.experience ?? UNANSWERED,
    goal: memory.goal ?? UNANSWERED,
    learn: chips(LEARN_CHOICES, memory.learn),
    gear: chips(GEAR_CHOICES, memory.gear),
  };
}
