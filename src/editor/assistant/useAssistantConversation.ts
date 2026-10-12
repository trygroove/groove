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
  askTranscript,
  pickedLabels,
} from "../../assistant/ask";
import type {
  AssistantClient,
  AssistantStreamEvent,
  AssistantTurnHandle,
} from "../../assistant/assistantClient";
import { ASSISTANT_REQUEST_LIMITS } from "../../assistant/config";
import type {
  AssistantErrorDetails,
  AssistantLibraryContext,
  AssistantMessage,
  AssistantProposal,
  AssistantToolCall,
  AssistantTurnRequest,
} from "../../assistant/protocol";
import { splitRecommendations } from "../../assistant/recommendation";
import type { AssistantVideo } from "../../assistant/video";
import type { Project } from "../../domain/entities";
import type { SuggestionId } from "../../projection/projectAnalysisProjection";
import { type AssistantScope, scopedContext } from "./assistantScope";
import { type ConversationStore, createConversationStore } from "./conversationStore";

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
  /** Hears each proposal as it arrives, under its entry's ID (GRV-5). */
  readonly onProposal?: (
    entryId: string,
    proposal: AssistantProposal,
    origin: TurnOrigin,
  ) => void;
  /** How many changes made elsewhere the editor has adopted so far; 0 without one. */
  readonly remoteChanges?: () => number;
  /**
   * The library a turn may recommend from, for `project` (GRV-23), or null
   * when it has not loaded. Without it, turns carry no library and the
   * assistant cannot recommend.
   */
  readonly library?: (project: Project) => Promise<AssistantLibraryContext | null>;
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
  };
  /**
   * What the transcript files each turn under (GRV-8): the open project's ID
   * and whether this browser is internal traffic. Without it, turns carry no
   * session and are never kept.
   */
  readonly session?: () => { readonly projectId: string; readonly internal: boolean };
  /** Makes the conversation's and each turn's ID; random by default. */
  readonly newId?: () => string;
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
   * Asks again for the proposal or recommendation in entry `entryId`, with
   * its words and its scope, against the song as it is now (GRV-5's Refresh).
   * Returns whether it went: not while a reply streams, nor with no account.
   */
  refresh(entryId: string): boolean;
  /** The question waiting for an answer, if there is one (GRV-42). */
  readonly pendingAsk: Accessor<PendingAsk | null>;
  /**
   * Answers the pending question: the options picked and/or the typed text,
   * sent as the next turn. Returns whether it went: not while a reply
   * streams, with nothing said, or with no account.
   */
  answerAsk(answer: AskAnswer): boolean;
  /** Puts the pending question away unanswered. Nothing is sent. */
  dismissAsk(): void;
}

/** The most one message may say, as the gateway counts it. */
export const MAX_MESSAGE_CHARS = ASSISTANT_REQUEST_LIMITS.maxMessageChars;

/**
 * The conversation so far, as the next turn resends it: every message that
 * got a reply, with that reply. A message whose turn failed is left out,
 * along with whatever its reply wrote before failing, so the roles always
 * alternate and a broken answer is never passed off as the assistant's; the
 * retry resends the message, and its reply is the one that counts.
 */
