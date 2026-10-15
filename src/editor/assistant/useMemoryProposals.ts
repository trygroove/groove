/**
 * The memory cards in Cue's conversation (GRV-25): what happens to each
 * thing Cue proposes remembering about the producer. Nothing is saved until
 * they press Remember; a saved one shows a receipt line with Undo, which
 * takes exactly that change back out.
 *
 * Analytics: `memory_note_proposed` as a card arrives, `memory_note_confirmed`
 * once it is saved, `memory_note_undone` once Undo has saved, each with what
 * kind of change it was and never its words. The first confirmed change also
 * logs `feature_first_use` for `memory`.
 */
import { type Accessor, createSignal } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import type { MemoryProposal } from "../../assistant/memory";
import {
  applyProposal,
  type MemoryUndo,
  markAsked,
  undoProposal,
} from "../../memory/memoryEdits";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import type { OnboardingQuestionId } from "../../persistence/profileDocuments";
import { type Clock, systemClock } from "../../shared/clock";

/** Where one card is. */
export type MemoryCardStatus =
  | "proposed"
  | "saving"
  | "saved"
  | "undoing"
  | "undone"
  | "dismissed"
  | "failed";

export interface MemoryCardState {
  readonly proposal: MemoryProposal;
  readonly status: MemoryCardStatus;
}

export interface AssistantMemoryProposals {
  /** One card's state, or null for an entry it has not heard of. */
  state(entryId: string): MemoryCardState | null;
  /** A proposal arriving in the conversation. */
  receive(entryId: string, proposal: MemoryProposal): void;
  /** Remember: saves it. Resolves with whether it saved. */
  confirm(entryId: string): Promise<boolean>;
  /** Not now: puts it away, saving nothing. */
  dismiss(entryId: string): void;
  /** Undo on a receipt: takes the change back out. */
  undo(entryId: string): Promise<boolean>;
  /** Cue asked a question skipped in onboarding: it is not asked again. */
  asked(question: OnboardingQuestionId): void;
}

export interface UseMemoryProposalsOptions {
  readonly store: ProducerProfileStore;
  readonly analytics: () => Pick<Analytics, "log" | "logFeatureFirstUse">;
  readonly clock?: Clock;
  /** Mints a note's ID; random by default. */
  readonly noteId?: () => string;
}

function randomNoteId(): string {
  return `note_${Math.random().toString(36).slice(2, 12)}`;
}

export function useMemoryProposals(
  options: UseMemoryProposalsOptions,
): AssistantMemoryProposals & {
  readonly cards: Accessor<ReadonlyMap<string, MemoryCardState>>;
} {
  const clock = options.clock ?? systemClock;
  const noteId = options.noteId ?? randomNoteId;
  const [cards, setCards] = createSignal<ReadonlyMap<string, MemoryCardState>>(new Map());
  const undos = new Map<string, MemoryUndo>();
  // Plain copy, for checks in the same tick as a write (Solid 2 batches).
  let now = new Map<string, MemoryCardState>();

  const set = (entryId: string, state: MemoryCardState) => {
    now = new Map(now).set(entryId, state);
    setCards(now);
  };
  const kindOf = (proposal: MemoryProposal) =>
    proposal.kind === "note" ? "note" : proposal.field;

  return {
    cards,
    state: (entryId) => cards().get(entryId) ?? null,
    receive(entryId, proposal) {
      set(entryId, { proposal, status: "proposed" });
      options.analytics().log("memory_note_proposed", { kind: kindOf(proposal) });
    },
    async confirm(entryId) {
      const card = now.get(entryId);
      if (!card || (card.status !== "proposed" && card.status !== "failed")) return false;
      set(entryId, { ...card, status: "saving" });
      const made: { undo: MemoryUndo | null } = { undo: null };
      const saved = await options.store.update((profile) => {
        const applied = applyProposal(profile, card.proposal, {
          id: noteId(),
          createdAt: clock.now(),
        });
        made.undo = applied.undo;
        return applied.profile;
      });
      const undo = made.undo;
      if (!saved || !undo) {
        set(entryId, { ...card, status: "failed" });
        return false;
      }
      undos.set(entryId, undo);
      set(entryId, { ...card, status: "saved" });
      const analytics = options.analytics();
      analytics.log("memory_note_confirmed", { kind: kindOf(card.proposal) });
      analytics.logFeatureFirstUse("memory");
      return true;
    },
    dismiss(entryId) {
      const card = now.get(entryId);
      if (card?.status === "proposed" || card?.status === "failed") {
        set(entryId, { ...card, status: "dismissed" });
      }
    },
    async undo(entryId) {
      const card = now.get(entryId);
      const undo = undos.get(entryId);
      if (!card || card.status !== "saved" || !undo) return false;
      set(entryId, { ...card, status: "undoing" });
      const saved = await options.store.update((profile) => undoProposal(profile, undo));
      if (!saved) {
        set(entryId, { ...card, status: "saved" });
        return false;
      }
      undos.delete(entryId);
      set(entryId, { ...card, status: "undone" });
      options.analytics().log("memory_note_undone", { kind: kindOf(card.proposal) });
      return true;
    },
    asked(question) {
      if (!options.store.current()?.laterQuestions.includes(question)) return;
      void options.store.update((profile) => markAsked(profile, question));
    },
  };
}
