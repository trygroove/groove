/**
 * The welcome's conversation (GRV-25): Cue's five questions, one at a time,
 * the producer's answers, and the two ways out, Skip to the studio and Open
 * the studio.
 *
 * It speaks the same language as the editor's conversation
 * (`useAssistantConversation`): its log is {@link ConversationEntry}s, its
 * question is a {@link PendingAsk} answered with an {@link AskAnswer}, so the
 * welcome draws it with the panel's question card, and opening the studio
 * hands the whole log to the new project's panel through the conversation
 * store, where it carries on.
 *
 * Every answer goes into memory as it is given; memory is saved to the
 * profile once the last question is settled, with onboarding marked
 * completed and every skipped question kept to ask later. Skip to the
 * studio saves the profile as skipped, with every question not yet answered
 * kept to ask later.
 *
 * Analytics: `onboarding_started`, one `onboarding_question_answered` per
 * question (which, and how), `onboarding_completed` or `onboarding_skipped`,
 * and, with the producer's consent, the validation event. Never an answer.
 */
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { Analytics } from "../analytics/analytics";
import {
  type AskAnswer,
  answerIsEmpty,
  answerMessage,
  pickedLabels,
} from "../assistant/ask";
import type { ProjectId } from "../domain/ids";
import {
  type ConversationStore,
  conversationStorageKey,
  createConversationStore,
} from "../editor/assistant/conversationStore";
import type { AskConversation } from "../editor/assistant/useAskDraft";
import type {
  ConversationEntry,
  PendingAsk,
} from "../editor/assistant/useAssistantConversation";
import {
  EMPTY_MEMORY,
  emptyProfile,
  ONBOARDING_QUESTION_IDS,
  type OnboardingQuestionId,
  type ProducerMemory,
  type ProducerProfile,
} from "../persistence/profileDocuments";
import type { ProfileRepository } from "../persistence/profileRepository";
import { type Clock, systemClock } from "../shared/clock";
import {
  acknowledgement,
  answerHow,
  applyAnswer,
  isAnswered,
  lessonOfferAsk,
  lessonOfferText,
  ONBOARDING_QUESTIONS,
  type OnboardingQuestion,
  SAVED_TEXT,
  WELCOME_TEXT,
} from "./questions";
import { logValidation } from "./validation";

/** Where the welcome is: asking, or done with memory saved (or failing to). */
export type OnboardingStage = "asking" | "saving" | "saved" | "save_failed";

export interface UseOnboardingOptions {
  readonly uid: Accessor<string | null>;
  readonly profiles: () => Promise<ProfileRepository>;
  readonly analytics: Pick<Analytics, "log" | "logFeatureFirstUse">;
  /** How long Cue "writes" before each reply, in ms; 0 in tests. */
  readonly replyDelayMs?: number;
  readonly clock?: Clock;
  /** Where the conversation is handed to the studio; this tab's by default. */
  readonly conversations?: ConversationStore;
  /**
   * Creates the producer's first project and returns its ID, or throws.
   * Opening the studio calls it.
   */
  readonly createProject: (uid: string) => Promise<ProjectId>;
}

export interface Onboarding extends AskConversation {
  readonly entries: Accessor<readonly ConversationEntry[]>;
  readonly stage: Accessor<OnboardingStage>;
  /** The question waiting, as the welcome's card names its text box. */
  readonly question: Accessor<OnboardingQuestion | null>;
  readonly memory: Accessor<ProducerMemory>;
  readonly consent: Accessor<boolean>;
  /** Ticks or unticks the box to share the answers' choices. */
  setConsent(consent: boolean): Promise<void>;
  /** Saves the profile again after a failed save. */
  retrySave(): Promise<void>;
  /** Saves onboarding as skipped. Resolves once it is, or has failed. */
  skipAll(): Promise<void>;
  /** Creates the first project with the conversation in it, and returns its ID. */
  openStudio(): Promise<ProjectId>;
  /** Whether Skip to the studio or Open the studio is under way. */
  readonly leaving: Accessor<boolean>;
  /**
   * Whether the last question has been settled: from then on the welcome is
   * finishing, and Skip to the studio is no longer offered.
   */
  readonly finished: Accessor<boolean>;
  /**
   * Logs `onboarding_started`, once: called when the profile's load confirms
   * onboarding is still to do, so someone sent on to the dashboard never
   * counts as starting it. `profile` is what that load read, which every
   * save builds on, so nothing it already held is lost.
   */
  started(profile: ProducerProfile | null): void;
}

const ANSWER_SCOPE = "Song";

