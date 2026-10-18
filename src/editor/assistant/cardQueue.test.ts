import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { type CardQueue, moreAfterThis, skippedLine, useCardQueue } from "./cardQueue";

/** A card whose decision and skip the test sets, and which records being shown. */
function testCard(entryId: string, shown: string[]) {
  const [decided, setDecided] = createSignal(false);
  const [skip, setSkip] = createSignal(false);
  return {
    card: {
      entryId,
      show: () => shown.push(entryId),
      decided,
      skip,
    },
    decide: () => {
      setDecided(true);
      flush();
    },
    setSkip,
  };
}

function setUp(): { queue: CardQueue; dispose: () => void } {
  let queue: CardQueue | undefined;
  const dispose = createRoot((dispose) => {
    queue = useCardQueue();
    return dispose;
  });
  if (!queue) throw new Error("no queue");
  return { queue, dispose };
}

describe("a turn's cards, one at a time (GRV-129)", () => {
  it("shows the first card, holds the rest, and shows each once the one before is decided", () => {
    const { queue, dispose } = setUp();
    const shown: string[] = [];
    const turn = {};
    const [a, b, c] = ["a", "b", "c"].map((id) => testCard(id, shown));
    if (!a || !b || !c) throw new Error("no cards");
    queue.add(turn, a.card);
    queue.add(turn, b.card);
    queue.add(turn, c.card);
    flush();
    expect(shown).toEqual(["a"]);
    expect(queue.held("a")).toBe(false);
    expect(queue.held("b")).toBe(true);
    expect(queue.heldAfter("a")).toBe(2);
    a.decide();
    expect(shown).toEqual(["a", "b"]);
    expect(queue.held("b")).toBe(false);
    expect(queue.heldAfter("b")).toBe(1);
    expect(queue.heldAfter("a")).toBe(0);
    b.decide();
    expect(shown).toEqual(["a", "b", "c"]);
    expect(queue.heldAfter("c")).toBe(0);
    dispose();
  });

  it("keeps each turn's cards to itself", () => {
    const { queue, dispose } = setUp();
    const shown: string[] = [];
    const [a, b] = ["a", "b"].map((id) => testCard(id, shown));
    if (!a || !b) throw new Error("no cards");
    queue.add({}, a.card);
    queue.add({}, b.card);
    flush();
    expect(shown).toEqual(["a", "b"]);
    dispose();
  });

  it("skips the held cards that ask to be, and counts them on the turn's first card", () => {
    const { queue, dispose } = setUp();
    const shown: string[] = [];
    const turn = {};
    const [proposal, kick, snare, hat] = ["p", "kick", "snare", "hat"].map((id) =>
      testCard(id, shown),
    );
    if (!proposal || !kick || !snare || !hat) throw new Error("no cards");
    for (const entry of [proposal, kick, snare, hat]) queue.add(turn, entry.card);
    flush();
    snare.setSkip(true);
    hat.setSkip(true);
    proposal.decide();
    expect(shown).toEqual(["p", "kick"]);
    expect(queue.heldAfter("kick")).toBe(0);
    expect(queue.held("snare")).toBe(false);
    expect(queue.skipped("p")).toBe(2);
    expect(queue.skipped("kick")).toBe(0);
    dispose();
  });

  it("says how many more, and how many were skipped", () => {
    expect(moreAfterThis(3)).toBe("3 more after this");
    expect(skippedLine(2)).toBe("Skipped 2 sound suggestions for the declined track");
    expect(skippedLine(1)).toBe("Skipped 1 sound suggestion for the declined track");
  });
});
