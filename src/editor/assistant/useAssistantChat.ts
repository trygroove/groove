/**
 * Everything the assistant's composer and conversation need (GRV-26), held
 * once per editor beside the panel's layout (`useAssistantPanel.ts`): the
 * scope the chip says, the draft, the suggestion chips and the conversation,
 * and the answer being put together to a question the assistant asked
 * (GRV-42). The panel renders it, and the shortcut layer sends the draft on
 * Enter and picks an answer on `1`-`8`.
 */
import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import type { AssistantClient } from "../../assistant/assistantClient";
import type { AssistantToolCall } from "../../assistant/protocol";
import {
  createdTargets,
  namedTarget,
  type RecommendationTargets,
} from "../../assistant/recommendationTargets";
import type { AssistantRetentionClient } from "../../assistant/retentionClient";
import { createSessionHealth, type SessionTurn } from "../../assistant/sessionHealth";
import type { ReplyRating } from "../../assistant/transcripts";
import type { Project } from "../../domain/entities";
import { memoryContext } from "../../memory/memoryEdits";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import type { Suggestion } from "../../projection/projectAnalysisProjection";
import { type Clock, systemClock } from "../../shared/clock";
import type { EditorViewName } from "../editorViews";
import type { AskEditorLink } from "./askReferences";
import { type AssistantLibrary, libraryContext } from "./assistantLibrary";
import {
  type AssistantScope,
  resolveScope,
  type ScopeLevel,
  type ScopeSources,
  selectionKey,
  widen,
} from "./assistantScope";
import { assistantSuggestions } from "./assistantSuggestions";
import { type CardQueue, useCardQueue } from "./cardQueue";
import type { ConversationStore } from "./conversationStore";
import { MISSING_SLOT } from "./recommendationCardModel";
import { type AskDraft, useAskDraft } from "./useAskDraft";
import {
  type AssistantConversation,
  useAssistantConversation,
} from "./useAssistantConversation";
import {
  type AssistantProposals,
  type ProposalSessionPort,
  type UseAssistantProposalsOptions,
  useAssistantProposals,
} from "./useAssistantProposals";
import {
  type AssistantRecommendations,
  type RecommendationEditorPort,
  useAssistantRecommendations,
} from "./useAssistantRecommendations";
import { type AssistantRetention, useAssistantRetention } from "./useAssistantRetention";
import { type CueNudge, useCueNudge } from "./useCueNudge";
import { type AssistantMemoryProposals, useMemoryProposals } from "./useMemoryProposals";

/** Who is here to talk: a signed-in account, or someone who must sign in. */
export interface AssistantAccount {
  /** False for a guest or for no one (ADR 0006 decision 4). */
  readonly registered: boolean;
  /** Starts a sign-in; absent where there is no way to offer one. */
  readonly signIn?: () => void;
}

export interface UseAssistantChatOptions {
  readonly project: Accessor<Project | null>;
  readonly view: Accessor<EditorViewName>;
  /** What the editor is pointed at: the selection on screen and the track. */
  readonly sources: Accessor<ScopeSources>;
  readonly account: Accessor<AssistantAccount>;
  /** Whether the conversation is on screen, so suggestions are only worked out then. */
  readonly expanded: Accessor<boolean>;
  readonly client: () => Promise<AssistantClient>;
  readonly analytics: () => Analytics;
  /**
   * The account's answer about keeping conversations (GRV-8). With it, the
   * assistant cannot be messaged until a signed-in account has answered the
   * disclosure, and each turn carries the session its transcript is filed
   * under. The editor always passes one; a test that leaves it out is testing
   * something else, and its turns are never kept.
   */
  readonly retention?: {
    readonly client: () => Promise<AssistantRetentionClient>;
    /** Whether this browser is internal traffic (`isInternalTraffic`). */
    readonly internal: () => boolean;
  };
  /**
   * The editor session and controls a proposal previews, applies and shows
   * itself through (GRV-5). Without them a proposal is listed, but there is
   * nothing to apply it to. A question's options hear the producer's own
   * edits through the same session (GRV-42).
   */
  readonly editor?: {
    readonly session: ProposalSessionPort;
    readonly controls: UseAssistantProposalsOptions["controls"];
    /**
     * The library a turn may recommend from, and the slots, audio and insert
     * a recommendation is tried and kept through (GRV-23). Without them the
     * assistant is sent no library, so it recommends nothing.
     */
    readonly recommendations?: {
      readonly library: AssistantLibrary;
      readonly port: RecommendationEditorPort;
    };
  };
  /**
   * The committed project, never a preview of it (GRV-42): what a question
   * is asked against and answered by doing in. Defaults to {@link project}.
   */
  readonly committedProject?: () => Project | null;
  /** What a question's options can do in the editor (GRV-42). */
  readonly link?: AskEditorLink;
  /**
   * Where the conversation is kept across a reload (GRV-42), for this account
   * and project, or null to keep it in memory only.
   */
  readonly conversationKey?: Accessor<string | null>;
  /** The store it is kept in; this tab's session storage by default. */
  readonly conversationStore?: ConversationStore;
  /** What times a proposal's undo against its apply (GRV-103); the real clock by default. */
  readonly clock?: Clock;
  /**
   * The producer's profile (GRV-25): what Coproducer remembers, sent with every
   * turn, and where a confirmed memory card is saved. Without it turns carry
   * no memory.
   */
  readonly profile?: ProducerProfileStore;
}

