/**
 * A turn's cards, one at a time (GRV-129).
 *
 * One reply can carry several decisions: a proposal, then sounds to try on
 * the pads it adds. Shown together they ask too much at once, and a sound
 * card shown before its proposal is applied has no pad to land on. So the
 * panel shows a turn's first card, holds the rest back, and shows the next
 * once the one before is decided: a proposal applied or declined, a sound
 * kept or dismissed. The card on screen says how many wait behind it.
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
  /** Whether the producer has decided it, so the next can come up. Reactive. */
  decided(): boolean;
  /** Whether it is to be skipped rather than shown. Read when the turn moves on. */
  skip?(): boolean;
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
  /** The card on screen that the rest wait for, if any. */
  shown: QueuedCard | null;
  readonly waiting: QueuedCard[];
  skipped: number;
}

export function useCardQueue(): CardQueue {
  const turns = new Map<object, Turn>();
  const byEntry = new Map<string, Turn>();
  // The turns are plain objects; this is what tells a reader they changed.
  const [version, setVersion] = createSignal(0);
  const changed = () => setVersion((current) => current + 1);

  /** Drops the cards that are to be skipped, and shows the next if one is due. */
  function moveOn(turn: Turn): void {
    for (const card of [...turn.waiting]) {
      if (!card.skip?.()) continue;
      turn.waiting.splice(turn.waiting.indexOf(card), 1);
      turn.skipped += 1;
    }
    if (turn.shown && !turn.shown.decided()) return;
    const next = turn.waiting.shift();
    turn.shown = next ?? null;
    next?.show();
  }

  // A decision on a turn's shown card brings the next one up. The decisions
  // are the one reactive read; showing the next card is a write, so it is
  // the apply half's. Showing one changes `version`, so the next decision is
  // read from the card now on screen.
  createEffect(
    () => {
      version();
      return [...turns.values()].filter(
        (turn) => turn.shown !== null && turn.waiting.length > 0 && turn.shown.decided(),
      );
    },
    (due) => {
      if (due.length === 0) return;
      for (const turn of due) moveOn(turn);
      changed();
    },
  );

  return {
    add(key, card) {
      let turn = turns.get(key);
      if (!turn) {
        turn = { first: card.entryId, shown: null, waiting: [], skipped: 0 };
        turns.set(key, turn);
      }
      byEntry.set(card.entryId, turn);
      turn.waiting.push(card);
      moveOn(turn);
      changed();
    },
    held(entryId) {
      version();
      return (
        byEntry.get(entryId)?.waiting.some((card) => card.entryId === entryId) ?? false
      );
    },
    heldAfter(entryId) {
      version();
      const turn = byEntry.get(entryId);
      return turn?.shown?.entryId === entryId ? turn.waiting.length : 0;
    },
    skipped(entryId) {
      version();
      const turn = byEntry.get(entryId);
      return turn?.first === entryId ? turn.skipped : 0;
    },
  };
}
