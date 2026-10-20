/**
 * The conversation in the assistant's panel (GRV-26): what has been said,
 * the reply streaming now, and the three things a producer can do about it
 * (send, Stop, Try again). Closing the panel keeps it, and with a
 * {@link UseAssistantConversationOptions.persistence} key a reload of the
 * same project brings back what was said and a question still waiting
 * (GRV-42, `conversationStore.ts`).
 * What Groove keeps of it, for an account that said yes, is the gateway's
 * transcript (GRV-8), never read back here.
 *
 * Every turn goes through an {@link AssistantClient}, the one door to the
 * gateway, and each is stamped with the scope it was sent with. Nothing here
 * touches the project: a proposal in a reply is handed to `onProposal`
 * (the proposal card's controller, GRV-5), which is what can apply it.
 *
 * A reply may end in a question for the producer (`ask_producer`, GRV-42).
 * It stays pending, above the composer, until it is answered or dismissed;
 * a message typed meanwhile goes as usual and leaves it pending, so the
 * assistant has both. An answer is the next turn's message, and a newer
 * question takes the place of one still pending.
 *
 * Analytics: `assistant_message_sent` with the scope,
 * `assistant_suggestion_clicked` with the suggestion's ID, and
 * `assistant_ask_shown`/`assistant_ask_answered` with how many options a
 * question had and how it was answered, and `assistant_video_shown` once per
 * recommended video (GRV-16). Never the text of a message, a
 * reply, a question or an answer, and nothing about what is in scope.
 */
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import {
  type AskAnswer,
  type AssistantAsk,
  answerIsEmpty,
  answerMessage,
  pickedLabels,
} from "../../assistant/ask";
import type {
  AssistantClient,
  AssistantStreamEvent,
  AssistantTurnHandle,
} from "../../assistant/assistantClient";
import {
  type HistoryProposal,
  historyOf as historyOfEntries,
  MAX_MESSAGE_CHARS,
} from "../../assistant/history";
import type { AssistantLessonContext } from "../../assistant/lesson";
import { parseLessonCall, splitLessonCalls } from "../../assistant/lessonTool";
import {
  type AssistantMemoryContext,
  type MemoryProposal,
  parseRememberCall,
  splitMemoryProposals,
} from "../../assistant/memory";
import {
  type AssistantErrorDetails,
  type AssistantLibraryContext,
  type AssistantMessage,
  type AssistantProposal,
  type AssistantProposalPart,
  type AssistantToolCall,
  type AssistantTurnRequest,
  turnAnalytics,
} from "../../assistant/protocol";
import { splitRecommendations } from "../../assistant/recommendation";
import type { SessionHealth, SessionTurn } from "../../assistant/sessionHealth";
import type { ProposalOutcome, ReplyRating } from "../../assistant/transcripts";
import type { AssistantVideo } from "../../assistant/video";
import type { Project } from "../../domain/entities";
import type { ChapterId } from "../../lessons/ids";
import type { SuggestionId } from "../../projection/projectAnalysisProjection";
import { type Clock, systemClock } from "../../shared/clock";
import { type AssistantScope, scopedContext } from "./assistantScope";
import {
  type ConversationStore,
  createConversationStore,
  restoreOrigin,
  type StoredConversation,
  type StoredOrigin,
} from "./conversationStore";

/** What a turn was asked: the producer's words and the scope they were sent with. */
export interface TurnOrigin {
  /** The producer's words, as the log shows them. */
  readonly text: string;
  /** For an answer to a question (GRV-42): the question it answers. */
  readonly answers?: string;
  /** What the turn sent, when it is not {@link text} (an answer's full wording). */
  readonly wire?: string;
  readonly scope: AssistantScope;
  /**
   * How many changes made elsewhere had been adopted when the turn was sent
   * (`remoteChanges`), so a proposal that arrives after one more is known to
   * be out of date (GRV-5).
   */
  readonly remoteChanges: number;
  /** The ID the transcript files the turn under (GRV-8), when it has one. */
  readonly turnId?: string;
  /**
   * When the turn was sent, ms since the epoch, so the first part of a
   * streamed proposal can say how long it took (GRV-144). A turn restored
   * from before a reload has none.
   */
  readonly sentAt?: number;
  /**
   * Which turn of which session it was (GRV-103), when a session health
   * detector is counting. A turn restored from before a reload has none.
   */
  readonly sessionTurn?: SessionTurn;
  /**
   * The turn was asked before a reload (GRV-135): its cards were kept with
   * the conversation and handed back, and a proposal of it is out of date.
   */
  readonly restored?: boolean;
}

