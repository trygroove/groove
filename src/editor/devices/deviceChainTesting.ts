import { afterEach, vi } from "vitest";
import { dragTrackHandle, stubTrackDragLayout } from "../../testing/trackDrag";

/**
 * Dragging a device card in a chain's tests, shared by the track chain
 * (`DeviceChainPanel`) and the master's (`MasterPanel`), which are one
 * component. A card is picked up with the same pointer drag every reorder uses
 * (#539), so it is driven through `testing/trackDrag`.
 */

/** Pointer positions over a card's upper and lower half. */
export const UPPER = -1;
export const LOWER = 1;

const CARD_SIZE = 80;

afterEach(() => vi.restoreAllMocks());

/** The cards in the order they show, which mid-drag is the previewed order. */
export function shownCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".device-chain-item")].sort(
    (a, b) => Number(a.style.order) - Number(b.style.order),
  );
}

/**
 * jsdom lays nothing out, so give each card a box at its shown position in a
 * tall chain. Called before a drag; restored after each test.
 */
export function stubChainLayout(): void {
  stubTrackDragLayout({
    axis: "y",
    zoneSelector: ".device-chain-list",
    size: CARD_SIZE,
    zoneLength: CARD_SIZE * 20,
    order: () => shownCards().map((card) => card.dataset.trackDrag as string),
  });
}

/** A pointer height over one half of `card`, as it is laid out right now. */
export function overCard(card: HTMLElement, half: number): number {
  return shownCards().indexOf(card) * CARD_SIZE + (half === UPPER ? 10 : 70);
}

/**
 * A drag pressed on `handle`, let go over one half of `to`. It waits out the
 * click a real release ends in, which the controller swallows, so that wait
 * cannot eat the next test's first click.
 */
export async function dragCard(handle: Element, to: HTMLElement, half = UPPER) {
  stubChainLayout();
  dragTrackHandle(handle, { x: 50, y: overCard(to, half) });
  await new Promise((resolve) => setTimeout(resolve, 0));
}
