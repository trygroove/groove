/**
 * A turn's cards, one at a time (GRV-129).
 *
 * One reply can carry several decisions: a proposal, then sounds to try on
 * the pads it adds. Shown together they ask too much at once, and a sound
 * card shown before its proposal is applied has no pad to land on. So the
 * panel shows a turn's first card, holds the rest back, and shows the next
 * once the one before is decided: a proposal applied or declined, a sound
 * kept or dismissed. A decision taken back (a kept sound undone) makes that
 * card the one to decide again, and the cards after it are held once more.
 * The card on screen says how many wait behind it.
 *
 * A card is handed to its controller (`show`) only when it comes up, so it
 * works out where it is aimed then, against the song as it then stands. A
 * held card can ask to be skipped instead (a sound for a track only a
 * declined proposal would have added); the turn counts those, for the one
 * line that says so.
 */
import { createEffect, createSignal } from "solid-js";

/** The quiet line on a card others wait behind. */
export function moreAfterThis(count: number): string {
  return `${count} more after this`;
}

/** The one line that says a declined proposal's sound cards were skipped. */
export function skippedLine(count: number): string {
  return `Skipped ${count} sound ${count === 1 ? "suggestion" : "suggestions"} for the declined track`;
}

/** One card a turn holds until it comes up. */
export interface QueuedCard {
  readonly entryId: string;
  /** Hands the card to its controller, which shows it. */
  show(): void;
  /**
   * Whether the producer has decided it, so the next can come up. Reactive. A
   * decision can be taken back (a kept sound undone), and the cards after it
   * are held again until it is decided anew.
   */
  decided(): boolean;
  /** Whether it is to be skipped rather than shown. Read when the turn moves on. */
  skip?(): boolean;
  /**
   * The card was shown and is held again behind one taken back: it stops
   * anything it has going (a sound being tried), since it is off screen.
   */
  hold?(): void;
}

export interface CardQueue {
  /**
   * Adds a card to `turn`'s, in order: shown at once when nothing of the turn
   * waits for a decision, held otherwise.
   */
  add(turn: object, card: QueuedCard): void;
  /** Whether a card is held back. Reactive. */
  held(entryId: string): boolean;
  /** How many cards wait behind this one, while it is the one shown. Reactive. */
  heldAfter(entryId: string): number;
  /**
   * How many of the turn's cards were skipped, read on the turn's first card,
   * where the panel says so. Reactive.
   */
  skipped(entryId: string): number;
}

interface Turn {
  /** The turn's first card, which carries the line about skipped ones. */
  readonly first: string;
  /** The turn's cards in order, skipped ones gone. */
  readonly cards: QueuedCard[];
  /** How many of `cards`, from the front, have been handed to their controller. */
  shown: number;
  /** The shown cards held again behind one taken back, already told so. */
  readonly rehold: Set<string>;
  skipped: number;
}

/**
 * The turn's card the rest wait for: the first shown one not decided. Every
 * card after it is held, shown before or not. -1 when every shown card is
 * decided. Reactive through the cards' decisions.
 */
function currentOf(turn: Turn): number {
  for (let index = 0; index < turn.shown; index += 1) {
    if (!turn.cards[index]?.decided()) return index;
  }
  return -1;
}

/** The shown cards held again because one before them was taken back. */
function reheldOf(turn: Turn): QueuedCard[] {
  const current = currentOf(turn);
  return current === -1 ? [] : turn.cards.slice(current + 1, turn.shown);
}

export function useCardQueue(): CardQueue {
  const turns = new Map<object, Turn>();
  const byEntry = new Map<string, Turn>();
  // The turns are plain objects; this is what tells a reader they changed.
  const [version, setVersion] = createSignal(0);
  const changed = () => setVersion((current) => current + 1);

  /** Drops the cards that are to be skipped, and shows the next if one is due. */
  function moveOn(turn: Turn): void {
    for (const card of turn.cards.slice(turn.shown)) {
      if (!card.skip?.()) continue;
      turn.cards.splice(turn.cards.indexOf(card), 1);
      turn.skipped += 1;
    }
    if (currentOf(turn) !== -1) return;
    const next = turn.cards[turn.shown];
    if (!next) return;
    turn.shown += 1;
    next.show();
  }

  // A decision on a turn's current card brings the next one up, and one taken
  // back holds the shown cards after it again. The decisions are the one
  // reactive read; showing and holding are writes, so they are the apply
  // half's. Each changes `version`, so the next decision is read from the
  // card now on screen.
  createEffect(
    () => {
      version();
      const due: Turn[] = [];
      const held: { turn: Turn; cards: QueuedCard[] }[] = [];
      for (const turn of turns.values()) {
        if (turn.shown < turn.cards.length && currentOf(turn) === -1) due.push(turn);
        held.push({ turn, cards: reheldOf(turn) });
      }
      return { due, held };
    },
    ({ due, held }) => {
      let moved = due.length > 0;
      for (const turn of due) moveOn(turn);
      for (const { turn, cards } of held) {
        const now = new Set(cards.map((card) => card.entryId));
        for (const card of cards) {
          if (turn.rehold.has(card.entryId)) continue;
          turn.rehold.add(card.entryId);
          card.hold?.();
          moved = true;
        }
        for (const entryId of [...turn.rehold]) {
          if (now.has(entryId)) continue;
          turn.rehold.delete(entryId);
          moved = true;
        }
      }
      if (moved) changed();
    },
  );

  function placeOf(entryId: string): { turn: Turn; index: number } | null {
    const turn = byEntry.get(entryId);
    const index = turn?.cards.findIndex((card) => card.entryId === entryId) ?? -1;
    return turn && index !== -1 ? { turn, index } : null;
  }

  return {
    add(key, card) {
      let turn = turns.get(key);
      if (!turn) {
        turn = {
          first: card.entryId,
          cards: [],
          shown: 0,
          rehold: new Set(),
          skipped: 0,
        };
        turns.set(key, turn);
      }
      byEntry.set(card.entryId, turn);
      turn.cards.push(card);
      moveOn(turn);
      changed();
    },
    held(entryId) {
      version();
      const place = placeOf(entryId);
      if (!place) return false;
      const current = currentOf(place.turn);
      return place.index >= place.turn.shown || (current !== -1 && place.index > current);
    },
    heldAfter(entryId) {
      version();
      const place = placeOf(entryId);
      if (!place || currentOf(place.turn) !== place.index) return 0;
      return place.turn.cards.length - place.index - 1;
    },
    skipped(entryId) {
      version();
      const turn = byEntry.get(entryId);
      return turn?.first === entryId ? turn.skipped : 0;
    },
  };
}