export function useOnboarding(options: UseOnboardingOptions): Onboarding {
  const clock = options.clock ?? systemClock;
  const delay = options.replyDelayMs ?? 450;
  // The welcome opens with Cue's hello and its first question, already said.
  const first = ONBOARDING_QUESTIONS[0];
  const welcome: ConversationEntry = {
    kind: "reply",
    id: "entry-1",
    text: WELCOME_TEXT,
    streaming: false,
    stopped: false,
    ...(first ? { ask: first.ask } : {}),
  };
  const [entries, setEntries] = createSignal<readonly ConversationEntry[]>([welcome]);
  const [pendingAsk, setPendingAsk] = createSignal<PendingAsk | null>(
    first ? { ask: first.ask, replyId: welcome.id, asked: null } : null,
  );
  const [streaming, setStreaming] = createSignal(false);
  const [stage, setStage] = createSignal<OnboardingStage>("asking");
  const [memory, setMemory] = createSignal<ProducerMemory>(EMPTY_MEMORY);
  const [consent, setConsentSignal] = createSignal(false);
  // Plain copies of the two, for the logic that runs in the same tick as a
  // write: Solid 2 batches writes, so a signal read straight after its write
  // still returns the value from before it.
  let memoryNow: ProducerMemory = EMPTY_MEMORY;
  let consentNow = false;
  const [leaving, setLeaving] = createSignal(false);
  const [finished, setFinished] = createSignal(false);
  const skipped = new Set<OnboardingQuestionId>();
  /**
   * The profile a save builds on: what the welcome's load read, then what
   * each save wrote. `undefined` until a load has succeeded, and nothing is
   * saved before one has, so a save never writes over a profile it has not
   * seen.
   */
  let base: ProducerProfile | null | undefined;
  // Cue's replies wait a moment before they are said; leaving the welcome
  // cancels any still waiting.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });
  let questionIndex = 0;
  let nextId = 1;
  const id = () => {
    nextId += 1;
    return `entry-${nextId}`;
  };

  const append = (entry: ConversationEntry) =>
    setEntries((current) => [...current, entry]);

  /** Cue's reply: written after a moment, ending in `question` if there is one. */
  function reply(text: string, question: OnboardingQuestion | null, then?: () => void) {
    const say = () => {
      const replyId = id();
      append({
        kind: "reply",
        id: replyId,
        text,
        streaming: false,
        stopped: false,
        ...(question ? { ask: question.ask } : {}),
      });
      if (question) setPendingAsk({ ask: question.ask, replyId, asked: null });
      setStreaming(false);
      then?.();
    };
    if (delay <= 0) return say();
    setStreaming(true);
    const timer = setTimeout(() => {
      timers.delete(timer);
      say();
    }, delay);
    timers.add(timer);
  }

  const question = (): OnboardingQuestion | null => {
    const pending = pendingAsk();
    return pending
      ? (ONBOARDING_QUESTIONS.find((candidate) => candidate.ask.id === pending.ask.id) ??
          null)
      : null;
  };

  const answeredCount = () =>
    ONBOARDING_QUESTION_IDS.filter((qid) => isAnswered(memoryNow, qid)).length;

  /** The profile as it stands, built on what was loaded or last saved. */
  function profileNow(
    onboarding: ProducerProfile["onboarding"],
    on: ProducerProfile | null,
  ): ProducerProfile {
    const start = on ?? emptyProfile(clock.now());
    const later =
      onboarding === "skipped"
        ? ONBOARDING_QUESTION_IDS.filter((qid) => !isAnswered(memoryNow, qid))
        : ONBOARDING_QUESTION_IDS.filter((qid) => skipped.has(qid));
    return {
      ...start,
      onboarding,
      onboardedAt: start.onboardedAt ?? clock.now(),
      memory: memoryNow,
      laterQuestions: later,
      validationConsent: consentNow,
    };
  }

  /**
   * Saves run one after another, each building its profile only when its turn
   * comes, so a later save (a tick of the share box while the completed
   * profile is still on its way) carries everything the earlier one did and
   * lands after it.
   */
  let saveChain: Promise<unknown> = Promise.resolve();
  function queueSave(onboarding: ProducerProfile["onboarding"]): Promise<boolean> {
    const run = saveChain.then(() => save(onboarding));
    saveChain = run;
    return run;
  }

  async function save(onboarding: ProducerProfile["onboarding"]): Promise<boolean> {
    const uid = options.uid();
    if (!uid) return false;
    try {
      const repository = await options.profiles();
      // The welcome's own load has not landed (or failed): read the profile
      // now, and save nothing unless that read succeeds.
      if (base === undefined) {
        const loaded = await repository.loadProfile(uid);
        if (!loaded.ok) return false;
        base = loaded.profile;
      }
      const result = await repository.saveProfile(uid, profileNow(onboarding, base));
      if (!result.ok) return false;
      base = result.profile;
      return true;
    } catch {
      return false;
    }
  }

  async function saveCompleted(): Promise<void> {
    setStage("saving");
    setStage((await queueSave("completed")) ? "saved" : "save_failed");
  }

  /** The next question, or the end once there are none. */
  function advance(lastId: OnboardingQuestionId, wasSkipped: boolean): void {
    questionIndex += 1;
    const ack = acknowledgement(lastId, memoryNow, wasSkipped);
    const next = ONBOARDING_QUESTIONS[questionIndex] ?? null;
    if (next) {
      reply(ack, next);
      return;
    }
    setFinished(true);
    reply(`${ack} ${SAVED_TEXT}`, null, () => {
      // Skip to the studio is hidden from here, but a skip already under way
      // has saved its own outcome; completing would write over it.
      if (leaving()) return;
      options.analytics.log("onboarding_completed", { answered_count: answeredCount() });
      options.analytics.logFeatureFirstUse("onboarding");
      reply(lessonOfferText(memoryNow.goal, "welcome"), null);
      void saveCompleted();
    });
  }

  function answerAsk(answer: AskAnswer): boolean {
    const pending = pendingAsk();
    const current = question();
    if (!pending || !current || streaming() || answerIsEmpty(answer)) return false;
    setPendingAsk(null);
    memoryNow = applyAnswer(memoryNow, current.id, answer);
    setMemory(memoryNow);
    // Words typed to a single-choice question have no field to go in, so the
    // question is still unanswered: it is kept to ask later, as a skip is.
    const unanswered = !isAnswered(memoryNow, current.id);
    if (unanswered) skipped.add(current.id);
    options.analytics.log("onboarding_question_answered", {
      question_id: current.id,
      how: answerHow(answer),
    });
    const said = pickedLabels(pending.ask, answer).join(", ");
    const typed = answer.text.trim();
    append({
      kind: "message",
      id: id(),
      text: [said, typed].filter((part) => part.length > 0).join(" · "),
      scopeLabel: ANSWER_SCOPE,
      answers: pending.ask.question,
      wire: answerMessage(pending.ask, answer),
    });
    advance(current.id, unanswered);
    return true;
  }

  function dismissAsk(): void {
    const pending = pendingAsk();
    const current = question();
    if (!pending || !current || streaming()) return;
    setPendingAsk(null);
    skipped.add(current.id);
    options.analytics.log("onboarding_question_answered", {
      question_id: current.id,
      how: "skipped",
    });
    append({
      kind: "message",
      id: id(),
      text: "Skipped",
      scopeLabel: ANSWER_SCOPE,
      answers: pending.ask.question,
      wire: `[Skipped "${pending.ask.question}"]`,
    });
    advance(current.id, true);
  }

  async function setConsent(value: boolean): Promise<void> {
    consentNow = value;
    setConsentSignal(value);
    // The box is only drawn once the questions are done. A tick while the
    // completed profile is still saving queues a save behind that one.
    if (stage() === "asking") return;
    const ok = await queueSave("completed");
    setStage(ok ? "saved" : "save_failed");
    // Only the latest tick counts: a tick undone before its save landed
    // shares nothing.
    if (ok && value && consentNow) {
      logValidation(options.analytics, profileNow("completed", base ?? null));
    }
  }

  async function skipAll(): Promise<void> {
    if (leaving()) return;
    setLeaving(true);
    options.analytics.log("onboarding_skipped", { answered_count: answeredCount() });
    // Even a failed save lets them through: the welcome comes back next time.
    await queueSave("skipped");
  }

  /**
   * The log the studio's panel opens with: everything said here, the last
   * reply's offer worded for the studio and asking whether to start the
   * lesson.
   */
  function studioConversation(): {
    entries: ConversationEntry[];
    pendingReplyId: string;
  } {
    const kept = entries().filter(
      (entry) => entry.kind === "message" || entry.kind === "reply",
    );
    const last = kept.at(-1);
    const offer = lessonOfferAsk(memoryNow.goal);
    const text = lessonOfferText(memoryNow.goal, "studio");
    const offerReply: ConversationEntry = {
      kind: "reply",
      id: last?.kind === "reply" ? last.id : id(),
      text,
      streaming: false,
      stopped: false,
      ask: offer,
    };
    return {
      entries:
        last?.kind === "reply"
          ? [...kept.slice(0, -1), offerReply]
          : [...kept, offerReply],
      pendingReplyId: offerReply.id,
    };
  }

  async function openStudio(): Promise<ProjectId> {
    const uid = options.uid();
    if (!uid) throw new Error("Nobody is signed in");
    setLeaving(true);
    try {
      const projectId = await options.createProject(uid);
      const handed = studioConversation();
      (options.conversations ?? createConversationStore()).save(
        conversationStorageKey(uid, projectId),
        handed.entries,
        handed.pendingReplyId,
      );
      return projectId;
    } catch (error) {
      setLeaving(false);
      throw error;
    }
  }

  async function retrySave(): Promise<void> {
    await saveCompleted();
  }

  let startLogged = false;
  function started(profile: ProducerProfile | null): void {
    if (base === undefined) base = profile;
    if (startLogged) return;
    startLogged = true;
    options.analytics.log("onboarding_started", {});
  }

  return {
    entries,
    stage,
    question,
    memory,
    consent,
    setConsent,
    retrySave,
    skipAll,
    openStudio,
    leaving,
    finished,
    started,
    pendingAsk,
    streaming,
    answerAsk,
    dismissAsk,
  };
}