/** One thing in the conversation's log. */
export type ConversationEntry =
  /** The producer's message, stamped with the scope it was sent with. */
  | {
      readonly kind: "message";
      readonly id: string;
      /** What the log shows. */
      readonly text: string;
      readonly scopeLabel: string;
      /**
       * An answer to a question (GRV-42): the question it answers. The log
       * shows the answer under it, and the turn sends {@link wire}.
       */
      readonly answers?: string;
      /** What the turn sends, when it is not {@link text}. */
      readonly wire?: string;
    }
  /** The assistant's reply: streaming, finished, stopped or failed part-way. */
  | {
      readonly kind: "reply";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
      readonly stopped: boolean;
      /**
       * The turn failed after writing this much. It stays on screen above the
       * error, but it is not an answer: the next turn does not resend it, and
       * Try again replaces it.
       */
      readonly failed?: boolean;
      /** The question the reply ended in (GRV-42), resent with its text. */
      readonly ask?: AssistantAsk;
      /** The turn's transcript ID (GRV-8), so a rating reaches its record. */
      readonly turnId?: string;
      /** Its turn of this session (GRV-103); see {@link TurnOrigin.sessionTurn}. */
      readonly sessionTurn?: SessionTurn;
      /** The producer's thumbs up or down on it (GRV-103). */
      readonly rating?: ReplyRating;
      /**
       * What became of the proposal it made, when it made one (GRV-150), so
       * the next turn tells the model whether the change is in the song.
       */
      readonly proposal?: HistoryProposal;
    }
  /**
   * A change the reply proposes, as the gateway returned it, and the turn
   * that asked for it, so Refresh can ask again in the same scope (GRV-5).
   */
  | {
      readonly kind: "proposal";
      readonly id: string;
      readonly proposal: AssistantProposal;
      readonly origin: TurnOrigin;
      /** The reply that made it, which carries its outcome (GRV-150). */
      readonly replyId: string;
    }
  /**
   * A pack and sounds the reply recommends (GRV-23), as the model named them,
   * with the library the turn was sent with, which is what they are checked
   * against, and the turn that asked, so Refresh can ask again.
   */
  | {
      readonly kind: "recommendation";
      readonly id: string;
      readonly call: AssistantToolCall;
      readonly library: AssistantLibraryContext | null;
      readonly origin: TurnOrigin;
    }
  /**
   * Something the reply proposes Coproducer remember about the producer (GRV-25):
   * nothing is saved until they confirm it on its card.
   */
  | {
      readonly kind: "memory";
      readonly id: string;
      readonly proposal: MemoryProposal;
    }
  /**
   * A tutorial video the reply recommends (GRV-16), checked with YouTube by
   * the gateway. A still card until the producer presses play.
   */
  | {
      readonly kind: "video";
      readonly id: string;
      readonly video: AssistantVideo;
    }
  /** The turn failed. The song is untouched. */
  | {
      readonly kind: "error";
      readonly id: string;
      readonly error: AssistantErrorDetails;
      /** What Try again resends. */
      readonly request: AssistantTurnRequest;
      readonly origin: TurnOrigin;
      /** The failed turn's partial reply, which Try again replaces. */
      readonly replyId?: string;
      /**
       * The turn had streamed parts of a proposal before it failed (GRV-144):
       * their card offers Try again for the rest, so this entry does not.
       */
      readonly partial?: boolean;
    };

/**
 * How an answer came: an option picked, the producer's own words, or the
 * change made in the editor (an option's `doneWhen`).
 */
export type AskAnswerHow = "pick" | "text" | "did_it";

/** A question waiting for the producer (GRV-42). */
export interface PendingAsk {
  readonly ask: AssistantAsk;
  /** The reply that asked it. */
  readonly replyId: string;
  /**
   * The committed project when it was asked, which an option's `doneWhen`
   * is read against: only a change since then answers it.
   */
  readonly asked: Project | null;
}