export function historyOf(entries: readonly ConversationEntry[]): AssistantMessage[] {
  const history: AssistantMessage[] = [];
  let pending: string | null = null;
  for (const entry of entries) {
    // A video the reply recommended (GRV-16) is part of what it said, by the
    // ID the model itself named, so "more like that" has something to go on.
    const last = history.at(-1);
    if (entry.kind === "video" && pending === null && last?.role === "assistant") {
      history[history.length - 1] = {
        role: "assistant",
        text: `${last.text}\n\n[I recommended the YouTube video ${entry.video.videoId}.]`.slice(
          0,
          MAX_MESSAGE_CHARS,
        ),
      };
      continue;
    }
    if (entry.kind === "message") pending = entry.wire ?? entry.text;
    if (entry.kind !== "reply" || pending === null || entry.failed) continue;
    // A question the reply asked is part of what it said (GRV-42), so the
    // model reads its question back beside the answer.
    const said = [entry.text.trim(), entry.ask ? askTranscript(entry.ask) : ""]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (said.length === 0) continue;
    history.push(
      { role: "user", text: pending.slice(0, MAX_MESSAGE_CHARS) },
      { role: "assistant", text: said.slice(0, MAX_MESSAGE_CHARS) },
    );
    pending = null;
  }
  // Room for the new message; whole pairs only, so it still starts with the user.
  const room = ASSISTANT_REQUEST_LIMITS.maxMessages - 1;
  const keep = room - (room % 2);
  return history.length > keep ? history.slice(history.length - keep) : history;
}

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
  /** One conversation per panel session: what its kept turns are filed under. */
  const conversationId = newId();
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
    append({ kind: "reply", id: replyId, text: "", streaming: true, stopped: false });
    setStreaming(true);
    let ended = false;
    let handle: AssistantTurnHandle | null = null;

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
      }
      switch (event.type) {
        case "text":
          update(replyId, (entry) =>
            entry.kind === "reply" ? { ...entry, text: entry.text + event.text } : entry,
          );
          return;
        case "proposal": {
          // Recommendations come back among the proposal's calls (GRV-23):
          // each is a card of its own, and the changes, if any, are one.
          const split = splitRecommendations(event.proposal);
          if (split.proposal) {
            const entryId = id();
            append({ kind: "proposal", id: entryId, proposal: split.proposal, origin });
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
    const where = options.session?.();
    const turnId = where ? newId() : undefined;
    const request: AssistantTurnRequest = {
      projectRevision: project.metadata.revision,
      messages: [
        ...historyOf(entries()),
        { role: "user", text: said.slice(0, MAX_MESSAGE_CHARS) },
      ],
      context: scopedContext(project, scope),
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
    };
    append({ kind: "message", id: id(), scopeLabel: scope.label, ...message });
    const analytics = options.analytics();
    analytics.log("assistant_message_sent", { scope: scope.catalogScope });
    analytics.logFeatureFirstUse("assistant_message");
    startTurn(request, {
      ...message,
      scope,
      remoteChanges: options.remoteChanges?.() ?? 0,
      ...(turnId ? { turnId } : {}),
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

  function refresh(entryId: string): boolean {
    const entry = entries().find((candidate) => candidate.id === entryId);
    if (entry?.kind !== "proposal" && entry?.kind !== "recommendation") return false;
    if (!canStart()) return false;
    const { text, answers, wire, scope } = entry.origin;
    sendMessage({ text, answers, wire }, scope);
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

  function canRetry(entry: ConversationEntry): boolean {
    return (
      entry.kind === "error" &&
      entry.error.retryable &&
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
   * (a question's options are read against it), then keeps every change. A
   * new key (another project) brings back its own conversation, or none.
   */
  function keep(
    persistence: NonNullable<UseAssistantConversationOptions["persistence"]>,
  ) {
    const store = persistence.store ?? createConversationStore();
    const loaded = createMemo(() => options.project() !== null);
    let restoredKey: string | null = null;
    createEffect(
      () => ({
        key: persistence.key(),
        loaded: loaded(),
        pending: pendingAsk(),
        // A streaming reply changes with every word: it is kept when the turn
        // starts and when it ends, not word by word.
        entries: streaming() ? untrack(entries) : entries(),
      }),
      ({ key, loaded: ready, pending, entries: current }) => {
        if (key === null) return;
        if (key === restoredKey) {
          store.save(key, current, pending?.replyId ?? null);
          return;
        }
        if (!ready) return;
        const switching = restoredKey !== null;
        restoredKey = key;
        if (switching) inFlight?.stop();
        const stored = store.load(key);
        if (!stored && !switching) return;
        setEntries(stored?.entries ?? []);
        for (const entry of stored?.entries ?? []) {
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
      },
    );
  }

  return {
    entries,
    streaming,
    send,
    stop,
    retry,
    canRetry,
    refresh,
    pendingAsk,
    answerAsk,
    dismissAsk,
  };
}