export interface AssistantChat {
  readonly conversation: AssistantConversation;
  readonly scope: Accessor<AssistantScope>;
  /** The chip's click: one step wider, or back to the narrowest. */
  widenScope(): void;
  readonly suggestions: Accessor<readonly Suggestion[]>;
  readonly draft: Accessor<string>;
  setDraft(text: string): void;
  /** Enter, or the Send button: sends the draft and clears it if it went. */
  sendDraft(): boolean;
  /** A suggestion chip: sends its label as the message. */
  sendSuggestion(suggestion: Suggestion): boolean;
  readonly account: Accessor<AssistantAccount>;
  /** The proposal cards, when there is an editor to apply them to. */
  readonly proposals: AssistantProposals | null;
  /** The recommended packs, when there is an editor and a library to try them in. */
  readonly recommendations: AssistantRecommendations | null;
  /**
   * Which of a turn's cards are held back until the one before is decided,
   * and how many wait behind the one shown (GRV-129).
   */
  readonly cards: Pick<CardQueue, "held" | "heldAfter" | "skipped">;
  /** The pending question's answer so far (GRV-42). */
  readonly ask: AskDraft;
  /** The memory cards, when there is a profile to save them to (GRV-25). */
  readonly memory: AssistantMemoryProposals | null;
  /** Coproducer's one nudge a day, when there is a profile to read it from (GRV-25). */
  readonly nudge: CueNudge | null;
  /** The account's answer about keeping conversations, when it is asked for. */
  readonly retention: AssistantRetention | null;
  /**
   * Thumbs up or down on a reply (GRV-103): the same thumb again clears it.
   * Logs each change, counts a down towards a sad session, and tells a kept
   * transcript.
   */
  rateReply(replyId: string, rating: ReplyRating): void;
  /** What a card logs its own actions through (a video's Play, GRV-16). */
  readonly analytics?: () => Analytics;
}

export type { AskDraft } from "./useAskDraft";