export interface UseAssistantConversationOptions {
  readonly client: () => Promise<AssistantClient>;
  readonly project: Accessor<Project | null>;
  readonly scope: Accessor<AssistantScope>;
  /**
   * The committed project, never a preview of it, for what a question is
   * asked against (GRV-42). Defaults to {@link project}.
   */
  readonly committedProject?: () => Project | null;
  /** Whether a signed-in account is here to talk (ADR 0006 decision 4). */
  readonly canSend: Accessor<boolean>;
  readonly analytics: () => Analytics;
  /**
   * Hears each proposal as it arrives, under its entry's ID (GRV-5). For a
   * turn that streamed its parts (GRV-144), the entry is the one the parts
   * came under, and this is the whole proposal at the end of the turn.
   */
  readonly onProposal?: (
    entryId: string,
    proposal: AssistantProposal,
    origin: TurnOrigin,
  ) => void;
  /**
   * Hears each part of a proposal as the gateway accepts it (GRV-144), under
   * the entry the turn's parts share, which the first part appends, with the
   * project revision the turn was sent against.
   */
  readonly onProposalPart?: (
    entryId: string,
    part: AssistantProposalPart,
    origin: TurnOrigin,
    baseRevision: number,
  ) => void;
  /** Hears how a turn that streamed parts ended (GRV-144). */
  readonly onProposalEnded?: (
    entryId: string,
    ending: "ended" | "stopped" | "failed",
  ) => void;
  /** What stamps when each turn was sent (GRV-144); the real clock by default. */
  readonly clock?: Clock;
  /** How many changes made elsewhere the editor has adopted so far; 0 without one. */
  readonly remoteChanges?: () => number;
  /**
   * The library a turn may recommend from, for `project` (GRV-23), or null
   * when it has not loaded. Without it, turns carry no library and the
   * assistant cannot recommend.
   */
  readonly library?: (project: Project) => Promise<AssistantLibraryContext | null>;
  /**
   * What Coproducer remembers about the producer, sent with every turn (GRV-25), or
   * null when there is nothing to send. Without it turns carry no memory and
   * Coproducer cannot propose adding to it.
   */
  readonly memory?: () => AssistantMemoryContext | null;
  /**
   * The lesson under way (GRV-43), sent with every turn while there is one,
   * or null outside a lesson.
   */
  readonly lesson?: () => AssistantLessonContext | null;
  /** Hears that Coproducer started a lesson, and which chapter (GRV-43). */
  readonly onStartLesson?: (chapter: ChapterId) => void;
  /** Hears each memory proposal as it arrives, under its entry's ID (GRV-25). */
  readonly onMemoryProposal?: (entryId: string, proposal: MemoryProposal) => void;
  /** Hears that Coproducer asked a question skipped in onboarding (GRV-25). */
  readonly onMemoryQuestionAsked?: (
    question: NonNullable<AssistantAsk["memoryQuestion"]>,
  ) => void;
  /** Hears each recommendation as it arrives, under its entry's ID (GRV-23). */
  readonly onRecommendation?: (
    entryId: string,
    call: AssistantToolCall,
    library: AssistantLibraryContext | null,
    origin: TurnOrigin,
  ) => void;
  /**
   * Where the conversation is kept across a reload (GRV-42): the key for this
   * account and project (`conversationStorageKey`), or null while there is
   * none, and the store, this tab's session storage by default. Without it
   * the conversation lives in memory only.
   */
  readonly persistence?: {
    readonly key: Accessor<string | null>;
    readonly store?: ConversationStore;
    /**
     * Whether the proposal or sound card in an entry has been decided, so it
     * is not kept (GRV-135). Reactive. Without it every card is kept.
     */
    readonly decided?: (entryId: string) => boolean;
  };
  /**
   * What the transcript files each turn under (GRV-8): the open project's ID
   * and whether this browser is internal traffic. Without it, turns carry no
   * session and are never kept.
   */
  readonly session?: () => { readonly projectId: string; readonly internal: boolean };
  /** Makes the conversation's and each turn's ID; random by default. */
  readonly newId?: () => string;
  /**
   * Hears each message sent and each turn's end (GRV-103), and is reset when
   * another project's conversation takes this one's place.
   */
  readonly health?: SessionHealth;
}

