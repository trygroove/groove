/**
 * Picking an item up to reorder it (#539). Every reorder drag in the app —
 * track headers, rail rows, mixer strips, device cards — lifts the item the
 * same way: a copy of it follows the pointer, its own slot is left as an empty
 * gap (fully transparent, so it keeps its box and its place in the accessibility tree), and the other items slide to
 * open the slot under the pointer. Nothing here knows what a track or a device
 * is, or how a drop is decided: a list owns its own targeting and its own one
 * reorder command, and asks this module only for the picture.
 */
export interface DragLift {
  /** Carry the copy along with the pointer. */
  move(pointer: { clientX: number; clientY: number }): void;
  /** Put the copy away. Safe to call twice. */
  dispose(): void;
}

/** The class on the copy, and on the document while one is held. */
export const LIFT_CLASS = "drag-lift";
export const LIFTING_CLASS = "drag-lifting";

/**
 * Lift `source`: a copy at its exact box, following the pointer from where it
 * was pressed. The copy is fixed and pointer-transparent so it never changes a
 * layout or receives an event, and carries none of the original's identity — no
 * ids and no `data-track-drag`, so a list never measures it as one of its items.
 *
 * It is appended to `document.body`, never beside `source`: a `position: fixed`
 * element resolves against the nearest ancestor with a transform, `will-change`,
 * `filter` or `contain` (the arrangement's scrolling header column has one), and
 * inside that it drew offset from the pointer by the ancestor's own position.
 * Its styles are class-based on the item itself, so they still reach it there.
 */
export function liftItem(
  source: HTMLElement,
  press: { clientX: number; clientY: number },
): DragLift {
  const box = source.getBoundingClientRect();
  const copy = source.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    el.removeAttribute("id");
    el.removeAttribute("data-track-drag");
    el.removeAttribute("tabindex");
  }
  copy.classList.remove("track-dragging");
  copy.classList.add(LIFT_CLASS);
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  Object.assign(copy.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
  document.body.append(copy);
  document.documentElement.classList.add(LIFTING_CLASS);

  let disposed = false;
  return {
    move({ clientX, clientY }) {
      copy.style.transform = `translate(${clientX - press.clientX}px, ${clientY - press.clientY}px)`;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      copy.remove();
      document.documentElement.classList.remove(LIFTING_CLASS);
    },
  };
}

/** How long an item takes to slide into its new slot, in ms. */
export const SLIDE_MS = 140;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Slides items to where a reorder preview has just put them. `settle` reads
 * every item's layout position (which transforms do not move), and animates
 * each one that has changed since the last call from where it was to where it
 * is now. The first call only records, so there is nothing to animate from.
 * With reduced motion, or no Web Animations, items simply jump.
 */
export function createSlide(): { settle(items: Iterable<HTMLElement>): void } {
  const last = new WeakMap<HTMLElement, { x: number; y: number }>();
  return {
    settle(items) {
      const animate = !prefersReducedMotion();
      for (const el of items) {
        const now = { x: el.offsetLeft, y: el.offsetTop };
        const before = last.get(el);
        last.set(el, now);
        if (!animate || !before || typeof el.animate !== "function") continue;
        const [dx, dy] = [before.x - now.x, before.y - now.y];
        if (dx === 0 && dy === 0) continue;
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
          { duration: SLIDE_MS, easing: "ease-out" },
        );
      }
    },
  };
}