export function useAssistantChat(options: UseAssistantChatOptions): AssistantChat {
  // The chip's choice, kept against the selection it was made for: a new
  // selection lets it go at once.
  const [chosen, setChosen] = createSignal<{ level: ScopeLevel; key: string } | null>(
    null,
  );
  // And for good: going back to the selection it was made for (nothing
  // selected, say) must not bring a widened choice back. The key is the one
  // reactive read; forgetting the choice is a write, so it is the apply half's.
  createEffect(
    () => selectionKey(options.sources()),
    () => {
      setChosen(null);
    },
  );
  const scope = createMemo(() => {
    const sources = options.sources();
    const choice = chosen();
    const level = choice && choice.key === selectionKey(sources) ? choice.level : null;
    return resolveScope(sources, level);
  });
  const [draft, setDraft] = createSignal("");

  const retentionOptions = options.retention;
  const retention = retentionOptions
    ? useAssistantRetention({
        client: retentionOptions.client,
        registered: () => options.account().registered,
        analytics: options.analytics,
        // Only once the assistant is first opened: an editor whose assistant
        // stays shut never asks.
        wanted: options.expanded,
      })
    : null;
  /** The turn each proposal card came from, so its outcome reaches the right record. */
  const turnOfEntry = new Map<string, string>();
  /** Which turn of the session each proposal card came from (GRV-103). */
  const sessionTurnOfEntry = new Map<string, SessionTurn>();
  const detector = createSessionHealth({
    clock: options.clock ?? systemClock,
    analytics: options.analytics,
  });
  // A new conversation forgets the old one's cards along with its session.
  const health = {
    ...detector,
    reset() {
      sessionTurnOfEntry.clear();
      detector.reset();
    },
  };

  const editor = options.editor;
  const proposals = editor
    ? useAssistantProposals({
        session: editor.session,
        controls: editor.controls,
        project: options.project,
        analytics: options.analytics,
        // The conversation is made just below; Refresh is only ever pressed later.
        refresh: (entryId) => conversation.refresh(entryId),
        continueRest: (entryId, shown) => conversation.continueProposal(entryId, shown),
        clock: options.clock,
        onOutcome: (entryId, outcome, issues) => {
          const turnId = turnOfEntry.get(entryId);
          if (turnId) retention?.reportOutcome(turnId, outcome, issues);
          const sessionTurn = sessionTurnOfEntry.get(entryId);
          if (sessionTurn !== undefined) {
            health.proposalOutcome(entryId, outcome, sessionTurn, {
              stale: issues?.some((issue) => issue.code === "stale_revision") ?? false,
            });
          }
        },
      })
    : null;

  const recommending = editor?.recommendations;
  const recommendations =
    editor && recommending
      ? useAssistantRecommendations({
          session: editor.session,
          controls: editor.controls,
          project: options.project,
          view: options.view,
          library: recommending.library,
          editor: recommending.port,
          analytics: options.analytics,
          refresh: (entryId) => conversation.refresh(entryId),
        })
      : null;

  // A turn's proposal and sound cards come up one at a time (GRV-129). Each
  // turn is keyed by the origin its cards share; a sound card is skipped,
  // not shown, when the track or pad it names only the turn's declined
  // proposal would have added.
  const queue = useCardQueue();
  const proposalOfTurn = new Map<
    object,
    { readonly entryId: string; readonly created: RecommendationTargets }
  >();
  function forDeclinedProposal(turn: object, call: AssistantToolCall): boolean {
    const proposed = proposalOfTurn.get(turn);
    if (!proposed || !proposals?.declined(proposed.entryId)) return false;
    const { trackId, padId } = namedTarget(call.input);
    const created =
      (trackId !== null && proposed.created.has(trackId)) ||
      (padId !== null && [...proposed.created.values()].some((pads) => pads.has(padId)));
    return created && recommending?.port.slotFor(trackId, padId) === MISSING_SLOT;
  }

  const profile = options.profile;
  const memory = profile
    ? useMemoryProposals({ store: profile, analytics: options.analytics })
    : null;

  const conversation = useAssistantConversation({
    client: options.client,
    project: options.project,
    scope,
    // Nobody messages the assistant before answering the disclosure (GRV-8).
    canSend: () =>
      options.account().registered && (retention ? retention.answered() : true),
    analytics: options.analytics,
    committedProject: options.committedProject,
    clock: options.clock,
    onProposalPart: proposals
      ? (entryId, part, origin, baseRevision) => {
          // The first part shows the card, which fills in as the rest land
          // (GRV-144). It is the turn's first card, so nothing holds it.
          if (!proposalOfTurn.has(origin)) {
            if (origin.turnId) turnOfEntry.set(entryId, origin.turnId);
            if (origin.sessionTurn !== undefined) {
              sessionTurnOfEntry.set(entryId, origin.sessionTurn);
            }
            proposalOfTurn.set(origin, { entryId, created: createdTargets([]) });
            queue.add(origin, {
              entryId,
              show: () => {},
              decided: () => proposals.decided(entryId),
            });
          }
          proposals.receivePart(entryId, part, origin, baseRevision);
        }
      : undefined,
    onProposalEnded: proposals
      ? (entryId, ending) => proposals.endStream(entryId, ending)
      : undefined,
    onProposal: proposals
      ? (entryId, proposal, origin) => {
          if (proposalOfTurn.get(origin)?.entryId === entryId) {
            // The turn's parts streamed: its card is up already, and the
            // whole proposal says what the parts make and why.
            proposalOfTurn.set(origin, {
              entryId,
              created: createdTargets(proposal.calls),
            });
            proposals.receive(entryId, proposal, origin);
            return;
          }
          if (origin.turnId) turnOfEntry.set(entryId, origin.turnId);
          if (origin.sessionTurn !== undefined) {
            sessionTurnOfEntry.set(entryId, origin.sessionTurn);
          }
          proposalOfTurn.set(origin, {
            entryId,
            created: createdTargets(proposal.calls),
          });
          queue.add(origin, {
            entryId,
            show: () => proposals.receive(entryId, proposal, origin),
            decided: () => proposals.decided(entryId),
          });
        }
      : undefined,
    session: retentionOptions
      ? () => {
          const project = options.project();
          return {
            projectId: project?.metadata.id ?? "",
            internal: retentionOptions.internal(),
          };
        }
      : undefined,
    remoteChanges: proposals ? () => proposals.remoteChanges() : undefined,
    library: recommending
      ? async (project) => {
          const catalog = await recommending.library.load();
          return catalog ? libraryContext(catalog, project) : null;
        }
      : undefined,
    onRecommendation: recommendations
      ? (entryId, call, library, origin) =>
          queue.add(origin, {
            entryId,
            show: () => recommendations.receive(entryId, call, library, origin),
            decided: () => recommendations.decided(entryId),
            hold: () => recommendations.hold(entryId),
            skip: () => forDeclinedProposal(origin, call),
          })
      : undefined,
    memory: profile
      ? () => {
          const current = profile.profile();
          return current ? memoryContext(current) : null;
        }
      : undefined,
    onMemoryProposal: memory
      ? (entryId, proposal) => memory.receive(entryId, proposal)
      : undefined,
    onMemoryQuestionAsked: memory ? (question) => memory.asked(question) : undefined,
    persistence: options.conversationKey
      ? { key: options.conversationKey, store: options.conversationStore }
      : undefined,
    health,
  });

  const nudge = profile
    ? useCueNudge({
        profile,
        expanded: options.expanded,
        ready: () => (retention ? retention.answered() : true),
        conversation,
        analytics: options.analytics,
      })
    : null;

  const ask = useAskDraft({
    conversation,
    project: options.project,
    committedProject: options.committedProject,
    onEdit: options.editor?.session.onEdit,
    link: options.link,
  });

  const suggestions = createMemo((): readonly Suggestion[] => {
    const project = options.project();
    if (!project || !options.expanded()) return [];
    return assistantSuggestions(project, options.view(), scope());
  });

  function rateReply(replyId: string, rating: ReplyRating): void {
    const current = conversation
      .entries()
      .find((entry) => entry.id === replyId && entry.kind === "reply");
    if (current?.kind !== "reply") return;
    // The same thumb again takes the rating back.
    const next = current.rating === rating ? null : rating;
    conversation.rateReply(replyId, next);
    if (current.turnId) retention?.reportRating(current.turnId, next);
    if (next === null) return;
    if (next === "down" && current.sessionTurn !== undefined) {
      health.rated("down", current.sessionTurn);
    }
    try {
      const analytics = options.analytics();
      analytics.log("assistant_reply_rated", { rating: next });
      analytics.logFeatureFirstUse("assistant_rating");
    } catch {
      // The rating stands; an analytics failure is not this feature's.
    }
  }

  return {
    conversation,
    scope,
    widenScope() {
      const sources = options.sources();
      setChosen({ level: widen(scope().level, sources), key: selectionKey(sources) });
    },
    suggestions,
    draft,
    setDraft: (text) => setDraft(text),
    sendDraft() {
      const sent = conversation.send(draft());
      if (sent) setDraft("");
      return sent;
    },
    sendSuggestion: (suggestion) => conversation.send(suggestion.label, suggestion.id),
    account: options.account,
    proposals,
    recommendations,
    cards: queue,
    ask,
    memory,
    nudge,
    retention,
    rateReply,
    analytics: options.analytics,
  };
}