export interface AssistantConversation {
  readonly entries: Accessor<readonly ConversationEntry[]>;
  /** Whether a reply is on its way. */
  readonly streaming: Accessor<boolean>;
  /**
   * Sends `text` with the scope on the chip. Returns whether it went: not
   * while a reply streams, with nothing to say, or with no account.
   */
  send(text: string, suggestion?: SuggestionId): boolean;
  /** Stops the reply on its way, at the gateway too. */
  stop(): void;
  /**
   * Resends the turn the last error ended, if it may be retried and nothing
   * is streaming. An earlier error, with the conversation moved on past it,
   * cannot be retried.
   */
  retry(): boolean;
  /** Whether {@link retry} would resend this entry's turn now. */
  canRetry(entry: ConversationEntry): boolean;
  /**
   * Asks for the rest of the proposal in entry `entryId`, whose turn failed
   * partway (GRV-144): its words and scope again, against the song as it is
   * now, which has whatever parts the producer applied, with a note naming
   * the parts `shown` and which of them were applied. Returns whether it
   * went: not while a reply streams, nor with no account.
   */
  continueProposal(entryId: string, shown: readonly ShownPart[]): boolean;
  /**
   * Asks again for the proposal or recommendation in entry `entryId`, with
   * its words and its scope, against the song as it is now (GRV-5's Refresh).
   * Returns whether it went: not while a reply streams, nor with no account.
   * `shown` is a streamed card's parts (GRV-144): when any was applied, the
   * message names them, as Try again's does.
   */
  refresh(entryId: string, shown?: readonly ShownPart[]): boolean;
  /** The question waiting for an answer, if there is one (GRV-42). */
  readonly pendingAsk: Accessor<PendingAsk | null>;
  /**
   * Records what became of the proposal in entry `entryId` on the reply that
   * made it (GRV-150), so every later turn resends it beside the reply.
   */
  recordProposalOutcome(entryId: string, outcome: ProposalOutcome): void;
  /**
   * Answers the pending question: the options picked and/or the typed text,
   * sent as the next turn. Returns whether it went: not while a reply
   * streams, with nothing said, or with no account.
   */
  answerAsk(answer: AskAnswer): boolean;
  /** Puts the pending question away unanswered. Nothing is sent. */
  dismissAsk(): void;
  /**
   * Sets, or with `null` clears, the rating on reply `replyId` (GRV-103).
   * Returns the reply as it was, or null when there is no such reply.
   */
  rateReply(
    replyId: string,
    rating: ReplyRating | null,
  ): Extract<ConversationEntry, { kind: "reply" }> | null;
}

/** A part of a streamed proposal the card showed (GRV-144), as Try again tells the model of it. */
export interface ShownPart {
  /** Its line, as the card reads it ("Bass · 1 bar"). */
  readonly text: string;
  /** Whether the producer applied it, so the song has it now. */
  readonly applied: boolean;
  /**
   * For a part applied: the producer has since removed what it made (deleted
   * the track it added), so the song no longer has it.
   */
  readonly removed?: boolean;
}

/**
 * What Try again for the rest of a proposal adds to the producer's words
 * (GRV-144). The history drops a failed turn, so the note is the model's only
 * record of what it showed: the parts applied are in the song it is sent
 * with, and those not applied are withdrawn from their card, so the model
 * proposes again only what the song still needs.
 */
export function continueNote(shown: readonly ShownPart[]): string {
  return shownNote(
    "[Continue] Your last reply stopped partway, after these parts of its proposal.",
    shown,
  );
}

/**
 * What Refresh on a streamed proposal some of whose parts were applied adds
 * to the producer's words (GRV-144): the song it is sent with has those parts
 * already, so without the note the model would propose them a second time
 * (a second Bass track).
 */
export function refreshNote(shown: readonly ShownPart[]): string {
  return shownNote(
    "[Refresh] The song changed under your last proposal, after I applied some of its parts.",
    shown,
  );
}

function shownNote(lead: string, shown: readonly ShownPart[]): string {
  const texts = (keep: (part: ShownPart) => boolean) =>
    shown.filter(keep).map((part) => part.text);
  const applied = texts((part) => part.applied && part.removed !== true);
  const removed = texts((part) => part.applied && part.removed === true);
  const withdrawn = texts((part) => !part.applied);
  const list = (items: readonly string[]) => items.map((text) => `- ${text}`).join("\n");
  return [
    lead,
    applied.length > 0
      ? `Applied, so the song has them now; don't propose them again:\n${list(applied)}`
      : null,
    removed.length > 0
      ? `Applied, then removed by me, so the song no longer has them:\n${list(removed)}`
      : null,
    withdrawn.length > 0
      ? `Not applied, and withdrawn; propose them again only if the song still needs them:\n${list(withdrawn)}`
      : null,
    "The project description is the whole song as it is now, with every track's ID: build on what it lists. Propose only what is still missing for my request.",
  ]
    .filter(Boolean)
    .join("\n");
}

// What a turn resends is built in `src/assistant/history.ts`, so that
// code outside the editor (GRV-108) builds it the same way.
export { MAX_MESSAGE_CHARS };

/** The conversation so far, as the next turn resends it (`historyOf` in `src/assistant/history.ts`). */
export const historyOf: (entries: readonly ConversationEntry[]) => AssistantMessage[] =
  historyOfEntries;

