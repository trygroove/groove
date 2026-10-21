import { describe, expect, it } from "vitest";
import { memoryStorage } from "../../testing/storage";
import { clearProjectOpened, markProjectOpened } from "./deviceProjectRecord";

describe("markProjectOpened", () => {
  it("reports the first open as true and every later one as false", () => {
    const storage = memoryStorage();

    expect(markProjectOpened("prj_a", storage)).toBe(true);
    expect(markProjectOpened("prj_a", storage)).toBe(false);
    expect(markProjectOpened("prj_a", storage)).toBe(false);
  });

  it("tracks each project id independently", () => {
    const storage = memoryStorage();

    expect(markProjectOpened("prj_a", storage)).toBe(true);
    expect(markProjectOpened("prj_b", storage)).toBe(true);
    expect(markProjectOpened("prj_a", storage)).toBe(false);
    expect(markProjectOpened("prj_b", storage)).toBe(false);
  });

  it("fails open (reports first open) when storage is unavailable", () => {
    expect(markProjectOpened("prj_a", null)).toBe(true);
    expect(markProjectOpened("prj_a", null)).toBe(true);
  });

  it("fails open when storage throws", () => {
    const hostile: Storage = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
      removeItem: () => {
        throw new Error("nope");
      },
      clear: () => {
        throw new Error("nope");
      },
      key: () => {
        throw new Error("nope");
      },
      length: 0,
    };
    expect(markProjectOpened("prj_a", hostile)).toBe(true);
  });

  it("clearProjectOpened lets a later open report as first again", () => {
    const storage = memoryStorage();

    expect(markProjectOpened("prj_a", storage)).toBe(true);
    expect(markProjectOpened("prj_a", storage)).toBe(false);

    clearProjectOpened("prj_a", storage);

    expect(markProjectOpened("prj_a", storage)).toBe(true);
  });

  it("clearProjectOpened on an unavailable store does not throw", () => {
    expect(() => clearProjectOpened("prj_a", null)).not.toThrow();
  });
});
