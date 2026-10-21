import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlide, LIFT_CLASS, LIFTING_CLASS, liftItem } from "./dragLift";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function list(): { ul: HTMLUListElement; items: HTMLLIElement[] } {
  const ul = document.createElement("ul");
  const items = ["a", "b", "c"].map((id) => {
    const li = document.createElement("li");
    li.id = `row-${id}`;
    li.dataset.trackDrag = id;
    li.innerHTML = `<button id="btn-${id}" tabindex="0">${id}</button>`;
    ul.append(li);
    return li;
  });
  document.body.append(ul);
  return { ul, items };
}

describe("liftItem (#539)", () => {
  it("copies the item beside itself, without its identity, and follows the pointer", () => {
    const { ul, items } = list();
    vi.spyOn(items[1], "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 40, 200, 30),
    );
    const lift = liftItem(items[1], { clientX: 15, clientY: 45 });

    const copy = document.querySelector<HTMLElement>(`.${LIFT_CLASS}`);
    expect(copy).not.toBeNull();
    expect(copy?.parentElement).toBe(document.body);
    expect(copy?.textContent).toBe("b");
    expect(copy?.style).toMatchObject({ left: "10px", top: "40px", width: "200px" });
    // Never measurable as one of the list's items, and never a second element
    // with the original's id.
    expect(ul.querySelectorAll("[data-track-drag]")).toHaveLength(3);
    expect(document.querySelectorAll("#row-b, #btn-b")).toHaveLength(2);
    expect(copy?.querySelector("[id]")).toBeNull();
    expect(copy?.getAttribute("aria-hidden")).toBe("true");
    expect(document.documentElement).toHaveClass(LIFTING_CLASS);

    lift.move({ clientX: 65, clientY: 25 });
    expect(copy?.style.transform).toBe("translate(50px, -20px)");
  });

  it("puts the copy away, once", () => {
    const { items } = list();
    const lift = liftItem(items[0], { clientX: 0, clientY: 0 });
    lift.dispose();
    lift.dispose();
    expect(document.querySelector(`.${LIFT_CLASS}`)).toBeNull();
    expect(document.documentElement).not.toHaveClass(LIFTING_CLASS);
  });
});

describe("createSlide (#539)", () => {
  function place(items: HTMLElement[], tops: number[]): void {
    items.forEach((el, i) => {
      Object.defineProperty(el, "offsetTop", { value: tops[i], configurable: true });
      Object.defineProperty(el, "offsetLeft", { value: 0, configurable: true });
    });
  }

  it("animates only the items whose place changed, from where they were", () => {
    const { items } = list();
    const animate = vi.fn();
    for (const el of items) el.animate = animate;
    const slide = createSlide();
    place(items, [0, 30, 60]);
    slide.settle(items);
    expect(animate).not.toHaveBeenCalled();

    place(items, [30, 0, 60]);
    slide.settle(items);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[0][0]).toEqual([
      { transform: "translate(0px, -30px)" },
      { transform: "none" },
    ]);
  });

  it("does not animate under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
    }));
    const { items } = list();
    const animate = vi.fn();
    for (const el of items) el.animate = animate;
    const slide = createSlide();
    place(items, [0, 30, 60]);
    slide.settle(items);
    place(items, [30, 0, 60]);
    slide.settle(items);
    expect(animate).not.toHaveBeenCalled();
  });
});