export function useAssistantConversation(
  options: UseAssistantConversationOptions,
): AssistantConversation {
  const [entries, setEntries] = createSignal<readonly ConversationEntry[]>([]);
  const [streaming, setStreaming] = createSignal(false);
  const [pendingAsk, setPendingAsk] = createSignal<PendingAsk | null>(null);
  let nextId = 0;
  const id = () => {
    nextId += 1;
    return `entry-${nextId}`;
  };
  const newId = options.newId ?? (() => crypto.randomUUID());
  const clock = options.clock ?? systemClock;
  /**
   * What the conversation's kept turns are filed under: one per panel
   * session, and a new one when another project's conversation takes this
   * one's place, so a conversation is one session (GRV-103).
   */
  let conversationId = newId();
  /** The turn on its way: Stop goes to it. */
  let inFlight: AssistantTurnHandle | null = null;
  // Leaving the editor stops the reply on its way, at the gateway too, rather
  // than leaving it to write into a conversation nobody can see.
  onCleanup(() => inFlight?.stop());
  if (options.persistence) keep(options.persistence);

  const append = (entry: ConversationEntry) =>
    setEntries((current) => [...current, entry]);
  const update = (
    entryId: string,
    change: (entry: ConversationEntry) => ConversationEntry | null,
  ) =>
    setEntries((current) =>
      current.flatMap((entry) => {
        if (entry.id !== entryId) return [entry];
        const next = change(entry);
        return next ? [next] : [];
      }),
    );

  /**
   * The request with the library added, when the turn has none yet and one
   * loads. A library that will not load sends the turn without one.
   */
  async function withLibrary(
    request: AssistantTurnRequest,
  ): Promise<AssistantTurnRequest> {
    const project = options.project();
    if (request.library || !options.library || !project) return request;
    try {
      const library = await options.library(project);
      return library ? { ...request, library } : request;
    } catch {
      return request;
    }
  }

  function startTurn(asked: AssistantTurnRequest, origin: TurnOrigin): void {
    // What Try again resends: the request as it went, library and all.
    let request = asked;
    const replyId = id();
    append({
      kind: "reply",
      id: replyId,
      text: "",
      streaming: true,
      stopped: false,
      ...(origin.turnId ? { turnId: origin.turnId } : {}),
      ...(origin.sessionTurn !== undefined ? { sessionTurn: origin.sessionTurn } : {}),
    });
    setStreaming(true);
    let ended = false;
    let handle: AssistantTurnHandle | null = null;
    /** The entry the turn's streamed proposal parts share (GRV-144). */
    let partsEntryId: string | null = null;

    /** Whether the reply is still in the log when the turn ends. */
    let replyKept = false;
    const finishReply = (ending: "done" | "stopped" | "failed") =>
      update(replyId, (entry) => {
        if (entry.kind !== "reply") return entry;
        // A reply that never wrote a word is not one, unless it was stopped
        // or it asked a question.
        if (entry.text.length === 0 && !entry.ask && ending !== "stopped") return null;
        replyKept = true;
        return {
          ...entry,
          streaming: false,
          stopped: ending === "stopped",
          ...(ending === "failed" ? { failed: true } : {}),
        };
      });

    const onEvent = (event: AssistantStreamEvent) => {
      if (ended) return;
      if (event.type === "error" || event.type === "done") {
        ended = true;
        inFlight = null;
        if (origin.sessionTurn !== undefined) {
          options.health?.turnEnded(
            event.type === "error"
              ? { kind: "error", code: event.error.code }
              : { kind: "done", stopped: event.stopped, stopReason: event.stopReason },
            origin.sessionTurn,
          );
        }
        if (partsEntryId) {
          options.onProposalEnded?.(
            partsEntryId,
            event.type === "error" ? "failed" : event.stopped ? "stopped" : "ended",
          );
        }
      }
      switch (event.type) {
        case "text":
          update(replyId, (entry) =>
            entry.kind === "reply" ? { ...entry, text: entry.text + event.text } : entry,
          );
          return;
        case "part": {
          // The first part makes the turn's proposal entry; each one after
          // joins it, so the card fills in part by part (GRV-144).
          const entryId = partsEntryId ?? id();
          if (partsEntryId === null) {
            partsEntryId = entryId;
            append({
              kind: "proposal",
              id: entryId,
              proposal: {
                baseRevision: request.projectRevision,
                toolsetVersion: event.part.toolsetVersion,
                calls: [event.part.call],
              },
              origin,
              replyId,
            });
            update(replyId, (entry) =>
              entry.kind === "reply" ? { ...entry, proposal: "pending" } : entry,
            );
          } else {
            update(entryId, (entry) =>
              entry.kind === "proposal"
                ? {
                    ...entry,
                    proposal: {
                      ...entry.proposal,
                      calls: [...entry.proposal.calls, event.part.call],
                    },
                  }
                : entry,
            );
          }
          options.onProposalPart?.(entryId, event.part, origin, request.projectRevision);
          return;
        }
        case "proposal": {
          // A lesson to start (GRV-43), memory proposals (GRV-25) and
          // recommendations (GRV-23) come back among the proposal's calls:
          // a lesson starts in the panel, the rest are each a card of their
          // own, and the changes, if any, are one. A lesson or memory call
          // that does not parse is dropped: it would have changed nothing.
          const started = splitLessonCalls(event.proposal);
          for (const call of started.lessons) {
            const chapter = parseLessonCall(call);
            if (chapter) options.onStartLesson?.(chapter);
          }
          if (!started.proposal) return;
          const remembered = splitMemoryProposals(started.proposal);
          for (const call of remembered.memory) {
            const proposal = parseRememberCall(call);
            if (!proposal) continue;
            const entryId = id();
            append({ kind: "memory", id: entryId, proposal });
            options.onMemoryProposal?.(entryId, proposal);
          }
          if (!remembered.proposal) return;
          const split = splitRecommendations(remembered.proposal);
          if (split.proposal && partsEntryId) {
            // The parts' entry takes the whole proposal in their place.
            const whole = split.proposal;
            update(partsEntryId, (entry) =>
              entry.kind === "proposal" ? { ...entry, proposal: whole } : entry,
            );
            options.onProposal?.(partsEntryId, whole, origin);
          } else if (split.proposal) {
            const entryId = id();
            append({
              kind: "proposal",
              id: entryId,
              proposal: split.proposal,
              origin,
              replyId,
            });
            update(replyId, (entry) =>
              entry.kind === "reply" ? { ...entry, proposal: "pending" } : entry,
            );
            options.onProposal?.(entryId, split.proposal, origin);
          }
          for (const call of split.recommendations) {
            const entryId = id();
            const library = request.library ?? null;
            append({ kind: "recommendation", id: entryId, call, library, origin });
            options.onRecommendation?.(entryId, call, library, origin);
          }
          return;
        }
        case "videos":
          for (const video of event.videos) {
            append({ kind: "video", id: id(), video });
            options.analytics().log("assistant_video_shown", {});
          }
          return;
        case "ask":
          update(replyId, (entry) =>
            entry.kind === "reply" ? { ...entry, ask: event.ask } : entry,
          );
          // A newer question takes the place of one still waiting.
          setPendingAsk({
            ask: event.ask,
            replyId,
            asked: options.committedProject?.() ?? options.project(),
          });
          if (event.ask.memoryQuestion) {
            options.onMemoryQuestionAsked?.(event.ask.memoryQuestion);
          }
          options.analytics().log("assistant_ask_shown", {
            option_count: event.ask.options.length,
            multi_select: event.ask.multiSelect,
            has_suggestion: event.ask.suggested !== undefined,
          });
          return;
        case "error":
          finishReply("failed");
          append({
            kind: "error",
            id: id(),
            error: event.error,
            request,
            origin,
            ...(replyKept ? { replyId } : {}),
            ...(partsEntryId ? { partial: true } : {}),
          });
          setStreaming(false);
          return;
        case "done":
          finishReply(event.stopped ? "stopped" : "done");
          setStreaming(false);
      }
    };

    // Stop works before the client has even loaded: the turn ends at once
    // and is never sent.
    inFlight = {
      stop() {
        if (handle) handle.stop();
        else
          onEvent({
            type: "done",
            stopped: true,
            stopReason: null,
            requestsRemaining: null,
          });
      },
    };
    Promise.all([options.client(), withLibrary(asked)]).then(
      ([client, prepared]) => {
        request = prepared;
        if (!ended) handle = client.send(prepared, onEvent);
      },
      () =>
        onEvent({
          type: "error",
          error: { code: "provider_unavailable", retryable: true },
        }),
    );
  }

  /** Whether a new turn may start now. */
  const canStart = (): boolean =>
    !streaming() && options.canSend() && options.project() !== null;

  /**
   * Sends one message as a new turn in `scope`: the message, its analytics
   * and its turn. `wire` is what the turn says when the log shows something
   * else (an answer to a question).
   */
  function sendMessage(
    message: Pick<TurnOrigin, "text" | "answers" | "wire">,
    scope: AssistantScope,
  ): void {
    const project = options.project();
    if (!project) return;
    const said = message.wire ?? message.text;
    const memory = options.memory?.() ?? null;
    const lesson = options.lesson?.() ?? null;
    const where = options.session?.();
    const turnId = where ? newId() : undefined;
    const analytics = options.analytics();
    const request: AssistantTurnRequest = {
      projectRevision: project.metadata.revision,
      messages: [
        ...historyOf(entries()),
        { role: "user", text: said.slice(0, MAX_MESSAGE_CHARS) },
      ],
      context: scopedContext(project, scope),
      ...(memory ? { memory } : {}),
      ...(lesson ? { lesson } : {}),
      ...(where && turnId
        ? {
            session: {
              conversationId,
              turnId,
              projectId: where.projectId,
              internal: where.internal,
            },
          }
        : {}),
      // Whether the gateway may trace the turn, and the session it joins
      // (GRV-126). Never sent to the provider.
      analytics: turnAnalytics(analytics.productAnalyticsAllowed, analytics.sessionId()),
    };
    append({ kind: "message", id: id(), scopeLabel: scope.label, ...message });
    const sessionTurn = options.health?.messageSent();
    analytics.log("assistant_message_sent", { scope: scope.catalogScope });
    analytics.logFeatureFirstUse("assistant_message");
    startTurn(request, {
      ...message,
      scope,
      sentAt: clock.now(),
      remoteChanges: options.remoteChanges?.() ?? 0,
      ...(turnId ? { turnId } : {}),
      ...(sessionTurn !== undefined ? { sessionTurn } : {}),
    });
  }

  function send(text: string, suggestion?: SuggestionId): boolean {
    const message = text.trim();
    if (!canStart() || message.length === 0) return false;
    if (suggestion) {
      options
        .analytics()
        .log("assistant_suggestion_clicked", { suggestion_id: suggestion });
    }
    sendMessage({ text: message }, options.scope());
    return true;
  }

  function continueProposal(entryId: string, shown: readonly ShownPart[]): boolean {
    const entry = entries().find((candidate) => candidate.id === entryId);
    if (entry?.kind !== "proposal" || !canStart()) return false;
    const { text, answers, wire, scope } = entry.origin;
    sendMessage(
      { text, answers, wire: `${wire ?? text}\n\n${continueNote(shown)}` },
      scope,
    );
    return true;
  }

  function refresh(entryId: string, shown?: readonly ShownPart[]): boolean {
    const entry = entries().find((candidate) => candidate.id === entryId);
    if (entry?.kind !== "proposal" && entry?.kind !== "recommendation") return false;
    if (!canStart()) return false;
    const { text, answers, wire, scope } = entry.origin;
    // Parts already applied are named, so the new proposal does not repeat them.
    const noted =
      shown?.some((part) => part.applied) === true
        ? `${wire ?? text}\n\n${refreshNote(shown)}`
        : wire;
    sendMessage({ text, answers, wire: noted }, scope);
    return true;
  }

  function logAnswered(
    ask: AssistantAsk,
    how: AskAnswerHow | "dismissed",
    picked: readonly number[],
  ): void {
    const analytics = options.analytics();
    analytics.log("assistant_ask_answered", {
      how,
      option_count: ask.options.length,
      suggested_taken: ask.suggested !== undefined && picked.includes(ask.suggested),
    });
    analytics.logFeatureFirstUse("assistant_ask");
  }

  function answerAsk(answer: AskAnswer): boolean {
    const pending = pendingAsk();
    if (!pending || !canStart() || answerIsEmpty(answer)) return false;
    const { ask } = pending;
    const labels = pickedLabels(ask, answer);
    const typed = answer.text.trim();
    setPendingAsk(null);
    const how: AskAnswerHow =
      labels.length === 0 ? "text" : answer.byDoing ? "did_it" : "pick";
    logAnswered(ask, how, answer.picked);
    const said = labels.join(", ") + (how === "did_it" ? " (done in the editor)" : "");
    sendMessage(
      {
        text: [said, typed].filter((part) => part.length > 0).join(" · "),
        answers: ask.question,
        wire: answerMessage(ask, answer),
      },
      options.scope(),
    );
    return true;
  }

  function dismissAsk(): void {
    const pending = pendingAsk();
    if (!pending) return;
    setPendingAsk(null);
    logAnswered(pending.ask, "dismissed", []);
  }

  function stop(): void {
    inFlight?.stop();
  }

  function rateReply(replyId: string, rating: ReplyRating | null) {
    const before = entries().find((entry) => entry.id === replyId);
    if (before?.kind !== "reply") return null;
    update(replyId, (entry) => {
      if (entry.kind !== "reply") return entry;
      const { rating: _previous, ...rest } = entry;
      return rating ? { ...rest, rating } : rest;
    });
    return before;
  }

  function recordProposalOutcome(entryId: string, outcome: ProposalOutcome): void {
    const card = entries().find((entry) => entry.id === entryId);
    if (card?.kind !== "proposal") return;
    update(card.replyId, (entry) =>
      entry.kind === "reply" ? { ...entry, proposal: outcome } : entry,
    );
  }

  function canRetry(entry: ConversationEntry): boolean {
    return (
      entry.kind === "error" &&
      entry.error.retryable &&
      !entry.partial &&
      !streaming() &&
      entries().at(-1)?.id === entry.id
    );
  }

  function retry(): boolean {
    const last = entries().at(-1);
    if (last?.kind !== "error" || !canRetry(last)) return false;
    // The retried turn's reply takes the place of the error and of whatever
    // the failed reply had written, so the message is answered once.
    const stale = new Set([last.id, last.replyId]);
    setEntries((current) => current.filter((entry) => !stale.has(entry.id)));
    startTurn(last.request, last.origin);
    return true;
  }

  /**
   * Restores the conversation kept under the key once the project has loaded
   * (a question's options are read against it, a card's scope is found in
   * it), then keeps every change. A new key (another project) brings back its
   * own conversation, or none.
   */
  function keep(
    persistence: NonNullable<UseAssistantConversationOptions["persistence"]>,
  ) {
    const store = persistence.store ?? createConversationStore();
    const loaded = createMemo(() => options.project() !== null);
    const isDecided = persistence.decided ?? (() => false);
    let restoredKey: string | null = null;
    createEffect(
      () => {
        // A streaming reply changes with every word: it is kept when the turn
        // starts and when it ends, not word by word.
        const current = streaming() ? untrack(entries) : entries();
        return {
          key: persistence.key(),
          loaded: loaded(),
          pending: pendingAsk(),
          entries: current,
          // Deciding a card drops it from what is kept (GRV-135).
          decided: new Set(
            current
              .filter(
                (entry) =>
                  (entry.kind === "proposal" || entry.kind === "recommendation") &&
                  isDecided(entry.id),
              )
              .map((entry) => entry.id),
          ),
        };
      },
      ({ key, loaded: ready, pending, entries: current, decided }) => {
        if (key === null) return;
        if (key === restoredKey) {
          store.save(key, current, pending?.replyId ?? null, (entryId) =>
            decided.has(entryId),
          );
          return;
        }
        if (!ready) return;
        const switching = restoredKey !== null;
        restoredKey = key;
        if (switching) {
          inFlight?.stop();
          // Another project's conversation is a new conversation and session.
          conversationId = newId();
          options.health?.reset();
        }
        const stored = store.load(key);
        if (!stored && !switching) return;
        const restored = stored ? restoredEntries(stored) : [];
        setEntries(restored);
        for (const entry of restored) {
          const n = Number(/^entry-(\d+)$/.exec(entry.id)?.[1] ?? 0);
          if (n > nextId) nextId = n;
        }
        setPendingAsk(
          stored?.pendingAsk
            ? {
                ...stored.pendingAsk,
                // What it was asked against went with the reload: only a change
                // from here on answers it by doing.
                asked: untrack(() => options.committedProject?.() ?? options.project()),
              }
            : null,
        );
        // The cards still waiting go back to their controllers, in order, so
        // a turn's cards come up one at a time as before (GRV-135).
        for (const entry of restored) {
          if (entry.kind === "proposal") {
            options.onProposal?.(entry.id, entry.proposal, entry.origin);
          } else if (entry.kind === "recommendation") {
            options.onRecommendation?.(entry.id, entry.call, entry.library, entry.origin);
          }
        }
      },
    );
  }

  /**
   * A stored conversation's entries, its cards' turns found again in the
   * song as it is now: one origin per turn, which its cards share.
   */
  function restoredEntries(stored: StoredConversation): ConversationEntry[] {
    const project = untrack(options.project);
    const origins = new Map<StoredOrigin, TurnOrigin>();
    const originOf = (kept: StoredOrigin): TurnOrigin | null => {
      if (!project) return null;
      let origin = origins.get(kept);
      if (!origin) {
        origin = restoreOrigin(kept, project);
        origins.set(kept, origin);
      }
      return origin;
    };
    return stored.entries.flatMap((entry): ConversationEntry[] => {
      if (entry.kind === "message" || entry.kind === "reply") return [entry];
      const origin = originOf(entry.origin);
      return origin ? [{ ...entry, origin }] : [];
    });
  }

  return {
    entries,
    streaming,
    send,
    stop,
    retry,
    canRetry,
    continueProposal,
    refresh,
    recordProposalOutcome,
    pendingAsk,
    answerAsk,
    dismissAsk,
    rateReply,
  };
}
