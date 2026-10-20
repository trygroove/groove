import { describe, expect, it } from "vitest";
import { combineRevisions, revisionOf } from "./revision";

describe("revisionOf", () => {
  it("returns the same number for the same object reference every time", () => {
    const entity = { name: "track" };
    const first = revisionOf(entity);
    expect(revisionOf(entity)).toBe(first);
    expect(revisionOf(entity)).toBe(first);
  });

  it("returns a different number for a structurally identical but distinct object", () => {
    const a = { name: "track" };
    const b = { name: "track" };
    expect(revisionOf(a)).not.toBe(revisionOf(b));
  });

  it("only changes for the entity that actually changed (immutable-update pattern)", () => {
    const trackA = { name: "A" };
    const trackB = { name: "B" };
    const beforeA = revisionOf(trackA);
    const beforeB = revisionOf(trackB);

    // Simulates `produce`: a new object for the changed entity, the
    // untouched sibling keeps its reference.
    const trackAChanged = { ...trackA, name: "A2" };

    expect(revisionOf(trackAChanged)).not.toBe(beforeA);
    expect(revisionOf(trackB)).toBe(beforeB);
  });
});

describe("combineRevisions", () => {
  it("is deterministic for the same inputs", () => {
    expect(combineRevisions(1, 2, 3)).toBe(combineRevisions(1, 2, 3));
  });

  it("is sensitive to input order", () => {
    expect(combineRevisions(1, 2)).not.toBe(combineRevisions(2, 1));
  });

  it("changes when any one input changes", () => {
    const base = combineRevisions(10, 20, 30);
    expect(combineRevisions(11, 20, 30)).not.toBe(base);
    expect(combineRevisions(10, 21, 30)).not.toBe(base);
    expect(combineRevisions(10, 20, 31)).not.toBe(base);
  });
});
